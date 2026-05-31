# CS WebLatch

CS WebLatch is a Codex skill for sending prompts to conversational AI web services through Chrome and reading completed responses through a local Latch bridge. The bundled adapters currently target ChatGPT Web, Gemini Web, Gemini Canvas, Claude Web, and Google AI Studio.

The skill includes:

- `SKILL.md`: Codex skill instructions
- `agents/openai.yaml`: Codex skill metadata
- `scripts/latch/bridge`: local Node bridge for response events
- `scripts/latch/extension`: Chrome extension that observes supported web AI service state

## Quick Start

Install this folder as a Codex skill, then run the bridge from `scripts/latch/`:

```powershell
npm run bridge
```

Load the unpacked Chrome extension from:

```text
scripts/latch/extension/
```

Useful bridge commands:

```powershell
npm run status
npm run session
npm run wait
npm run text
npm run check
```

The bridge listens on:

```text
http://127.0.0.1:8765
```

See `SKILL.md` for the full Codex workflow.

Durable wait sessions are available for long or interrupt-prone web AI runs:

```powershell
npm run session -- start --service gemini --after-id 14 --prompt-file .\prompt.txt --json
npm run session -- poll --session <sessionId> --json
```
