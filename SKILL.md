---
name: cs-weblatch
description: Use CS WebLatch when Codex needs to talk to a conversational AI web service in Chrome through a local Latch bridge. The bundled implementation targets ChatGPT/GPT Web, Gemini Web, Gemini Canvas, Claude Web, and Google AI Studio, including requests to ask a specific web AI service, model, or mode from Codex. Use this skill to send prompts through the browser, wait for completed web responses, and retrieve the final answer without repeated DOM polling.
---

# CS WebLatch

Use CS WebLatch as the default completion channel whenever the task is to ask a conversational AI web service in Chrome from Codex. Invoke it as `$cs-weblatch`. The bundled extension has adapters for ChatGPT Web, Gemini Web, Gemini Canvas, Claude Web, and Google AI Studio. It uses a Chrome extension plus local Latch bridge that watches web chat responses and exposes the latest state at `http://127.0.0.1:8765`.

## Local Setup

Bundled Latch project, relative to this skill folder:

```text
scripts/latch/
```

Chrome extension source, relative to this skill folder:

```text
scripts/latch/extension/
```

Run bridge commands from `scripts/latch/`:

```powershell
npm run bridge
npm run wait
npm run text
```

Bridge API:

```text
GET http://127.0.0.1:8765/health
GET http://127.0.0.1:8765/latest
GET http://127.0.0.1:8765/text/latest
GET http://127.0.0.1:8765/stream
```

## Workflow

1. Ensure the Latch bridge is running.
   - Check `GET /health` first.
   - If unavailable, start `npm run bridge` from `scripts/latch/` and keep that process running.
   - Do not ask the user to operate the Latch UI; there is no user-facing popup.
   - If the Chrome extension is not loaded, load the unpacked extension from `scripts/latch/extension/`.

2. Use the Chrome plugin to operate the target web chat.
   - Supported service names are `chatgpt`, `gemini`, `gemini_canvas`, `claude`, and `aistudio`.
   - Default to `chatgpt` unless the user explicitly requests another supported service.
   - Open service home URLs as needed:
     - ChatGPT: `https://chatgpt.com/`
     - Gemini: `https://gemini.google.com/`
     - Gemini Canvas: `https://gemini.google.com/`
     - Claude: `https://claude.ai/`
     - AI Studio: `https://aistudio.google.com/`
   - Use a Codex-owned work tab by default; do not borrow arbitrary user chat tabs.
   - Reuse an existing Latch/Codex work tab only if it is clearly agent-owned, for example a prior Latch tab group/session.
   - Otherwise create a new Chrome tab with `browser.tabs.new()` and open the requested service URL.
   - User-owned ChatGPT tabs are free for the user to move, navigate, or close.
   - Do not change the model/mode by default.
   - Change the model or mode only when the user explicitly requests one in their prompt.
   - If the requested model/mode is not visible or cannot be selected, report that and proceed only if the user's instruction allows fallback.
   - Do not encode personal account names, emails, subscription status, billing assumptions, or API-key preferences into the skill.
   - Treat account selection, paid-plan access, and API-key choices as per-user runtime details. If they matter for the current service, inspect the visible page or ask the user instead of hardcoding an assumption.
   - For Gemini Canvas, retrieve text/code/document content from the Canvas DOM. Do not use screenshot interpretation as the primary extraction path.
   - Before sending, record the current bridge `latestId` from `GET /health`; use `0` if there is no latest id.
   - Save the exact prompt text to a temporary UTF-8 file when practical.
   - Send the user's prompt through the web chat composer.

3. Wait through Latch, not repeated browser checks.
   - Prefer `npm run wait -- --after-id <latestId> --prompt-file <promptFile> --json`.
   - Pass `--service <name>` whenever using Gemini, Claude, AI Studio, or any non-default service.
   - If the current conversation id is known, pass it with `npm run wait -- --conversation <id>` or query `conversationId=<id>`.
   - If the Chrome tab id or Latch page session id is known, add `--tab-id <id>` or `--page-session <id>`.
   - In strict mode, use all known filters together: `--service`, `--after-id`, `--prompt-file`, `--conversation`, `--tab-id`, `--target-url`, and `--watch-lost`.
   - `wait-latest.js` tolerates a single editor-added final newline in `--prompt-file`, but still prefer writing the exact prompt text.
   - Avoid loops that repeatedly inspect the ChatGPT DOM from Codex just to see whether generation finished.

