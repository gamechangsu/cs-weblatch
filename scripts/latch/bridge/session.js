"use strict";

const fsp = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");
const { spawn } = require("node:child_process");

const DEFAULT_URL = process.env.LATCH_URL || "http://127.0.0.1:8765";
const DEFAULT_TOKEN = process.env.LATCH_TOKEN || "";
const DATA_DIR = path.resolve(process.env.LATCH_DATA_DIR || path.join(__dirname, "..", ".latch"));
const SESSIONS_FILE = path.join(DATA_DIR, "sessions.json");
const PROMPT_DIR = path.join(DATA_DIR, "session-prompts");

const args = process.argv.slice(2);
const first = args[0] || "";
const command = first.startsWith("-") ? "" : first;
const rest = command ? args.slice(1) : args;

const opts = {
  urlProvided: rest.includes("--url"),
  baseUrl: valueAfter("--url") || DEFAULT_URL,
  token: valueAfter("--token") || DEFAULT_TOKEN,
  sessionId: valueAfter("--session") || "",
  service: valueAfter("--service") || "",
  status: valueAfter("--status") || "done",
  conversationId: valueAfter("--conversation") || "",
  pageSessionId: valueAfter("--page-session") || "",
  tabId: valueAfter("--tab-id") || "",
  afterId: valueAfter("--after-id") || "",
  targetUrl: valueAfter("--target-url") || "",
  prompt: valueAfter("--prompt") || "",
  promptFile: valueAfter("--prompt-file") || "",
  timeoutMs: Number(valueAfter("--timeout") || 10 * 60 * 1000),
  json: rest.includes("--json"),
  text: rest.includes("--text"),
  watchLost: !rest.includes("--no-watch-lost"),
  help: rest.includes("--help") || rest.includes("-h") || !command
};

if (opts.help) {
  console.log(`Usage: node bridge/session.js <command> [options]

Commands:
  start              Create a durable wait session around a prompt send.
  poll               Wait for a session's matching completion event.
  show               Show one session.
  list               List sessions.

Start options:
  --service <name>        chatgpt, gemini, gemini_canvas, claude, or aistudio.
  --after-id <id>         Event id before prompt send. Defaults to /health latestId.
  --prompt <text>         Prompt text to match.
  --prompt-file <path>    UTF-8 prompt file to match.
  --conversation <id>     Restrict to a service conversation/chat id.
  --page-session <id>     Restrict to a Latch page session id.
  --tab-id <id>           Restrict to a Chrome tab id.
  --target-url <url>      URL to reopen when watch-lost is detected.
  --no-watch-lost         Disable target tab movement detection.

Poll options:
  --session <id>          Required session id.
  --timeout <ms>          Wait timeout. Default: 600000
  --json                  Print JSON.
  --text                  Print assistant text only.

Common:
  --url <url>             Bridge URL. Default: ${DEFAULT_URL}
  --token <token>         Optional bridge token.
`);
  process.exit(command ? 0 : 1);
}

function valueAfter(name) {
  const index = rest.indexOf(name);
  return index >= 0 ? rest[index + 1] : "";
}

function requestOptions() {
  return opts.token ? { headers: { "x-latch-token": opts.token } } : {};
}

