# CS WebLatch

CS WebLatch is a Codex skill for sending prompts to ChatGPT Web through Chrome and reading completed responses through a local Latch bridge.

The skill includes:

- `SKILL.md`: Codex skill instructions
- `agents/openai.yaml`: Codex skill metadata
- `scripts/latch/bridge`: local Node bridge for response events
- `scripts/latch/extension`: Chrome extension that observes ChatGPT Web state

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
npm run wait
npm run text
npm run check
```

The bridge listens on:

```text
http://127.0.0.1:8765
```

See `SKILL.md` for the full Codex workflow.
