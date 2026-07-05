# docuzen

docuzen is a Tauri desktop app for reviewing documents with inline comments,
version snapshots, and agent-assisted discussion/edit proposals. The repository
is named `ai-native-doc`; the main app is `apps/desktop`, and the Node sidecar
backend is `packages/docd`.

The app currently works best as a developer-run desktop app. It can open
Markdown and HTML documents, stores review state beside each document in a
`.had` sidecar directory, and can export/import portable `.hadz` bundles.

See [docs/architecture.md](docs/architecture.md) for the module map, the agent
turn lifecycle, and the verification tooling (parity + visual suites).

## Quick Start

Prerequisites (see [docs/install.md](docs/install.md#prerequisites) for
per-OS instructions):

- Node.js with npm. Node 20+ is recommended.
- Rust/Cargo: `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`
- The native system dependencies required by Tauri v2. On macOS:
  `xcode-select --install`.
- For live agent turns, a configured agent harness: on first launch the app
  asks you to pick Pi or Codex CLI and stores the choice in
  `~/.docuzen/config.toml` (Pi models come from `~/.pi/agent/models.json`).
  Until a harness is configured — or `LLM_API_KEY` is set as a dev-mode
  override — the app opens documents, but agent discussion is disabled by the
  fake sidecar runner.

Install and run from the repository root:

```bash
npm install
npm run build
npm link
docuzen
```

`docuzen` launches the current checkout's Tauri desktop app in developer mode.
Use `docuzen open ./path/to/file.md` to open a specific document.

Under the hood, the CLI runs the same Tauri dev flow. `tauri dev` runs
`npm run dev:all` first. That launcher starts:

- `docd`, the Node sidecar, on `127.0.0.1:8137` by default.
- Vite on `http://localhost:1420`, which Tauri loads in the native window.
- The sample document at `apps/desktop/sample/plan-rate-limiting.md`.

Open your own document with `File -> Open...` or `Cmd/Ctrl+O`.

Useful CLI commands:

```bash
docuzen open ./document.md
docuzen doctor
docuzen update
```

`docuzen update` is currently a placeholder for linked checkouts; packaged release
updates will use npm/GitHub Releases later.

For full setup, model configuration, build commands, and troubleshooting, see
[`docs/install.md`](docs/install.md).

## Packaged App (macOS)

Install (Apple Silicon or Intel — the script picks the right build, verifies
its checksum, and installs to /Applications):

```bash
curl -fsSL https://raw.githubusercontent.com/docuzen/docuzen/main/install.sh | sh
```

This also installs a `docuzen` command:

- `docuzen` — launch the app (`docuzen open ./file.md` opens a document)
- `docuzen update` — upgrade to the latest release
- `docuzen uninstall` — remove the app (prompts before deleting `~/.docuzen`)
- `docuzen doctor` — check the install and configured harness

Builds are unsigned until code signing lands; the installer clears the
macOS 15+ Gatekeeper quarantine for you. Prefer a manual download? Grab a
`.dmg` from [Releases](https://github.com/docuzen/docuzen/releases) and run
`xattr -cr /Applications/docuzen.app` after copying it in.

## What You Can Do

- Open `.md`, `.markdown`, `.html`, and `.htm` files.
- Highlight text or add comments directly on Markdown or rendered HTML.
- Promote comments into agent discussions with neutral, critiquer, or supporter
  stances.
- Ask the agent to propose edits, run a document-wide review, or resolve inline
  `[[ ... ]]` directives.
- Save snapshots, restore prior versions, and export/import `.hadz` bundles.
- Configure per-document model, tool scope, direct/proposed edit mode, standing
  instructions, and web search provider in `File -> Settings...`.

## Repository Layout

- `apps/desktop` - Tauri v2 app, Vite frontend, and dev launcher.
- `packages/docd` - TypeScript sidecar server, `.had` storage, agent runner, RPC,
  and tests.

## Common Commands

```bash
# Install all workspaces
npm install

# Build all workspaces (docd + CLI + desktop frontend)
npm run build

# Link the checkout so `docuzen` is on PATH
npm link

# Run every workspace test suite that has a test script
npm test

# Desktop app: Vite only
cd apps/desktop && npm run dev

# Desktop app: sidecar + Vite + Tauri window
cd apps/desktop && npm run tauri dev

# Desktop app tests
cd apps/desktop && npm test

# Sidecar tests
cd packages/docd && npm test

# Sidecar only, useful for debugging WebSocket/RPC behavior
cd packages/docd && npm run dev:server -- --port 8137

# Build/package the desktop app for the current platform
cd apps/desktop && npm run tauri build
```

## Current Limitations

- The development launcher always opens the bundled sample document first. Use
  `File -> Open...` after launch for your own docs.
- `tauri build` produces a self-contained app (the docd sidecar ships inside it
  with a pinned Node runtime); release artifacts are published to GitHub
  Releases but remain unsigned until code signing lands.
- Live agent use depends on pi and `~/.pi/agent/models.json`; a missing default
  model causes the sidecar to fail fast when `LLM_API_KEY` is set.
- Web search defaults to DuckDuckGo's Instant Answer API, which is keyless but
  not a general full-web search engine. Brave and Tavily need API keys.
