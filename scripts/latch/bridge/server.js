"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");
const { URL } = require("node:url");

const HOST = process.env.LATCH_HOST || "127.0.0.1";
const PORT = Number(process.env.LATCH_PORT || 8765);
const DATA_DIR = path.resolve(process.env.LATCH_DATA_DIR || path.join(__dirname, "..", ".latch"));
const EVENTS_FILE = path.join(DATA_DIR, "events.jsonl");
const LATEST_FILE = path.join(DATA_DIR, "latest.json");
const MAX_EVENTS = Number(process.env.LATCH_MAX_EVENTS || 500);
const BODY_LIMIT = Number(process.env.LATCH_BODY_LIMIT || 5 * 1024 * 1024);
const MAX_TEXT = Number(process.env.LATCH_MAX_TEXT || 250000);
const DEDUPE_MS = Number(process.env.LATCH_DEDUPE_MS || 1500);
const TOKEN = process.env.LATCH_TOKEN || "";
const REQUIRE_READ_TOKEN = process.env.LATCH_REQUIRE_TOKEN_FOR_READS === "1";
const EXTRA_ORIGINS = (process.env.LATCH_ALLOWED_ORIGINS || "")
  .split(",")
  .map(item => item.trim())
  .filter(Boolean);

const VALID_STATUSES = new Set(["idle", "draft", "thinking", "streaming", "done", "error", "unknown"]);

let nextId = 1;
let events = [];
let latest = null;
const latestByConversation = new Map();
const streams = new Set();
const startedAt = Date.now();

function isAllowedOrigin(origin) {
  if (!origin) return true;
  if (origin.startsWith("chrome-extension://")) return true;
  if (origin === `http://${HOST}:${PORT}`) return true;
  if (origin === `http://127.0.0.1:${PORT}`) return true;
  if (origin === `http://localhost:${PORT}`) return true;
  return EXTRA_ORIGINS.includes(origin);
}

function corsHeaders(req) {
  const origin = req.headers.origin;
  const allowOrigin = isAllowedOrigin(origin) && origin ? origin : "null";
  return {
    "access-control-allow-origin": allowOrigin,
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type,x-latch-token,authorization",
    "access-control-max-age": "86400",
    vary: "Origin"
  };
}

function sendJson(req, res, statusCode, value) {
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    ...corsHeaders(req)
  });
  res.end(JSON.stringify(value, null, 2));
}

function sendText(req, res, statusCode, value) {
  res.writeHead(statusCode, {
    "content-type": "text/plain; charset=utf-8",
    ...corsHeaders(req)
  });
  res.end(value);
}

function sendHtml(req, res, statusCode, value) {
  res.writeHead(statusCode, {
    "content-type": "text/html; charset=utf-8",
    ...corsHeaders(req)
  });
  res.end(value);
}

function trimText(value) {
  if (typeof value !== "string") return "";
  return value.length > MAX_TEXT ? value.slice(0, MAX_TEXT) : value;
}

function conversationIdFromUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const service = serviceFromUrl(rawUrl);
    const patterns = {
      chatgpt: /\/c\/([^/]+)/,
      gemini_canvas: /\/(?:app|chat|canvas)\/([^/?#]+)/,
      gemini: /\/(?:app|chat)\/([^/?#]+)/,
      claude: /\/chat\/([^/?#]+)/,
      aistudio: /\/(?:app\/)?(?:prompts|chats|chat)\/([^/?#]+)/
    };
    const pattern = patterns[service] || /\/c\/([^/]+)/;
    const match = url.pathname.match(pattern);
    return match ? match[1] : "";
  } catch {
    return "";
  }
}

function serviceFromUrl(rawUrl) {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    if (host === "chatgpt.com" || host === "chat.openai.com") return "chatgpt";
    if (host === "gemini.google.com") {
      const url = new URL(rawUrl);
      return /canvas/i.test(`${url.pathname} ${url.search} ${url.hash}`) ? "gemini_canvas" : "gemini";
    }
    if (host === "claude.ai" || host.endsWith(".claude.ai")) return "claude";
    if (host === "aistudio.google.com") return "aistudio";
    return "unknown";
  } catch {
    return "unknown";
  }
}

function conversationKey(service, conversationId) {
  return `${service || "unknown"}:${conversationId || ""}`;
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

function eventTextHash(value) {
  return stableHash(String(value || ""));
}

function normalizeStatus(value) {
  const status = String(value || "unknown").toLowerCase();
  return VALID_STATUSES.has(status) ? status : "unknown";
}

function normalizeEvent(payload) {
  const now = new Date().toISOString();
  const rawUrl = String(payload.url || "");
  const service = String(payload.service || serviceFromUrl(rawUrl) || "unknown");
  const event = {
    id: nextId++,
    receivedAt: now,
    source: "latch-extension",
    kind: String(payload.kind || "latch-state"),
    service,
    serviceLabel: String(payload.serviceLabel || service),
    status: normalizeStatus(payload.status),
    url: rawUrl,
    title: String(payload.title || ""),
    conversationId: String(payload.conversationId || conversationIdFromUrl(rawUrl)),
    pageSessionId: String(payload.pageSessionId || ""),
    tabId: payload.tabId == null ? null : payload.tabId,
    windowId: payload.windowId == null ? null : payload.windowId,
    sequence: Number.isFinite(Number(payload.sequence)) ? Number(payload.sequence) : null,
    observedAt: String(payload.observedAt || now),
    userText: trimText(payload.userText || ""),
    assistantText: trimText(payload.assistantText || ""),
    thinkingLabel: String(payload.thinkingLabel || ""),
    errorText: String(payload.errorText || ""),
    modelLabel: String(payload.modelLabel || ""),
    artifactLinks: normalizeArtifactLinks(payload.artifactLinks),
    signals: payload.signals && typeof payload.signals === "object" ? payload.signals : {}
  };

  event.userTextHash = eventTextHash(event.userText);
  event.assistantTextHash = eventTextHash(event.assistantText);

  if (event.status === "streaming" || event.status === "thinking") {
    const signals = event.signals || {};
    const hasCompletionEvidence = Boolean(event.assistantText)
      && (Boolean(event.thinkingLabel) || signals.assistantActionVisible === true);
    const noLiveStopEvidence = signals.stopVisible !== true;
    if (hasCompletionEvidence && noLiveStopEvidence) {
      event.status = "done";
    }
  }

  event.fingerprint = String(payload.fingerprint || stableHash({
    service: event.service,
    status: event.status,
    url: event.url,
    conversationId: event.conversationId,
    userText: event.userText,
    assistantText: event.assistantText,
    artifactLinks: event.artifactLinks,
    thinkingLabel: event.thinkingLabel,
    errorText: event.errorText,
    modelLabel: event.modelLabel
  }));

  return event;
}

function normalizeArtifactLinks(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map(item => ({
      label: trimText(String(item && item.label || "")),
      href: trimText(String(item && item.href || ""))
    }))
    .filter(item => item.href)
    .slice(0, 20);
}

function shouldStore(event) {
  if (!latest) return true;
  if (event.fingerprint !== latest.fingerprint) return true;
  const previous = Date.parse(latest.receivedAt) || 0;
  return Date.now() - previous > DEDUPE_MS;
}

async function writeJsonAtomic(filePath, value) {
  const temp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(temp, JSON.stringify(value, null, 2), "utf8");
  await fsp.rename(temp, filePath);
}

async function persistEvent(event) {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  await fsp.appendFile(EVENTS_FILE, `${JSON.stringify(event)}\n`, "utf8");
  await writeJsonAtomic(LATEST_FILE, event);
}

function rememberEvent(event) {
  if (!event.userTextHash) event.userTextHash = eventTextHash(event.userText);
  if (!event.assistantTextHash) event.assistantTextHash = eventTextHash(event.assistantText);
  latest = event;
  if (event.conversationId) latestByConversation.set(conversationKey(event.service, event.conversationId), event);
  events.push(event);
  if (events.length > MAX_EVENTS) events = events.slice(-MAX_EVENTS);
}

async function storeEvent(payload) {
  const event = normalizeEvent(payload);
  if (!shouldStore(event)) {
    return { event: latest, duplicate: true };
  }

  rememberEvent(event);
  await persistEvent(event);
  broadcast(event);
  logEvent(event);
  return { event, duplicate: false };
}

function logEvent(event) {
  const label = [
    `#${event.id}`,
    event.service || "unknown",
    event.status,
    event.conversationId || "new-chat",
    event.assistantText ? `${event.assistantText.length} chars` : "no text"
  ].join(" ");
  console.log(`[latch] ${label}`);
}

function writeSse(res, eventName, data) {
  res.write(`event: ${eventName}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function broadcast(event) {
  for (const client of streams) {
    if (!eventMatchesQuery(event, client.url)) continue;
    try {
      writeSse(client.res, "latch", event);
      if ((event.service || "chatgpt") === "chatgpt") {
        writeSse(client.res, "chatgpt", event);
      }
      writeSse(client.res, event.service || "unknown", event);
    } catch {
      streams.delete(client);
    }
  }
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let body = "";
    req.setEncoding("utf8");
    req.on("data", chunk => {
      size += Buffer.byteLength(chunk);
      if (size > BODY_LIMIT) {
        reject(new Error(`Request body too large; limit is ${BODY_LIMIT} bytes`));
        req.destroy();
        return;
      }
      body += chunk;
    });
    req.on("end", () => {
      if (!body.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function getLimit(url) {
  const raw = Number(url.searchParams.get("limit") || 20);
  return Number.isFinite(raw) ? Math.max(1, Math.min(MAX_EVENTS, raw)) : 20;
}

function parseOptionalNumber(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function eventMatchesQuery(event, url) {
  const service = url.searchParams.get("service") || "";
  const status = url.searchParams.get("status") || "";
  const conversationId = url.searchParams.get("conversationId") || "";
  const pageSessionId = url.searchParams.get("pageSessionId") || "";
  const userTextHash = url.searchParams.get("userTextHash") || "";
  const assistantTextHash = url.searchParams.get("assistantTextHash") || "";
  const tabId = parseOptionalNumber(url.searchParams.get("tabId"));
  const afterId = parseOptionalNumber(url.searchParams.get("afterId"));

  if (service && event.service !== service) return false;
  if (status && event.status !== status) return false;
  if (conversationId && event.conversationId !== conversationId) return false;
  if (pageSessionId && event.pageSessionId !== pageSessionId) return false;
  if (userTextHash && event.userTextHash !== userTextHash) return false;
  if (assistantTextHash && event.assistantTextHash !== assistantTextHash) return false;
  if (tabId != null && Number(event.tabId) !== tabId) return false;
  if (afterId != null && Number(event.id) <= afterId) return false;
  return true;
}

function eventForUrl(url) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (eventMatchesQuery(events[index], url)) return events[index];
  }
  return null;
}

function filterEvents(url) {
  const limit = getLimit(url);
  return events
    .filter(event => eventMatchesQuery(event, url))
    .slice(-limit);
}

function hasToken(req, url) {
  if (!TOKEN) return true;
  const headerToken = req.headers["x-latch-token"];
  const auth = req.headers.authorization || "";
  const bearer = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7) : "";
  const queryToken = url.searchParams.get("token") || "";
  return [headerToken, bearer, queryToken].includes(TOKEN);
}

function requiresAuth(req, url) {
  if (!TOKEN) return false;
  if (req.method !== "GET") return true;
  if (REQUIRE_READ_TOKEN) return true;
  return url.pathname === "/stream" && Boolean(url.searchParams.get("token"));
}

async function loadState() {
  await fsp.mkdir(DATA_DIR, { recursive: true });

  if (!fs.existsSync(EVENTS_FILE)) return;
  const raw = await fsp.readFile(EVENTS_FILE, "utf8");
  const loaded = raw
    .split(/\r?\n/)
    .filter(Boolean)
    .map(line => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .slice(-MAX_EVENTS);

  events = loaded;
  latestByConversation.clear();
  for (const event of loaded) {
    if (!event.userTextHash) event.userTextHash = eventTextHash(event.userText);
    if (!event.assistantTextHash) event.assistantTextHash = eventTextHash(event.assistantText);
    if (!event.service) event.service = serviceFromUrl(event.url);
    if (!event.serviceLabel) event.serviceLabel = event.service;
    latest = event;
    if (event.conversationId) latestByConversation.set(conversationKey(event.service, event.conversationId), event);
    if (Number.isFinite(event.id) && event.id >= nextId) nextId = event.id + 1;
  }
}

async function clearState() {
  events = [];
  latest = null;
  latestByConversation.clear();
  nextId = 1;
  await fsp.mkdir(DATA_DIR, { recursive: true });
  await fsp.writeFile(EVENTS_FILE, "", "utf8");
  await writeJsonAtomic(LATEST_FILE, null);
}

function dashboardHtml() {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>Latch</title>
    <style>
      :root { color-scheme: light dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      body { margin: 0; background: #f5f7fb; color: #172033; }
      main { max-width: 980px; margin: 0 auto; padding: 28px 18px 48px; }
      header { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 18px; }
      h1 { margin: 0; font-size: 22px; font-weight: 720; letter-spacing: 0; }
      .pill { display: inline-flex; align-items: center; min-height: 26px; padding: 0 10px; border-radius: 999px; background: #e8f0fe; color: #174ea6; font-weight: 650; font-size: 12px; }
      .grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; margin-bottom: 14px; }
      .card, .panel { background: #fff; border: 1px solid #dfe5ef; border-radius: 8px; box-shadow: 0 1px 2px rgba(16,24,40,.04); }
      .card { padding: 12px; min-height: 70px; }
      .label { color: #667085; font-size: 12px; }
      .value { margin-top: 6px; font-size: 18px; font-weight: 720; overflow-wrap: anywhere; }
      .panel { padding: 14px; }
      .panel + .panel { margin-top: 12px; }
      pre { white-space: pre-wrap; overflow-wrap: anywhere; margin: 10px 0 0; padding: 12px; background: #101828; color: #f8fafc; border-radius: 7px; max-height: 420px; overflow: auto; }
      button, a.button { border: 0; border-radius: 7px; background: #1a73e8; color: #fff; padding: 8px 11px; font: inherit; text-decoration: none; cursor: pointer; }
      button.secondary { background: #eef2f7; color: #172033; }
      .toolbar { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 12px; }
      .muted { color: #667085; }
      @media (max-width: 760px) { .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } header { align-items: flex-start; flex-direction: column; } }
    </style>
  </head>
  <body>
    <main>
      <header>
        <div>
          <h1>Latch</h1>
          <div class="muted">Local response monitor at 127.0.0.1:${PORT}</div>
        </div>
        <span class="pill" id="connection">connecting</span>
      </header>
      <section class="grid">
        <div class="card"><div class="label">Latest status</div><div class="value" id="status">-</div></div>
        <div class="card"><div class="label">Events</div><div class="value" id="events">-</div></div>
        <div class="card"><div class="label">Latest chars</div><div class="value" id="chars">-</div></div>
        <div class="card"><div class="label">Uptime</div><div class="value" id="uptime">-</div></div>
      </section>
      <section class="panel">
        <strong>Latest response</strong>
        <div class="toolbar">
          <button id="copy">Copy response</button>
          <button class="secondary" id="refresh">Refresh</button>
          <a class="button" href="/events?limit=50">JSON events</a>
        </div>
        <pre id="response"></pre>
      </section>
      <section class="panel">
        <strong>Latest event</strong>
        <pre id="latest"></pre>
      </section>
    </main>
    <script>
      const $ = id => document.getElementById(id);
      let latest = null;
      async function refresh() {
        const health = await fetch('/health').then(r => r.json());
        latest = await fetch('/latest').then(r => r.json());
        $('connection').textContent = 'online';
        $('status').textContent = latest && latest.status ? latest.status : '-';
        $('events').textContent = health.eventCount;
        $('chars').textContent = latest && latest.assistantText ? latest.assistantText.length : 0;
        $('uptime').textContent = Math.round(health.uptimeSec) + 's';
        $('response').textContent = latest && latest.assistantText ? latest.assistantText : '';
        $('latest').textContent = JSON.stringify(latest, null, 2);
      }
      $('refresh').addEventListener('click', refresh);
      $('copy').addEventListener('click', async () => {
        await navigator.clipboard.writeText(latest && latest.assistantText ? latest.assistantText : '');
      });
      refresh().catch(error => {
        $('connection').textContent = 'offline';
        $('latest').textContent = String(error);
      });
      const source = new EventSource('/stream');
      source.addEventListener('latch', refresh);
    </script>
  </body>
</html>`;
}

function metrics() {
  const statusCounts = {};
  const serviceCounts = {};
  for (const status of VALID_STATUSES) statusCounts[status] = 0;
  for (const event of events) {
    statusCounts[event.status] = (statusCounts[event.status] || 0) + 1;
    const service = event.service || "unknown";
    serviceCounts[service] = (serviceCounts[service] || 0) + 1;
  }
  return {
    ok: true,
    uptimeSec: (Date.now() - startedAt) / 1000,
    eventCount: events.length,
    latestId: latest ? latest.id : null,
    latestStatus: latest ? latest.status : null,
    conversations: latestByConversation.size,
    statusCounts,
    serviceCounts,
    dataDir: DATA_DIR,
    tokenRequired: Boolean(TOKEN)
  };
}

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);

  if (!isAllowedOrigin(req.headers.origin)) {
    sendJson(req, res, 403, { ok: false, error: "Origin not allowed" });
    return;
  }

  if (req.method === "OPTIONS") {
    res.writeHead(204, corsHeaders(req));
    res.end();
    return;
  }

  if (requiresAuth(req, url) && !hasToken(req, url)) {
    sendJson(req, res, 401, { ok: false, error: "Missing or invalid token" });
    return;
  }

  if (req.method === "GET" && url.pathname === "/") {
    sendHtml(req, res, 200, dashboardHtml());
    return;
  }

  if (req.method === "GET" && url.pathname === "/health") {
    sendJson(req, res, 200, metrics());
    return;
  }

  if (req.method === "POST" && url.pathname === "/events") {
    const payload = await readJson(req);
    const list = Array.isArray(payload) ? payload : [payload];
    const stored = [];
    for (const item of list) {
      stored.push(await storeEvent(item));
    }
    sendJson(req, res, 200, {
      ok: true,
      stored: stored.filter(item => !item.duplicate).length,
      duplicate: stored.filter(item => item.duplicate).length,
      event: stored.length ? stored[stored.length - 1].event : null
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/latest") {
    sendJson(req, res, 200, eventForUrl(url) || { ok: true, event: null });
    return;
  }

  if (req.method === "GET" && url.pathname === "/text/latest") {
    const event = eventForUrl(url);
    sendText(req, res, 200, event ? event.assistantText || "" : "");
    return;
  }

  if (req.method === "GET" && url.pathname === "/events") {
    sendJson(req, res, 200, filterEvents(url));
    return;
  }

  if (req.method === "GET" && url.pathname === "/conversations") {
    sendJson(req, res, 200, Array.from(latestByConversation.values()).sort((a, b) => b.id - a.id));
    return;
  }

  if (req.method === "GET" && url.pathname === "/stream") {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      ...corsHeaders(req)
    });
    const client = {
      res,
      url
    };
    streams.add(client);
    writeSse(res, "hello", metrics());
    const current = eventForUrl(url);
    if (current) writeSse(res, "chatgpt", current);
    req.on("close", () => streams.delete(client));
    return;
  }

  if (req.method === "POST" && url.pathname === "/clear") {
    await clearState();
    sendJson(req, res, 200, { ok: true });
    return;
  }

  sendJson(req, res, 404, { ok: false, error: "Not found" });
}

const server = http.createServer(async (req, res) => {
  try {
    await route(req, res);
  } catch (error) {
    sendJson(req, res, 500, {
      ok: false,
      error: error && error.message ? error.message : String(error)
    });
  }
});

loadState()
  .then(() => {
    server.listen(PORT, HOST, () => {
      console.log(`[latch] bridge listening at http://${HOST}:${PORT}`);
      console.log(`[latch] data dir: ${DATA_DIR}`);
      if (TOKEN) console.log("[latch] write token is enabled");
    });
  })
  .catch(error => {
    console.error(error && error.stack ? error.stack : String(error));
    process.exit(1);
  });

process.on("SIGINT", () => {
  server.close(() => process.exit(0));
});
