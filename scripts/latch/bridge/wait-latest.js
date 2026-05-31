"use strict";

const fs = require("node:fs");
const http = require("node:http");

const DEFAULT_URL = process.env.LATCH_URL || "http://127.0.0.1:8765";
const DEFAULT_TOKEN = process.env.LATCH_TOKEN || "";

const args = process.argv.slice(2);
const opts = {
  baseUrl: valueAfter("--url") || DEFAULT_URL,
  token: valueAfter("--token") || DEFAULT_TOKEN,
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
  json: args.includes("--json"),
  jsonErrors: args.includes("--json") || process.env.LATCH_JSON_ERRORS === "1",
  once: args.includes("--once"),
  text: args.includes("--text"),
  watchLost: args.includes("--watch-lost"),
  help: args.includes("--help") || args.includes("-h")
};

if (opts.help) {
  console.log(`Usage: node bridge/wait-latest.js [options]

Options:
  --url <url>             Bridge URL. Default: ${DEFAULT_URL}
  --token <token>         Optional bridge token.
  --service <name>        Restrict to one service: chatgpt, gemini, gemini_canvas, claude, or aistudio.
  --status <status>       Status to wait for. Default: done
  --conversation <id>     Restrict to one service conversation/chat id.
  --page-session <id>     Restrict to one Latch page session id.
  --tab-id <id>           Restrict to one Chrome tab id.
  --after-id <id>         Only match events after this bridge event id.
  --target-url <url>      URL to reopen when --watch-lost detects target tab movement.
  --prompt <text>         Only match events whose latest user prompt equals this text.
  --prompt-file <path>    Like --prompt, but reads the exact prompt from a UTF-8 file.
  --watch-lost            Return watch_lost if the target tab leaves the target conversation.
  --timeout <ms>          Wait timeout. Default: 600000
  --once                  Print current latest event without waiting.
  --json                  Print full JSON event.
  --text                  Print assistant text only.
  -h, --help              Show this help.
`);
  process.exit(0);
}

