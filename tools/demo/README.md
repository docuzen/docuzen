# Demo recording rig

Records the README hero GIF (`docs/media/demo.gif`) by driving the real app
through the review flow with the real Codex agent.

## Regenerate

Prerequisites: Codex configured (`~/.docuzen/config.toml` → `[harness] default = "codex"`)
and `ffmpeg` on PATH.

```bash
npm install          # once, for Playwright's browser
node tools/demo/run.mjs
# tighten if needed:
node tools/demo/run.mjs --speed 1.3 --start 1 --end 26
```

The recording uses a live LLM, so it is **non-deterministic** — re-run until the
take reads well, then commit `docs/media/demo.gif`. This is a committed artifact,
not a CI gate (CI has no Codex).