function requestJson(pathname) {
  return new Promise((resolve, reject) => {
    const req = http.get(new URL(pathname, opts.baseUrl), requestOptions(), res => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", chunk => {
        body += chunk;
      });
      res.on("end", () => {
        if (res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode}: ${body}`));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on("error", reject);
  });
}

async function loadStore() {
  try {
    const raw = await fsp.readFile(SESSIONS_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.sessions)) return parsed;
  } catch {
    // Missing or corrupt session files start from an empty store.
  }
  return { version: 1, sessions: [] };
}

async function saveStore(store) {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  const temp = `${SESSIONS_FILE}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(temp, JSON.stringify(store, null, 2), "utf8");
  await fsp.rename(temp, SESSIONS_FILE);
}

function makeSessionId() {
  const time = Date.now().toString(36).padStart(9, "0");
  const random = Math.random().toString(36).slice(2, 15).padEnd(13, "0");
  return `latch_${time}${random}`.slice(0, 26);
}

async function promptText() {
  if (opts.promptFile) return fsp.readFile(opts.promptFile, "utf8").then(value => value.replace(/^\uFEFF/, ""));
  return opts.prompt.replace(/^\uFEFF/, "");
}

async function persistPrompt(sessionId, text) {
  if (!text) return "";
  await fsp.mkdir(PROMPT_DIR, { recursive: true });
  const filePath = path.join(PROMPT_DIR, `${sessionId}.txt`);
  await fsp.writeFile(filePath, text, "utf8");
  return filePath;
}

function findSession(store, sessionId) {
  return store.sessions.find(item => item.sessionId === sessionId);
}

function upsertSession(store, session) {
  const index = store.sessions.findIndex(item => item.sessionId === session.sessionId);
  if (index >= 0) {
    store.sessions[index] = session;
  } else {
    store.sessions.push(session);
  }
}

function buildWaitArgs(session) {
  const baseUrl = opts.urlProvided ? opts.baseUrl : (session.baseUrl || opts.baseUrl || DEFAULT_URL);
  const waitArgs = ["--url", baseUrl, "--status", session.filters.status || "done", "--json"];
  const filterMap = [
    ["--service", session.filters.service],
    ["--conversation", session.filters.conversationId],
    ["--page-session", session.filters.pageSessionId],
    ["--tab-id", session.filters.tabId],
    ["--after-id", session.filters.afterId],
    ["--target-url", session.filters.targetUrl],
    ["--prompt-file", session.filters.promptFile],
    ["--timeout", String(opts.timeoutMs)]
  ];
  for (const [name, value] of filterMap) {
    if (value !== "" && value != null) waitArgs.push(name, String(value));
  }
  if (opts.token) waitArgs.push("--token", opts.token);
  if (session.filters.watchLost) waitArgs.push("--watch-lost");
  return waitArgs;
}

function runWait(waitArgs) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, "wait-latest.js"), ...waitArgs], {
      env: {
        ...process.env,
        LATCH_JSON_ERRORS: "1"
      },
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
        const error = new Error(stderr.trim() || stdout.trim() || `wait-latest exited ${code}`);
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function errorEnvelope(error, stage, retryHint = "inspect-session") {
  const message = error && error.message ? error.message : String(error);
  let parsed = null;
  for (const text of [error && error.stderr, error && error.stdout, message]) {
    if (!text) continue;
    try {
      parsed = JSON.parse(String(text).trim());
      break;
    } catch {
      // Keep looking for a structured wait-latest error.
    }
  }
  if (parsed && parsed.ok === false) return parsed;

  const code = /session/i.test(message)
    ? "latch.session-invalid"
    : /ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|socket hang up/i.test(message)
      ? "latch.bridge-unreachable"
      : "latch.session-failed";
  return {
    ok: false,
    status: "error",
    error: {
      name: error && error.name ? error.name : "Error",
      errorCode: code,
      stage,
      message,
      retryHint,
      evidence: { sessionId: opts.sessionId, url: opts.baseUrl }
    }
  };
}

function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}

function printSessionHuman(session) {
  console.log(`Session: ${session.sessionId}`);
  console.log(`Status: ${session.status}`);
  console.log(`Service: ${session.filters.service || "-"}`);
  console.log(`After id: ${session.filters.afterId || "-"}`);
  console.log(`Conversation: ${session.filters.conversationId || "-"}`);
  console.log(`Tab id: ${session.filters.tabId || "-"}`);
  if (session.latestEvent && session.latestEvent.url) console.log(`URL: ${session.latestEvent.url}`);
}

async function startSession() {
  const store = await loadStore();
  const sessionId = makeSessionId();
  let afterId = opts.afterId;
  if (!afterId) {
    const health = await requestJson("/health");
    afterId = String(health.latestId || 0);
  }

  const text = await promptText();
  const promptFile = await persistPrompt(sessionId, text);
  const now = new Date().toISOString();
  const session = {
    sessionId,
    status: "pending",
    createdAt: now,
    updatedAt: now,
    baseUrl: opts.baseUrl,
    filters: {
      service: opts.service,
      status: opts.status,
      conversationId: opts.conversationId,
      pageSessionId: opts.pageSessionId,
      tabId: opts.tabId,
      afterId,
      targetUrl: opts.targetUrl,
      promptFile,
      hasPrompt: Boolean(text),
      watchLost: opts.watchLost
    },
    latestEvent: null
  };
  upsertSession(store, session);
  await saveStore(store);

  const result = {
    ok: true,
    status: "started",
    sessionId,
    filters: session.filters,
    pollCommand: `npm run session -- poll --session ${sessionId} --json`
  };
  if (opts.json) {
    printJson(result);
  } else {
    printSessionHuman(session);
    console.log(result.pollCommand);
  }
}

async function pollSession() {
  if (!opts.sessionId) throw new Error("--session is required");
  const store = await loadStore();
  const session = findSession(store, opts.sessionId);
  if (!session) throw new Error(`Unknown session: ${opts.sessionId}`);

  const waitArgs = buildWaitArgs(session);
  const { stdout } = await runWait(waitArgs);
  const event = JSON.parse(stdout);
  session.status = event.status || "done";
  session.updatedAt = new Date().toISOString();
  session.latestEvent = event;
  if (event.status === "done") session.completedAt = session.updatedAt;
  upsertSession(store, session);
  await saveStore(store);

  const result = {
    ok: event.status !== "error",
    status: event.status || "done",
    sessionId: session.sessionId,
    event,
    assistantText: event.assistantText || "",
    conversationUrl: event.url || ""
  };

  if (opts.text) {
    console.log(result.assistantText);
  } else if (opts.json) {
    printJson(result);
  } else {
    printSessionHuman(session);
    if (result.assistantText) console.log(`\n${result.assistantText}`);
  }
}

async function showSession() {
  if (!opts.sessionId) throw new Error("--session is required");
  const store = await loadStore();
  const session = findSession(store, opts.sessionId);
  if (!session) throw new Error(`Unknown session: ${opts.sessionId}`);
  if (opts.json) {
    printJson({ ok: true, session });
  } else {
    printSessionHuman(session);
  }
}

async function listSessions() {
  const store = await loadStore();
  const sessions = store.sessions.slice().sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  if (opts.json) {
    printJson({ ok: true, sessions });
    return;
  }
  for (const session of sessions) {
    console.log(`${session.sessionId} ${session.status} ${session.filters.service || "-"} ${session.updatedAt}`);
  }
}

(async () => {
  if (command === "start") return startSession();
  if (command === "poll") return pollSession();
  if (command === "show") return showSession();
  if (command === "list") return listSessions();
  throw new Error(`Unknown command: ${command}`);
})().catch(async error => {
  const result = errorEnvelope(error, command || "session");
  if (opts.sessionId) {
    const store = await loadStore().catch(() => null);
    const session = store && findSession(store, opts.sessionId);
    if (store && session) {
      session.status = "error";
      session.updatedAt = new Date().toISOString();
      session.error = result.error;
      upsertSession(store, session);
      await saveStore(store).catch(() => {});
    }
  }
  if (opts.json) {
    console.error(JSON.stringify(result, null, 2));
  } else {
    console.error(`${result.error.errorCode}: ${result.error.message}`);
  }
  process.exit(1);
});