function valueAfter(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : "";
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

function promptText() {
  if (opts.promptFile) return fs.readFileSync(opts.promptFile, "utf8").replace(/^\uFEFF/, "");
  return opts.prompt.replace(/^\uFEFF/, "");
}

function withoutOneFinalNewline(value) {
  return String(value).replace(/\r?\n$/, "");
}

function promptHashCandidates() {
  const prompt = promptText();
  if (!prompt) return [];

  const prompts = [prompt];
  const withoutFinalNewline = withoutOneFinalNewline(prompt);
  if (withoutFinalNewline !== prompt) prompts.push(withoutFinalNewline);

  return Array.from(new Set(prompts.map(stableHash)));
}

function compactPrompt(value) {
  return String(value || "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function promptMatchesEvent(event) {
  const prompt = promptText();
  if (!prompt) return true;

  const hashes = promptHashCandidates();
  if (hashes.includes(event.userTextHash)) return true;

  const eventText = compactPrompt(event.userText);
  const promptTextValue = compactPrompt(prompt);
  return Boolean(eventText && promptTextValue && eventText.includes(promptTextValue));
}

function filterValues(options = {}) {
  if (options.watchScope) {
    return {
      service: opts.service,
      tabId: opts.tabId,
      afterId: opts.afterId
    };
  }

  const hashes = promptHashCandidates();
  const includePromptHash = options.includePromptHash === true && hashes.length === 1;
  return {
    service: opts.service,
    status: opts.status,
    conversationId: opts.conversationId,
    pageSessionId: opts.pageSessionId,
    tabId: opts.tabId,
    afterId: opts.afterId,
    userTextHash: includePromptHash ? hashes[0] : ""
  };
}

function addFilters(url, values) {
  for (const [key, value] of Object.entries(values)) {
    if (value !== "" && value != null && !url.searchParams.has(key)) {
      url.searchParams.set(key, value);
    }
  }
}

function requestJson(pathname, filterOptions = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(pathname, opts.baseUrl);
    addFilters(url, filterValues(filterOptions));
    const req = http.get(url, requestOptions(), res => {
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

function requestOptions() {
  return opts.token ? { headers: { "x-latch-token": opts.token } } : {};
}

function isAfterTarget(event) {
  if (!event || event.event === null) return false;
  if (opts.afterId && Number(event.id) <= Number(opts.afterId)) return false;
  return true;
}

function matches(event) {
  if (!event || event.event === null) return false;
  const filters = filterValues({ includePromptHash: false });
  const userTextHashes = promptHashCandidates();
  if (filters.status && event.status !== filters.status) return false;
  if (filters.service && event.service !== filters.service) return false;
  if (filters.conversationId && event.conversationId !== filters.conversationId) return false;
  if (filters.pageSessionId && event.pageSessionId !== filters.pageSessionId) return false;
  if (filters.tabId && Number(event.tabId) !== Number(filters.tabId)) return false;
  if (filters.afterId && Number(event.id) <= Number(filters.afterId)) return false;
  if (userTextHashes.length && !promptMatchesEvent(event)) return false;
  return true;
}

function isWatchLost(event) {
  if (!opts.watchLost || !opts.conversationId || !opts.tabId) return false;
  if (!isAfterTarget(event)) return false;
  if (opts.service && event.service !== opts.service) return false;
  if (Number(event.tabId) !== Number(opts.tabId)) return false;
  return event.conversationId !== opts.conversationId;
}

function watchLostEvent(event) {
  if (!isWatchLost(event)) return null;
  return {
    kind: "latch-watch-lost",
    status: "watch_lost",
    reason: "target_tab_left_conversation",
    target: {
      service: opts.service || event.service || "",
      conversationId: opts.conversationId,
      tabId: Number(opts.tabId),
      afterId: opts.afterId ? Number(opts.afterId) : null,
      url: opts.targetUrl || conversationUrl(opts.service || event.service || "chatgpt", opts.conversationId)
    },
    observedEvent: event
  };
}

function conversationUrl(service, conversationId) {
  if (service === "chatgpt" && conversationId) return `https://chatgpt.com/c/${conversationId}`;
  if (service === "claude" && conversationId) return `https://claude.ai/chat/${conversationId}`;
  if (service === "gemini_canvas" && conversationId) return `https://gemini.google.com/app/${conversationId}`;
  if (service === "gemini" && conversationId) return `https://gemini.google.com/app/${conversationId}`;
  if (service === "aistudio" && conversationId) return `https://aistudio.google.com/prompts/${conversationId}`;
  if (service === "claude") return "https://claude.ai/";
  if (service === "gemini_canvas") return "https://gemini.google.com/";
  if (service === "gemini") return "https://gemini.google.com/";
  if (service === "aistudio") return "https://aistudio.google.com/";
  return "https://chatgpt.com/";
}

function latestMatchingEvent(events) {
  if (!Array.isArray(events)) return null;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (matches(events[index])) return events[index];
  }
  return null;
}

function currentWatchLostEvent(events) {
  if (!Array.isArray(events)) return null;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!isAfterTarget(event)) continue;
    if (opts.service && event.service !== opts.service) continue;
    if (!opts.tabId || Number(event.tabId) !== Number(opts.tabId)) continue;
    return watchLostEvent(event);
  }
  return null;
}

function printEvent(event) {
  if (!event || event.event === null) {
    console.log(opts.json ? "{}" : "");
    return;
  }

  if (event.status === "watch_lost") {
    if (opts.json) {
      console.log(JSON.stringify(event, null, 2));
      return;
    }

    const observed = event.observedEvent || {};
    console.log([
      "Watch lost: target tab left the target conversation.",
      `Target: ${event.target.url}`,
      `Observed: ${observed.url || observed.conversationId || ""}`
    ].join("\n"));
    return;
  }

  if (opts.text) {
    console.log(event.assistantText || "");
    return;
  }

  if (opts.json) {
    console.log(JSON.stringify(event, null, 2));
    return;
  }

  const chunks = [];
  if (event.url) chunks.push(`URL: ${event.url}`);
  if (event.modelLabel) chunks.push(`Model: ${event.modelLabel}`);
  if (event.thinkingLabel) chunks.push(`Thinking: ${event.thinkingLabel}`);
  if (event.userText) chunks.push(`Prompt:\n${event.userText}`);
  chunks.push(`Response:\n${event.assistantText || ""}`);
  console.log(chunks.join("\n\n"));
}

function waitForStream() {
  return new Promise((resolve, reject) => {
    const url = new URL("/stream", opts.baseUrl);
    addFilters(url, filterValues(opts.watchLost ? { watchScope: true } : {}));
    if (opts.token) url.searchParams.set("token", opts.token);

    const req = http.get(url, requestOptions(), res => {
      if (res.statusCode >= 400) {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", chunk => {
          body += chunk;
        });
        res.on("end", () => reject(new Error(`HTTP ${res.statusCode}: ${body}`)));
        return;
      }

      res.setEncoding("utf8");
      let buffer = "";

      res.on("data", chunk => {
        buffer += chunk;
        let splitAt;
        while ((splitAt = buffer.indexOf("\n\n")) >= 0) {
          const packet = buffer.slice(0, splitAt);
          buffer = buffer.slice(splitAt + 2);
          const dataLine = packet.split(/\r?\n/).find(line => line.startsWith("data: "));
          if (!dataLine) continue;
          let event;
          try {
            event = JSON.parse(dataLine.slice(6));
          } catch {
            continue;
          }
          if (matches(event)) {
            resolve(event);
            req.destroy();
            return;
          }

          const lost = watchLostEvent(event);
          if (lost) {
            resolve(lost);
            req.destroy();
            return;
          }
        }
      });
    });

    req.on("error", reject);

    const timer = setTimeout(() => {
      req.destroy();
      reject(new Error(`Timed out after ${opts.timeoutMs}ms waiting for status "${opts.status}"`));
    }, opts.timeoutMs);

    req.on("close", () => clearTimeout(timer));
  });
}