4. Recover a lost work tab without asking the user to stay still.
   - If `wait-latest.js` returns `status: "watch_lost"`, the target tab left the target conversation.
   - Reopen `target.url` from the watch-lost event in the Codex work tab, wait for the page to load, then rerun the same strict wait.
   - This recovery is state-based, not timeout-based: do it when the target tab movement is observed.
   - If the work tab was closed or cannot be reclaimed, create a new work tab, open the `target.url` from the event or the service home URL, and rerun the same strict wait without changing the prompt filters.

5. Return the response from Latch.
   - Use `assistantText` from `/latest`, `/events`, or the wait CLI.
   - Include the service conversation URL when useful.
   - If Latch reports `thinking` or `streaming`, keep waiting via the bridge unless the user asked for status only.

6. Keep the Codex work tab alive at browser cleanup.
   - Before finishing Chrome work, call `browser.tabs.finalize` as the final Chrome action.
   - Keep the Codex-owned ChatGPT work tab with handoff status: `await browser.tabs.finalize({ keep: [{ tab: workTab, status: "handoff" }] })`.
   - Do not close the work tab after a successful Latch run; preserve it for the next Latch task.
   - Do not keep arbitrary user-owned ChatGPT tabs unless the task explicitly requires it.

## Completion Signals

Treat `status: "done"` from Latch as the authoritative completion signal.

Useful event fields:

- `service`: `chatgpt`, `gemini`, `gemini_canvas`, `claude`, `aistudio`, or `unknown`
- `serviceLabel`: human-readable service name
- `status`: `idle`, `draft`, `thinking`, `streaming`, `done`, or `error`
- `url`: service conversation URL
- `conversationId`: service conversation/chat id when visible in the URL
- `userText`: latest user prompt
- `assistantText`: captured ChatGPT response
- `artifactLinks`: structured artifact/document/code links when a service exposes them, used by Gemini Canvas when available
- `thinkingLabel`: visible thinking duration when present
- `modelLabel`: visible model/mode label when present

## Failure Handling

- If `/health` fails, start the bridge from the Latch project.
- If the bridge is healthy but no service events arrive, ask the user to reload the target web chat tab and reload the `Latch` extension from `scripts/latch/extension/` in `chrome://extensions`; do not try to automate `chrome://extensions`.
- If Chrome automation cannot communicate with the Codex Chrome Extension, follow the Chrome skill troubleshooting path.
- If the target service shows login, CAPTCHA, payment, account consent, API key setup, or another user-gated screen, stop and ask the user to handle it.
- If Latch returns `error`, report the `errorText` and the conversation URL.

## Minimal Commands

Run these from `scripts/latch/`.

Check:

```powershell
Invoke-RestMethod http://127.0.0.1:8765/health
```

Latest JSON:

```powershell
npm run wait -- --once --json
```

Latest response text:

```powershell
npm run text
```

Wait for completion:

```powershell
npm run wait -- --json
```

Robust wait for a prompt sent after a known event id:

```powershell
npm run wait -- --after-id 14 --prompt-file .\prompt.txt --json
```

Wait for a non-default service:

```powershell
npm run wait -- --service claude --after-id 14 --prompt-file .\prompt.txt --json
```

Wait for Gemini Canvas text/code output:

```powershell
npm run wait -- --service gemini_canvas --after-id 14 --prompt-file .\prompt.txt --json
```

Strict wait with work-tab movement detection:

```powershell
npm run wait -- --service gemini --after-id 14 --prompt-file .\prompt.txt --conversation <conversationId> --tab-id <tabId> --target-url <url> --watch-lost --json
```

Chrome cleanup for a reusable work tab:

```javascript
await browser.tabs.finalize({ keep: [{ tab: workTab, status: "handoff" }] });
```
