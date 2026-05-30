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

  const DEFAULT_COMPOSER_SELECTORS = [
    '[contenteditable="true"][role="textbox"]',
    '[data-testid="composer-root"] [contenteditable="true"]',
    '[aria-label*="prompt" i]',
    '[aria-label*="message" i]',
    '[placeholder*="prompt" i]',
    '[placeholder*="message" i]',
    "textarea"
  ];

  const DEFAULT_STOP_PATTERN = /stop generating|stop responding|stop|interrupt|cancel generation|cancel|중지|취소|응답\s*중지|답변\s*중지|생성\s*중지|중지\s*생성/i;
  const DEFAULT_ACTION_PATTERN = /copy|regenerate|retry|good response|bad response|read aloud|share|export|복사|다시|좋아요|싫어요|읽어|공유|내보내기/i;
  const DEFAULT_THINKING_PATTERN = /thinking|generating|reasoning|running|loading|생각\s*중|응답\s*생성|답변\s*생성|실행\s*중|로드\s*중/i;
  const DEFAULT_ERROR_PATTERN = /something went wrong|network error|rate limit|try again|문제가\s*발생|오류가\s*발생|다시\s*시도/i;

  const ADAPTERS = [
    {
      service: "chatgpt",
      label: "ChatGPT",
      hosts: ["chatgpt.com", "chat.openai.com"],
      messages: {
        user: [
          '[data-message-author-role="user"]',
          '[data-message-role="user"]',
          '[data-author="user"]',
          'article:has([data-message-author-role="user"])'
        ],
        assistant: [
          '[data-message-author-role="assistant"]',
          '[data-message-role="assistant"]',
          '[data-author="assistant"]',
          'article:has([data-message-author-role="assistant"])'
        ]
      },
      conversationId() {
        const match = location.pathname.match(/\/c\/([^/]+)/);
        return match ? match[1] : "";
      },
      modelPattern: /gpt|pro|thinking|heavy|instant|model|헤비|확장|모드|모델|생각/i
    },
    {
      service: "gemini",
      label: "Gemini",
      hosts: ["gemini.google.com"],
      messages: {
        user: [
          '[data-test-id="user-query"]',
          '[data-testid="user-query"]',
          '[data-test-id*="user" i][data-test-id*="query" i]',
          '[data-testid*="user" i][data-testid*="query" i]',
          '[class*="user-query" i]',
          '[class*="query-text" i]',
          'user-query',
          'message-content:has([class*="user" i])'
        ],
        assistant: [
          '[data-test-id="response"]',
          '[data-testid="response"]',
          '[data-test-id*="model" i][data-test-id*="response" i]',
          '[data-testid*="model" i][data-testid*="response" i]',
          '[class*="model-response" i]',
          '[class*="response-container" i]',
          '[class*="markdown" i]',
          'model-response',
          'message-content:has([class*="model" i])'
        ]
      },
      conversationId() {
        const match = location.pathname.match(/\/(?:app|chat)\/([^/?#]+)/);
        return match ? match[1] : "";
      },
      modelPattern: /gemini|flash|pro|thinking|deep research|model|모델|생각/i,
      actionPattern: /copy|share|export|google it|listen|regenerate|retry|복사|공유|다시|듣기/i
    },
    {
      service: "claude",
      label: "Claude",
      hosts: ["claude.ai"],
      messages: {
        user: [
          '[data-testid="user-message"]',
          '[data-testid*="user" i][data-testid*="message" i]',
          '[data-message-author-role="user"]',
          '[class*="user-message" i]',
          '[class*="human" i][class*="message" i]'
        ],
        assistant: [
          '[data-testid="assistant-message"]',
          '[data-testid*="assistant" i][data-testid*="message" i]',
          '[data-message-author-role="assistant"]',
          '[class*="assistant-message" i]',
          '[class*="claude" i][class*="message" i]',
          '[data-is-streaming]'
        ]
      },
      conversationId() {
        const match = location.pathname.match(/\/chat\/([^/?#]+)/);
        return match ? match[1] : "";
      },
      modelPattern: /claude|opus|sonnet|haiku|model|모델/i,
      actionPattern: /copy|retry|regenerate|thumb|good response|bad response|복사|다시|좋아요|싫어요/i,
      thinkingPattern: /claude is thinking|thinking|generating|reasoning|생각\s*중|답변\s*생성/i
    },
    {
      service: "aistudio",
      label: "AI Studio",
      hosts: ["aistudio.google.com"],
      latestMessage(role) {
        const turns = qsa("ms-chat-turn").filter(isVisible);
        const containers = turns
          .map(turn => ({
            turn,
            container: turn.querySelector(role === "user"
              ? ".chat-turn-container.user"
              : ".chat-turn-container.model")
          }))
          .filter(item => item.container && isVisible(item.container));

        const candidates = role === "assistant"
          ? containers.filter(item => !item.container.querySelector("ms-thought-chunk"))
          : containers;
        if (!candidates.length) return { node: null, text: "" };

        const latest = candidates[candidates.length - 1];
        const chunks = qsa("ms-text-chunk", latest.container)
          .filter(isVisible)
          .filter(node => !node.closest("ms-thought-chunk"))
          .map(usefulText)
          .filter(Boolean);
        const text = chunks.length ? chunks.join("\n\n") : usefulText(latest.container);
        return { node: latest.turn, text: truncate(text) };
      },
      messages: {
        user: [
          'ms-chat-turn .chat-turn-container.user ms-text-chunk',
          'ms-chat-turn .chat-turn-container.user ms-prompt-chunk',
          '[data-testid*="user" i]',
          '[data-test-id*="user" i]',
          '[aria-label*="user" i]',
          '[class*="user" i][class*="message" i]',
          '[class*="prompt" i][class*="input" i]',
          'ms-prompt-input',
          'textarea'
        ],
        assistant: [
          'ms-chat-turn .chat-turn-container.model:not(:has(ms-thought-chunk)) ms-text-chunk',
          'ms-chat-turn .chat-turn-container.model:not(:has(ms-thought-chunk)) ms-prompt-chunk',
          '[data-testid*="response" i]',
          '[data-test-id*="response" i]',
          '[class*="model-response" i]',
          'ms-model-response'
        ]
      },
      conversationId() {
        const match = location.pathname.match(/\/(?:app\/)?(?:prompts|chats|chat)\/([^/?#]+)/);
        return match ? match[1] : "";
      },
      modelPattern: /gemini|flash|pro|model|temperature|token|모델/i,
      actionPattern: /copy|rerun|share|export|thumb|good response|bad response|복사|다시|공유|내보내기/i,
      thinkingPattern: /running|generating|thinking|loading|실행\s*중|생성\s*중|로드\s*중/i
    }
  ];

  const adapter = adapterForLocation();
  if (!adapter) return;

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

  function adapterForLocation() {
    const host = location.hostname.toLowerCase();
    return ADAPTERS.find(item => item.hosts.some(candidate => host === candidate || host.endsWith(`.${candidate}`)));
  }

  function qsa(selector, root = document) {
    try {
      return Array.from(root.querySelectorAll(selector));
    } catch {
      return [];
    }
  }

  function textOf(node) {
    return (node && (node.innerText || node.textContent || node.value) || "").replace(/\u00a0/g, " ").trim();
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

  function usefulText(node) {
    const text = truncate(textOf(node));
    return text && text.length > 1 ? text : "";
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
    if (typeof adapter.latestMessage === "function") {
      const custom = adapter.latestMessage(role);
      if (custom && custom.text) return custom;
    }

    const selectors = adapter.messages && adapter.messages[role] ? adapter.messages[role] : [];
    const nodes = selectors
      .flatMap(selector => qsa(selector))
      .filter(isVisible)
      .filter(node => usefulText(node));

    if (!nodes.length) return { node: null, text: "" };

    const node = nodes[nodes.length - 1];
    return { node, text: usefulText(node) };
  }

  function composerText() {
    const selectors = adapter.composerSelectors || DEFAULT_COMPOSER_SELECTORS;
    const node = selectors.flatMap(selector => qsa(selector)).find(isVisible);
    return truncate(textOf(node));
  }

  function visibleButtons(root = document) {
    return qsa("button,[role='button'],[role='menuitem'],[role='option']", root).filter(isVisible);
  }

  function controlLabel(node) {
    return compactText([
      node.getAttribute("aria-label"),
      node.getAttribute("title"),
      node.getAttribute("data-testid"),
      node.getAttribute("data-test-id"),
      textOf(node)
    ].filter(Boolean).join(" "));
  }

  function hasStopButton() {
    const pattern = adapter.stopPattern || DEFAULT_STOP_PATTERN;
    return visibleButtons().some(button => pattern.test(controlLabel(button)));
  }

  function hasAssistantAction(assistantNode) {
    const pattern = adapter.actionPattern || DEFAULT_ACTION_PATTERN;
    const localButtons = assistantNode ? visibleButtons(assistantNode) : [];
    const globalButtons = visibleButtons().slice(-32);
    return [...localButtons, ...globalButtons].some(button => pattern.test(controlLabel(button)));
  }

  function thinkingLabel() {
    const bodyText = textOf(document.body);
    const patterns = [
      /(\d+\s*(?:초|분|시간)\s*(?:동안\s*)?생각함)/,
      /(\d+\s*(?:s|m|h)\s*(?:동안\s*)?생각함)/i,
      /(thought for\s+\d+\s*(?:seconds?|minutes?|hours?|s|m|h))/i,
      /(reasoned for\s+\d+\s*(?:seconds?|minutes?|hours?|s|m|h))/i
    ];

    for (const pattern of patterns) {
      const match = bodyText.match(pattern);
      if (match) return match[1];
    }
    return "";
  }

  function thinkingInProgress() {
    if (adapter.service === "aistudio") {
      return /\b(?:running|generating|loading)\b/i.test(textOf(document.body));
    }

    const bodyText = textOf(document.body);
    const pattern = adapter.thinkingPattern || DEFAULT_THINKING_PATTERN;
    return pattern.test(bodyText);
  }

  function pageError() {
    const bodyText = textOf(document.body);
    const pattern = adapter.errorPattern || DEFAULT_ERROR_PATTERN;
    const match = bodyText.match(pattern);
    return match ? match[0] : "";
  }

  function conversationId() {
    return typeof adapter.conversationId === "function" ? adapter.conversationId() : "";
  }

  function modelLabel() {
    const pattern = adapter.modelPattern || /model|모델/i;
    const controls = [
      ...visibleButtons(),
      ...qsa('[role="combobox"],[aria-haspopup="listbox"],[data-testid*="model" i],[data-test-id*="model" i]').filter(isVisible)
    ];
    const match = controls.map(controlLabel).filter(Boolean).find(label => pattern.test(label));
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
    const currentConversationId = conversationId();
    const currentModelLabel = modelLabel();

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

    const fingerprint = [
      adapter.service,
      status,
      currentConversationId,
      hashText(latestUser.text),
      hashText(assistantText),
      doneThinkingLabel,
      errorText,
      currentModelLabel
    ].join("|");

    const event = {
      kind: "latch-state",
      service: adapter.service,
      serviceLabel: adapter.label,
      status,
      url: location.href,
      title: document.title,
      conversationId: currentConversationId,
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
    attributeFilter: [
      "aria-label",
      "class",
      "data-message-author-role",
      "data-message-role",
      "data-testid",
      "data-test-id",
      "disabled"
    ]
  });

  window.addEventListener("popstate", scheduleAnalyze);
  window.addEventListener("hashchange", scheduleAnalyze);
  document.addEventListener("visibilitychange", scheduleAnalyze);
  setInterval(scheduleAnalyze, Math.max(1000, Math.floor(CONFIG.stableDoneMs / 2)));
  scheduleAnalyze();
})();
