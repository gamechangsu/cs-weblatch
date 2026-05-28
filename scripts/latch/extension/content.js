"use strict";

(() => {
  if (window.__latchInstalled) return;
  window.__latchInstalled = true;

  const CONFIG = {
    analyzeDelayMs: 300,
    stableDoneMs: 1800,
    fallbackStableDoneMs: 5200,
    heartbeatMs: 15000,
    maxTextLength: 100000
  };

  const state = {
    timer: 0,
    sequence: 0,
    pageSessionId: makeId(),
    lastUrl: location.href,
    lastAssistantText: "",
    lastAssistantChangedAt: Date.now(),
    lastFingerprint: "",
    lastHeartbeatAt: 0
  };

  function makeId() {
    const random = Math.random().toString(36).slice(2, 10);
    return `${Date.now().toString(36)}-${random}`;
  }

  function qsa(selector, root = document) {
    return Array.from(root.querySelectorAll(selector));
  }

  function textOf(node) {
    return (node && (node.innerText || node.textContent) || "").replace(/\u00a0/g, " ").trim();
  }

  function compactText(value) {
    return String(value || "")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function truncate(value) {
    const text = compactText(value);
    return text.length > CONFIG.maxTextLength ? text.slice(0, CONFIG.maxTextLength) : text;
  }

  function isVisible(node) {
    if (!node || typeof node.getBoundingClientRect !== "function") return false;
    const style = getComputedStyle(node);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
    const rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function hashText(value) {
    let hash = 2166136261;
    const text = String(value || "");
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  }

  function latestMessage(role) {
    const selectors = [
      `[data-message-author-role="${role}"]`,
      `[data-message-role="${role}"]`,
      `[data-author="${role}"]`,
      `article:has([data-message-author-role="${role}"])`
    ];

    const nodes = selectors.flatMap(selector => {
      try {
        return qsa(selector);
      } catch {
        return [];
      }
    }).filter(isVisible);

    if (!nodes.length) return { node: null, text: "" };

    const node = nodes[nodes.length - 1];
    return { node, text: truncate(textOf(node)) };
  }

  function composerText() {
    const selectors = [
      '[contenteditable="true"][role="textbox"]',
      '[data-testid="composer-root"] [contenteditable="true"]',
      "textarea"
    ];
    const node = selectors.flatMap(selector => qsa(selector)).find(isVisible);
    return truncate(textOf(node) || (node && node.value) || "");
  }

  function visibleButtons(root = document) {
    return qsa("button,[role='button']", root).filter(isVisible);
  }

  function controlLabel(node) {
    return compactText([
      node.getAttribute("aria-label"),
      node.getAttribute("title"),
      textOf(node)
    ].filter(Boolean).join(" "));
  }

  function hasStopButton() {
    return visibleButtons().some(button => {
      const label = controlLabel(button);
      return /stop generating|stop responding|interrupt|cancel generation/i.test(label)
        || /\uc751\ub2f5\s*\uc911\uc9c0|\ub2f5\ubcc0\s*\uc911\uc9c0|\uc0dd\uc131\s*\uc911\uc9c0|\uc911\uc9c0\s*\uc0dd\uc131/.test(label);
    });
  }

  function hasAssistantAction(assistantNode) {
    const localButtons = assistantNode ? visibleButtons(assistantNode) : [];
    const globalButtons = visibleButtons().slice(-24);
    return [...localButtons, ...globalButtons].some(button => {
      const label = controlLabel(button);
      return /copy|regenerate|retry|good response|bad response|read aloud/i.test(label)
        || /\ubcf5\uc0ac|\ub2e4\uc2dc|\uc88b\uc544\uc694|\uc2eb\uc5b4\uc694|\uc77d\uc5b4/.test(label);
    });
  }

  function thinkingLabel() {
    const bodyText = textOf(document.body);
    const patterns = [
      /(\d+\s*(?:\ucd08|\ubd84|\uc2dc\uac04)\s*(?:\ub3d9\uc548\s*)?\uc0dd\uac01\ud568)/,
      /(\d+\s*(?:s|m|h)\s*(?:\ub3d9\uc548\s*)?\uc0dd\uac01\ud568)/i,
      /(thought for\s+\d+\s*(?:seconds?|minutes?|hours?|s|m|h))/i
    ];

    for (const pattern of patterns) {
      const match = bodyText.match(pattern);
      if (match) return match[1];
    }
    return "";
  }

  function thinkingInProgress() {
    const bodyText = textOf(document.body);
    return /thinking|generating|reasoning/i.test(bodyText)
      || /\uc0dd\uac01\s*\uc911|\uc751\ub2f5\s*\uc0dd\uc131|\ub2f5\ubcc0\s*\uc0dd\uc131/.test(bodyText);
  }

  function pageError() {
    const bodyText = textOf(document.body);
    const match = bodyText.match(/(something went wrong|network error|rate limit|try again)/i)
      || bodyText.match(/(\ubb38\uc81c\uac00\s*\ubc1c\uc0dd|\uc624\ub958\uac00\s*\ubc1c\uc0dd|\ub2e4\uc2dc\s*\uc2dc\ub3c4)/);
    return match ? match[1] : "";
  }

  function conversationId() {
    const match = location.pathname.match(/\/c\/([^/]+)/);
    return match ? match[1] : "";
  }

  function modelLabel() {
    const candidates = visibleButtons().map(controlLabel).filter(Boolean);
    const match = candidates.find(label => {
      return /gpt|pro|thinking|heavy|instant|model/i.test(label)
        || /\ud5e4\ube44|\ud655\uc7a5|\ubaa8\ub4dc|\ubaa8\ub378|\uc0dd\uac01/.test(label);
    });
    return match || "";
  }

  function resetForUrlChange() {
    if (location.href === state.lastUrl) return;
    state.lastUrl = location.href;
    state.pageSessionId = makeId();
    state.lastAssistantText = "";
    state.lastAssistantChangedAt = Date.now();
    state.lastFingerprint = "";
    state.lastHeartbeatAt = 0;
  }

  function analyze() {
    resetForUrlChange();

    const now = Date.now();
    const latestUser = latestMessage("user");
    const latestAssistant = latestMessage("assistant");
    const assistantText = latestAssistant.text;

    if (assistantText !== state.lastAssistantText) {
      state.lastAssistantText = assistantText;
      state.lastAssistantChangedAt = now;
    }

    const composer = composerText();
    const stopVisible = hasStopButton();
    const assistantActionVisible = hasAssistantAction(latestAssistant.node);
    const doneThinkingLabel = thinkingLabel();
    const activeThinking = stopVisible || thinkingInProgress();
    const stableMs = now - state.lastAssistantChangedAt;
    const errorText = pageError();

    let status = "idle";
    if (errorText) {
      status = "error";
    } else if (activeThinking) {
      status = assistantText ? "streaming" : "thinking";
    } else if (assistantText) {
      const doneBySignals = assistantActionVisible || Boolean(doneThinkingLabel);
      status = stableMs >= CONFIG.stableDoneMs && (doneBySignals || stableMs >= CONFIG.fallbackStableDoneMs)
        ? "done"
        : "streaming";
    } else if (composer) {
      status = "draft";
    }

    const currentModelLabel = modelLabel();
    const fingerprint = [
      status,
      conversationId(),
      hashText(latestUser.text),
      hashText(assistantText),
      doneThinkingLabel,
      errorText,
      currentModelLabel
    ].join("|");

    const event = {
      kind: "latch-state",
      status,
      url: location.href,
      title: document.title,
      conversationId: conversationId(),
      pageSessionId: state.pageSessionId,
      sequence: ++state.sequence,
      userText: latestUser.text,
      assistantText,
      thinkingLabel: doneThinkingLabel,
      errorText,
      modelLabel: currentModelLabel,
      fingerprint,
      observedAt: new Date().toISOString(),
      signals: {
        stopVisible,
        assistantActionVisible,
        composerEmpty: !composer,
        thinkingInProgress: activeThinking,
        stableMs
      }
    };

    const shouldHeartbeat = status !== "done" && now - state.lastHeartbeatAt >= CONFIG.heartbeatMs;
    if (fingerprint !== state.lastFingerprint || shouldHeartbeat) {
      state.lastFingerprint = fingerprint;
      state.lastHeartbeatAt = now;
      emit(event);
    }
  }

  function scheduleAnalyze() {
    clearTimeout(state.timer);
    state.timer = setTimeout(analyze, CONFIG.analyzeDelayMs);
  }

  function emit(event) {
    try {
      chrome.runtime.sendMessage({
        type: "latch:event",
        payload: event
      });
    } catch {
      // The extension context can disappear during reloads.
    }
  }

  const observer = new MutationObserver(scheduleAnalyze);
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["aria-label", "data-message-author-role", "data-message-role", "disabled"]
  });

  window.addEventListener("popstate", scheduleAnalyze);
  window.addEventListener("hashchange", scheduleAnalyze);
  document.addEventListener("visibilitychange", scheduleAnalyze);
  scheduleAnalyze();
})();