(async () => {
  const latest = await requestJson("/latest").catch(() => null);
  const recent = await requestJson(
    "/events?limit=200",
    opts.watchLost ? { watchScope: true } : {}
  ).catch(() => []);
  const recentMatch = latestMatchingEvent(recent);
  const recentWatchLost = currentWatchLostEvent(recent);
  if (opts.once) {
    printEvent(recentMatch || recentWatchLost || latest || {});
    return;
  }

  if (matches(latest) || recentMatch) {
    printEvent(matches(latest) ? latest : recentMatch);
    return;
  }

  if (recentWatchLost) {
    printEvent(recentWatchLost);
    return;
  }

  const event = await waitForStream();
  printEvent(event);
})().catch(error => {
  if (opts.jsonErrors) {
    console.error(JSON.stringify(errorEnvelope(error), null, 2));
  } else {
    console.error(error && error.message ? error.message : String(error));
  }
  process.exit(1);
});

function errorEnvelope(error) {
  const message = error && error.message ? error.message : String(error);
  let errorCode = "latch.wait-failed";
  let retryHint = "inspect-bridge";
  if (/Timed out after/i.test(message)) {
    errorCode = "latch.poll-timeout";
    retryHint = "increase-timeout-or-check-service-tab";
  } else if (/ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|socket hang up/i.test(message)) {
    errorCode = "latch.bridge-unreachable";
    retryHint = "start-bridge";
  } else if (/ENOENT|no such file/i.test(message)) {
    errorCode = "latch.prompt-file";
    retryHint = "check-prompt-file";
  } else if (/^HTTP \d+:/i.test(message)) {
    errorCode = "latch.bridge-http";
    retryHint = "inspect-bridge-response";
  } else if (/Unexpected token|JSON/i.test(message)) {
    errorCode = "latch.invalid-json";
    retryHint = "inspect-bridge-response";
  }

  return {
    ok: false,
    status: "error",
    error: {
      name: error && error.name ? error.name : "Error",
      errorCode,
      stage: "wait",
      message,
      retryHint,
      evidence: {
        url: opts.baseUrl,
        service: opts.service,
        conversationId: opts.conversationId,
        tabId: opts.tabId || null,
        afterId: opts.afterId || null
      }
    }
  };
}
