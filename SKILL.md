---
name: cs-weblatch
description: Use CS WebLatch when Codex needs to talk to a conversational AI web service in Chrome through a local Latch bridge. The current bundled implementation targets ChatGPT/GPT Web, including requests to ask ChatGPT, GPT Web, a specific ChatGPT model/mode, or a logged-in ChatGPT tab from Codex. Use this skill to send prompts through the browser, wait for completed web responses, and retrieve the final answer without repeated DOM polling.
---

# CS WebLatch

Use CS WebLatch as the default completion channel whenever the task is to ask a conversational AI web service in Chrome from Codex. Invoke it as `$cs-weblatch`. The current bundled adapter targets ChatGPT Web. It uses a headless Chrome extension plus local Latch bridge that watches web chat responses and exposes the latest state at `http://127.0.0.1:8765`.

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
   - The current adapter supports ChatGPT Web.
   - Use a Codex-owned ChatGPT work tab by default; do not borrow arbitrary user ChatGPT tabs.
   - Reuse an existing Latch/Codex work tab only if it is clearly agent-owned, for example a prior Latch tab group/session.
   - Otherwise create a new Chrome tab with `browser.tabs.new()` and open `https://chatgpt.com/`.
   - User-owned ChatGPT tabs are free for the user to move, navigate, or close.
   - Do not change the model/mode by default.
   - Change the ChatGPT model or mode only when the user explicitly requests one in their prompt.
   - If the requested model/mode is not visible or cannot be selected, report that and proceed only if the user's instruction allows fallback.
   - Before sending, record the current bridge `latestId` from `GET /health`; use `0` if there is no latest id.
   - Save the exact prompt text to a temporary UTF-8 file when practical.
   - Send the user's prompt through the web chat composer.

3. Wait through Latch, not repeated browser checks.
   - Prefer `npm run wait -- --after-id <latestId> --prompt-file <promptFile> --json`.
   - If the current conversation id is known, pass it with `npm run wait -- --conversation <id>` or query `conversationId=<id>`.
   - If the Chrome tab id or Latch page session id is known, add `--tab-id <id>` or `--page-session <id>`.
   - In strict mode, use all known filters together: `--after-id`, `--prompt-file`, `--conversation`, `--tab-id`, and `--watch-lost`.
   - `wait-latest.js` tolerates a single editor-added final newline in `--prompt-file`, but still prefer writing the exact prompt text.
   - Avoid loops that repeatedly inspect the ChatGPT DOM from Codex just to see whether generation finished.

4. Recover a lost work tab without asking the user to stay still.
   - If `wait-latest.js` returns `status: "watch_lost"`, the target tab left the target conversation.
   - Reopen `target.url` from the watch-lost event in the Codex work tab, wait for the page to load, then rerun the same strict wait.
   - This recovery is state-based, not timeout-based: do it when the target tab movement is observed.
   - If the work tab was closed or cannot be reclaimed, create a new work tab, open `https://chatgpt.com/c/<conversationId>`, and rerun the same strict wait without changing the prompt filters.

5. Return the response from Latch.
   - Use `assistantText` from `/latest`, `/events`, or the wait CLI.
   - Include the ChatGPT conversation URL when useful.
   - If Latch reports `thinking` or `streaming`, keep waiting via the bridge unless the user asked for status only.

6. Keep the Codex work tab alive at browser cleanup.
   - Before finishing Chrome work, call `browser.tabs.finalize` as the final Chrome action.
   - Keep the Codex-owned ChatGPT work tab with handoff status: `await browser.tabs.finalize({ keep: [{ tab: workTab, status: "handoff" }] })`.
   - Do not close the work tab after a successful Latch run; preserve it for the next Latch task.
   - Do not keep arbitrary user-owned ChatGPT tabs unless the task explicitly requires it.

## Completion Signals

Treat `status: "done"` from Latch as the authoritative completion signal.

Useful event fields:

- `status`: `idle`, `draft`, `thinking`, `streaming`, `done`, or `error`
- `url`: ChatGPT conversation URL
- `conversationId`: ChatGPT `/c/...` id
- `userText`: latest user prompt
- `assistantText`: captured ChatGPT response
- `thinkingLabel`: visible thinking duration when present
- `modelLabel`: visible model/mode label when present

## Failure Handling

- If `/health` fails, start the bridge from the Latch project.
- If the bridge is healthy but no ChatGPT events arrive, ask the user to reload the ChatGPT tab and reload the `Latch` extension from `scripts/latch/extension/` in `chrome://extensions`; do not try to automate `chrome://extensions`.
- If Chrome automation cannot communicate with the Codex Chrome Extension, follow the Chrome skill troubleshooting path.
- If ChatGPT shows login, CAPTCHA, payment, or another user-gated screen, stop and ask the user to handle it.
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

Strict wait with work-tab movement detection:

```powershell
npm run wait -- --after-id 14 --prompt-file .\prompt.txt --conversation <conversationId> --tab-id <tabId> --watch-lost --json
```

Chrome cleanup for a reusable work tab:

```javascript
await browser.tabs.finalize({ keep: [{ tab: workTab, status: "handoff" }] });
```
