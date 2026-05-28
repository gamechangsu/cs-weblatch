"use strict";

const DEFAULT_BRIDGE_URL = "http://127.0.0.1:8765";
const MAX_QUEUE = 50;
const FLUSH_ALARM = "latch-flush";

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message) return false;

  routeMessage(message, sender)
    .then(result => sendResponse(result))
    .catch(error => sendResponse({
      ok: false,
      error: error && error.message ? error.message : String(error)
    }));

  return true;
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(FLUSH_ALARM, { periodInMinutes: 1 });
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(FLUSH_ALARM, { periodInMinutes: 1 });
});

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === FLUSH_ALARM) {
    flushQueue().catch(() => {});
  }
});

async function routeMessage(message, sender) {
  if (message.type === "latch:event") {
    return handleEvent(message.payload || {}, sender);
  }

  return { ok: false, error: "Unknown message type" };
}

async function handleEvent(payload, sender) {
  const event = {
    ...payload,
    tabId: sender && sender.tab ? sender.tab.id : payload.tabId,
    windowId: sender && sender.tab ? sender.tab.windowId : payload.windowId,
    observedAt: payload.observedAt || new Date().toISOString()
  };

  await flushQueue();

  await chrome.storage.local.set({
    latestEvent: event,
    latestEventAt: new Date().toISOString()
  });

  updateBadge(event);

  try {
    const bridgeResult = await postToBridge(event);
    await chrome.storage.local.set({ lastBridgeError: "" });
    return { ok: true, bridge: bridgeResult };
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    await enqueueEvent(event);
    await chrome.storage.local.set({ lastBridgeError: message });
    await chrome.action.setBadgeText({ text: "!" });
    await chrome.action.setBadgeBackgroundColor({ color: "#b42318" });
    return { ok: false, error: message };
  }
}

async function postToBridge(event) {
  const { bridgeUrl, bridgeToken } = await chrome.storage.local.get(defaultSettings());
  const headers = {
    "content-type": "application/json"
  };
  if (bridgeToken) headers["x-latch-token"] = bridgeToken;

  const response = await fetch(new URL("/events", bridgeUrl).href, {
    method: "POST",
    headers,
    body: JSON.stringify(event)
  });

  if (!response.ok) {
    throw new Error(`Bridge returned HTTP ${response.status}`);
  }

  return response.json();
}

async function enqueueEvent(event) {
  const { pendingEvents } = await chrome.storage.local.get({ pendingEvents: [] });
  const next = [...pendingEvents, event].slice(-MAX_QUEUE);
  await chrome.storage.local.set({ pendingEvents: next });
}

async function flushQueue() {
  const { pendingEvents } = await chrome.storage.local.get({ pendingEvents: [] });
  if (!pendingEvents.length) return { ok: true, flushed: 0 };

  let flushed = 0;
  const remaining = [];
  for (const event of pendingEvents) {
    try {
      await postToBridge(event);
      flushed += 1;
    } catch {
      remaining.push(event);
    }
  }

  await chrome.storage.local.set({
    pendingEvents: remaining,
    lastBridgeError: remaining.length ? "Bridge is unreachable; events are queued." : ""
  });
  return { ok: remaining.length === 0, flushed, remaining: remaining.length };
}

function defaultSettings() {
  return {
    bridgeUrl: DEFAULT_BRIDGE_URL,
    bridgeToken: "",
    latestEvent: null,
    latestEventAt: "",
    lastBridgeError: "",
    pendingEvents: []
  };
}

async function updateBadge(event) {
  if (event.status === "done") {
    await chrome.action.setBadgeText({ text: "OK" });
    await chrome.action.setBadgeBackgroundColor({ color: "#137333" });
    return;
  }

  if (event.status === "error") {
    await chrome.action.setBadgeText({ text: "ERR" });
    await chrome.action.setBadgeBackgroundColor({ color: "#b42318" });
    return;
  }

  if (event.status === "thinking" || event.status === "streaming") {
    await chrome.action.setBadgeText({ text: "..." });
    await chrome.action.setBadgeBackgroundColor({ color: "#1a73e8" });
    return;
  }

  await chrome.action.setBadgeText({ text: "" });
}
