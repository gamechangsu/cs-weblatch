"use strict";

const fs = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const PORT = 18765;
const BASE_URL = `http://127.0.0.1:${PORT}`;

function requestJson(method, pathname, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : "";
    const req = http.request(new URL(pathname, BASE_URL), {
      method,
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(payload)
      }
    }, res => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", chunk => {
        data += chunk;
      });
      res.on("end", () => {
        if (res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode}: ${data}`));
          return;
        }
        try {
          resolve(JSON.parse(data));
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on("error", reject);
    req.end(payload);
  });
}

function stableHash(value) {
  let hash = 2166136261;
  const text = JSON.stringify(value || {});
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function runWait(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, "wait-latest.js"), ...args], {
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", chunk => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", code => {
      if (code !== 0) {
        reject(new Error(`wait-latest exited ${code}: ${stderr || stdout}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function waitForHealth(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return await requestJson("GET", "/health");
    } catch {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  throw new Error("Bridge did not become healthy");
}

(async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "latch-"));
  const child = spawn(process.execPath, [path.join(__dirname, "server.js")], {
    env: {
      ...process.env,
      LATCH_PORT: String(PORT),
      LATCH_DATA_DIR: tempDir
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  let output = "";
  child.stdout.on("data", chunk => {
    output += chunk.toString();
  });
  child.stderr.on("data", chunk => {
    output += chunk.toString();
  });

  try {
    const health = await waitForHealth(5000);
    if (!health.ok) throw new Error("Health check did not return ok");

    const posted = await requestJson("POST", "/events", {
      service: "chatgpt",
      status: "done",
      url: "https://chatgpt.com/c/smoke",
      title: "ChatGPT",
      conversationId: "smoke",
      userText: "ping",
      assistantText: "pong",
      modelLabel: "Pro extended",
      signals: { assistantActionVisible: true, stableMs: 2000 }
    });
    if (!posted.ok || !posted.event || posted.event.assistantText !== "pong") {
      throw new Error("Posted event was not stored correctly");
    }

    const latest = await requestJson("GET", "/latest");
    if (latest.assistantText !== "pong") {
      throw new Error("Latest event mismatch");
    }

    await requestJson("POST", "/events", {
      service: "chatgpt",
      status: "done",
      url: "https://chatgpt.com/c/noise",
      conversationId: "noise",
      userText: "different prompt",
      assistantText: "noise"
    });

    const filtered = await requestJson("GET", `/latest?afterId=0&status=done&userTextHash=${stableHash("ping")}`);
    if (filtered.conversationId !== "smoke" || filtered.assistantText !== "pong") {
      throw new Error("Filtered latest event mismatch");
    }

    const serviceCases = [
      { service: "gemini", url: "https://gemini.google.com/app/smoke", assistantText: "gemini pong" },
      { service: "gemini_canvas", url: "https://gemini.google.com/app/smoke?canvas=1", assistantText: "canvas pong" },
      { service: "claude", url: "https://claude.ai/chat/smoke", assistantText: "claude pong" },
      { service: "aistudio", url: "https://aistudio.google.com/prompts/smoke", assistantText: "aistudio pong" }
    ];

    for (const item of serviceCases) {
      await requestJson("POST", "/events", {
        service: item.service,
        status: "done",
        url: item.url,
        conversationId: "smoke",
        userText: "ping",
        assistantText: item.assistantText
      });

      const serviceFiltered = await requestJson("GET", `/latest?service=${item.service}&status=done&userTextHash=${stableHash("ping")}`);
      if (serviceFiltered.service !== item.service || serviceFiltered.assistantText !== item.assistantText) {
        throw new Error(`${item.service} service-filtered latest event mismatch`);
      }
    }

    await requestJson("POST", "/events", {
      service: "claude",
      status: "idle",
      url: "https://claude.ai/chat/other",
      conversationId: "other",
      tabId: 777
    });

    const serviceScopedWatch = await runWait([
      "--url", BASE_URL,
      "--service", "chatgpt",
      "--after-id", "0",
      "--conversation", "target",
      "--tab-id", "777",
      "--watch-lost",
      "--json",
      "--once"
    ]);
    const serviceScopedWatchEvent = JSON.parse(serviceScopedWatch.stdout);
    if (serviceScopedWatchEvent.status === "watch_lost") {
      throw new Error("Service-scoped watch-lost matched another service");
    }

    await requestJson("POST", "/events", {
      service: "chatgpt",
      status: "idle",
      url: "https://chatgpt.com/c/other",
      conversationId: "other",
      tabId: 123
    });

    const watchLost = await runWait([
      "--url", BASE_URL,
      "--after-id", "0",
      "--conversation", "target",
      "--tab-id", "123",
      "--watch-lost",
      "--json",
      "--once"
    ]);
    const watchLostEvent = JSON.parse(watchLost.stdout);
    if (watchLostEvent.status !== "watch_lost" || watchLostEvent.reason !== "target_tab_left_conversation") {
      throw new Error("Watch-lost detection mismatch");
    }

    await requestJson("POST", "/events", {
      service: "chatgpt",
      status: "streaming",
      url: "https://chatgpt.com/c/target",
      conversationId: "target",
      tabId: 123,
      userText: "target prompt",
      assistantText: "partial"
    });

    const recoveredWatch = await runWait([
      "--url", BASE_URL,
      "--after-id", "0",
      "--conversation", "target",
      "--tab-id", "123",
      "--watch-lost",
      "--json",
      "--once"
    ]);
    const recoveredEvent = JSON.parse(recoveredWatch.stdout);
    if (recoveredEvent.status === "watch_lost") {
      throw new Error("Stale watch-lost event was returned after recovery");
    }

    console.log("Smoke test passed");
  } catch (error) {
    console.error(output);
    throw error;
  } finally {
    child.kill();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
