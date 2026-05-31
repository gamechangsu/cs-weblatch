"use strict";

const http = require("node:http");

const DEFAULT_URL = process.env.LATCH_URL || "http://127.0.0.1:8765";
const DEFAULT_TOKEN = process.env.LATCH_TOKEN || "";

const args = process.argv.slice(2);
const opts = {
  baseUrl: valueAfter("--url") || DEFAULT_URL,
  token: valueAfter("--token") || DEFAULT_TOKEN,
  service: valueAfter("--service") || "",
  freshMs: Number(valueAfter("--fresh-ms") || 60 * 1000),
  json: args.includes("--json"),
  help: args.includes("--help") || args.includes("-h")
};

if (opts.help) {
  console.log(`Usage: node bridge/status.js [options]

Options:
  --url <url>        Bridge URL. Default: ${DEFAULT_URL}
  --token <token>    Optional bridge token.
  --service <name>   Check whether a service has emitted events.
  --fresh-ms <ms>    Freshness window for latest events. Default: 60000
  --json             Print JSON.
  -h, --help         Show this help.
`);
  process.exit(0);
}

function valueAfter(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : "";
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

function capability(capabilityId, state, evidence = {}, next = "") {
  return { capabilityId, state, evidence, next };
}

function worstState(capabilities) {
  if (capabilities.some(item => item.state === "fail")) return "fail";
  if (capabilities.some(item => item.state === "warn")) return "warn";
  if (capabilities.some(item => item.state === "unknown")) return "unknown";
  return "ok";
}

function normalizeLatest(value) {
  if (!value || value.event === null) return null;
  return value;
}

function latestAgeMs(latest) {
  if (!latest || !latest.receivedAt) return null;
  const receivedAt = Date.parse(latest.receivedAt);
  if (!Number.isFinite(receivedAt)) return null;
  return Date.now() - receivedAt;
}

function errorEnvelope(error) {
  const message = error && error.message ? error.message : String(error);
  const code = /ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|socket hang up/i.test(message)
    ? "latch.bridge-unreachable"
    : "latch.status-failed";
  return {
    ok: false,
    status: "error",
    error: {
      name: error && error.name ? error.name : "Error",
      errorCode: code,
      stage: "status",
      message,
      retryHint: code === "latch.bridge-unreachable" ? "start-bridge" : "inspect-bridge",
      evidence: { url: opts.baseUrl }
    }
  };
}

function printHuman(result) {
  console.log(`Latch status: ${result.status}`);
  console.log(`Bridge: ${result.bridgeUrl}`);
  console.log(`Latest id: ${result.health.latestId == null ? "-" : result.health.latestId}`);
  if (result.latest) {
    console.log(`Latest event: ${result.latest.service} ${result.latest.status} ${result.latest.url || ""}`.trim());
  }
  for (const item of result.capabilities) {
    const next = item.next ? ` (${item.next})` : "";
    console.log(`- ${item.capabilityId}: ${item.state}${next}`);
  }
}

(async () => {
  const health = await requestJson("/health");
  const latest = normalizeLatest(await requestJson("/latest").catch(() => null));
  const capabilities = [
    capability("bridge-health", "ok", {
      uptimeSec: health.uptimeSec,
      eventCount: health.eventCount,
      latestId: health.latestId
    }, "send-or-wait"),
    capability(
      "extension-events",
      health.latestId == null ? "warn" : "ok",
      { latestId: health.latestId },
      health.latestId == null ? "reload-target-tab-and-extension" : "wait"
    )
  ];

  if (opts.service) {
    const serviceCount = health.serviceCounts && health.serviceCounts[opts.service] || 0;
    capabilities.push(capability(
      "requested-service-observed",
      serviceCount > 0 ? "ok" : "warn",
      { service: opts.service, count: serviceCount },
      serviceCount > 0 ? "wait" : "open-or-reload-service-tab"
    ));
  }

  if (latest) {
    const terminalState = latest.status === "done"
      ? "ok"
      : latest.status === "error"
        ? "fail"
        : ["thinking", "streaming", "draft"].includes(latest.status)
          ? "warn"
          : "unknown";
    capabilities.push(capability("latest-terminal-state", terminalState, {
      status: latest.status,
      service: latest.service,
      id: latest.id
    }, terminalState === "warn" ? "wait" : "inspect-latest"));

    const ageMs = latestAgeMs(latest);
    capabilities.push(capability(
      "latest-event-freshness",
      ageMs == null ? "unknown" : ageMs <= opts.freshMs ? "ok" : "warn",
      { ageMs, freshMs: opts.freshMs },
      ageMs == null || ageMs > opts.freshMs ? "verify-extension-heartbeat" : "wait"
    ));
  } else {
    capabilities.push(capability("latest-terminal-state", "unknown", {}, "send-a-prompt"));
  }

  const capabilityState = worstState(capabilities);
  const result = {
    ok: capabilityState !== "fail",
    status: capabilityState === "fail" ? "blocked" : capabilityState === "warn" ? "degraded" : "ready",
    bridgeUrl: opts.baseUrl,
    health,
    latest,
    capabilities,
    capabilityState
  };

  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  printHuman(result);
})().catch(error => {
  const result = errorEnvelope(error);
  if (opts.json) {
    console.error(JSON.stringify(result, null, 2));
  } else {
    console.error(`${result.error.errorCode}: ${result.error.message}`);
  }
  process.exit(1);
});
