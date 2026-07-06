# docuzen — Developer Setup

This guide covers running docuzen from source and configuring it. For what
docuzen is, see the [README](../README.md); for the packaged macOS app and its
`docuzen` CLI, see the README's [Install (macOS)](../README.md#install-macos)
section. The rest of this guide covers running docuzen from a clone of this
repository.

## Prerequisites

docuzen needs Node.js, the Rust toolchain, and Tauri v2's native system
dependencies. Install them in the order below, then verify with
`node --version` and `cargo --version` (or `docuzen doctor` once linked).

### 1. Node.js 20+ and npm

Any install method works:

```bash
# macOS (Homebrew)
brew install node
```

Or download an installer from <https://nodejs.org>, or use a version manager
such as `nvm` or `fnm`.

### 2. Rust and Cargo

Tauri builds the native shell with Rust. Install the toolchain with the
official `rustup` installer (macOS and Linux):

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

On Windows, download and run `rustup-init.exe` from <https://rustup.rs>.

After installing, restart your shell (or run `source "$HOME/.cargo/env"`) so
`cargo` is on your `PATH`. Without this, `tauri dev` fails immediately with
`failed to run 'cargo metadata' ... No such file or directory`.

### 3. Native system dependencies

**macOS** — Xcode Command Line Tools:

```bash
xcode-select --install
```

**Debian/Ubuntu:**

```bash
sudo apt update
sudo apt install libwebkit2gtk-4.1-dev \
  build-essential \
  curl \
  wget \
  file \
  libxdo-dev \
  libssl-dev \
  libayatana-appindicator3-dev \
  librsvg2-dev
```

**Windows** — install the [Microsoft C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)
with the "Desktop development with C++" workload. WebView2 is preinstalled on
Windows 10 (1803+) and Windows 11.

For other Linux distributions (Arch, Fedora, Alpine, ...), follow the official
[Tauri v2 prerequisites](https://v2.tauri.app/start/prerequisites/).

### 4. Optional: a pi-compatible model setup for agents

docuzen's live runner uses `@earendil-works/pi-coding-agent` and pi's model
registry at `~/.pi/agent/models.json`. See
[Model and Agent Configuration](#model-and-agent-configuration) below.

You can run the UI without a model key. In that mode the sidecar uses
`FakePiRunner`, opens documents, and persists review state, but live agent
discussion is disabled.

## Clone and Install

```bash
git clone <repo-url> docuzen
cd docuzen
npm install
npm run build
npm link
```

This installs the root npm workspaces:

- `apps/desktop`
- `packages/cli`
- `packages/docd`

After `npm link`, the local checkout exposes a `docuzen` command:

```bash
docuzen
docuzen open ./path/to/document.md
docuzen doctor
docuzen update
```

Current CLI status:

- `docuzen` / `docuzen open <file>` launches the Tauri desktop app from this checkout.
- `docuzen doctor` checks the local checkout, Node, Cargo, and common agent env.
- `docuzen update` prints the linked-checkout update steps (it does not
  self-update a linked checkout).

This linked CLI is the developer flow and is not published to npm. The packaged
app installs its own `docuzen` CLI — see the
[README](../README.md#install-macos).

## Model and Agent Configuration

The sidecar picks its runner at startup:

- If `LLM_API_KEY` is set (dev-mode override), it starts the live `PiRunner`
  with `LLM_PROVIDER`/`LLM_MODEL`, regardless of app config.
- Otherwise, if `~/.docuzen/config.toml` selects the `pi` harness and its
  `model` resolves to an entry with a stored API key in
  `~/.pi/agent/models.json`, it starts the live `PiRunner`.
- Otherwise it starts `FakePiRunner` and logs that Discuss is disabled.

On first launch with no configured harness, the app shows a one-time setup
modal that writes `~/.docuzen/config.toml`:

```toml
[harness]
default = "pi"              # or "codex"

[pi]
model = "litellm/gpt-5.5"   # key into ~/.pi/agent/models.json

[codex]
# command = "/path/to/codex"  # optional binary path override
```

The live runner resolves models from `~/.pi/agent/models.json`, not directly
from `LLM_API_KEY`. The default provider/model are:

- `LLM_PROVIDER=litellm`
- `LLM_MODEL=gpt-5.5`

So, for the default live launch, `~/.pi/agent/models.json` must contain a
`litellm` provider with a `gpt-5.5` model. You can create or edit this file
through `File -> Settings...` in the app, or write it directly:

```json
{
  "providers": {
    "litellm": {
      "api": "openai-completions",
      "baseUrl": "https://your-model-gateway.example.com/v1",
      "apiKey": "YOUR_API_KEY",
      "models": [
        {
          "id": "gpt-5.5",
          "name": "GPT-5.5",
          "reasoningEffort": "medium"
        }
      ]
    }
  }
}
```

Then expose a non-empty `LLM_API_KEY` before launch. The dev launcher sources
`~/.secrets` automatically, so this is convenient:

```bash
cat >> ~/.secrets <<'EOF'
export LLM_API_KEY="YOUR_API_KEY"
export LLM_PROVIDER="litellm"
export LLM_MODEL="gpt-5.5"
EOF
```

You can also pass environment variables inline:

```bash
cd apps/desktop
LLM_API_KEY="$YOUR_API_KEY" LLM_PROVIDER=litellm LLM_MODEL=gpt-5.5 npm run tauri dev
```

Useful environment variables:

| Variable | Used by | Default | Notes |
| --- | --- | --- | --- |
| `LLM_API_KEY` | `packages/docd/src/server/main.ts` | unset | Dev-mode override: forces the live `PiRunner` regardless of `~/.docuzen/config.toml`. |
| `DOCUZEN_CONFIG_DIR` | sidecar | `~/.docuzen` | Overrides the app-config directory (`config.toml`); used by tests. |
| `LLM_PROVIDER` | sidecar | `litellm` | Provider key in `~/.pi/agent/models.json`. |
| `LLM_MODEL` | sidecar/dev launcher | `gpt-5.5` | Model id under the provider. |
| `LLM_BASE_URL` | sidecar (legacy) | unset | Legacy passthrough; the current live runner resolves `baseUrl` from `~/.pi/agent/models.json`. |
| `DOCD_PORT` | dev launcher | `8137` | Fixed sidecar port passed to Vite. |
| `DOCUZEN_AUTHOR` | sidecar | OS username | Author name for human comments/turns. |
| `BRAVE_API_KEY` | web search | unset | Required only when Brave search is selected. |
| `TAVILY_API_KEY` | web search | unset | Required only when Tavily search is selected. |
| `TAURI_DEV_HOST` | Vite/Tauri dev | unset | Use only for non-local dev host/HMR setups. |

## Run in Development

From `apps/desktop`:

```bash
npm run tauri dev
```

Or, after linking from the repo root:

```bash
docuzen open ./apps/desktop/sample/plan-rate-limiting.md
```

This uses the Tauri config:

- `beforeDevCommand`: `npm run dev:all`
- `devUrl`: `http://localhost:1420`

`npm run dev:all` starts two child processes:

- `npx tsx watch packages/docd/src/server/main.ts --port ${DOCD_PORT:-8137}`
- `npx vite` in `apps/desktop`

It injects these frontend variables:

- `VITE_DOCD_PORT=${DOCD_PORT:-8137}`
- `VITE_DOC_PATH=apps/desktop/sample/plan-rate-limiting.md`

When launched through the CLI, `DOCUZEN_DOC_PATH=<file>` overrides the sample
document path before `tauri dev` starts.

The sample document opens automatically. Use `File -> Open...` (`Cmd/Ctrl+O`)
to open your own document — Markdown (`.md`, `.markdown`), HTML (`.html`,
`.htm`), or docuzen bundles (`.hadz`).

## Per-Document Settings

Settings are stored in `settings.json` inside the document's `.docuzen/`
review-state directory and travel with a `.hadz` export.

Available settings:

- **Default model.** Uses a `provider/modelId` key from `~/.pi/agent/models.json`.
- **Agent tool scope.** `folder` limits file tools to the document folder and
  its `.docuzen/` review state; `repo` walks up to the nearest `.git` root.
- **Edit mode.** `propose` is the default and asks the agent to propose a diff
  that you approve/reject. `direct` allows the agent to edit the document file
  directly and snapshots before/after.
- **Standing instructions.** Persistent guidance injected into every agent turn
  for that document.
- **Web search.** Enabled by default with DuckDuckGo; Brave and Tavily are
  opt-in providers.

## Web Search

Agent web search is enabled per document by default:

- `ddg` uses DuckDuckGo Instant Answer and does not require a key.
- `brave` uses Brave Search and requires `BRAVE_API_KEY`.
- `tavily` uses Tavily Search and requires `TAVILY_API_KEY`.

Keys are read from the sidecar process environment and are not stored in the
document's `.docuzen/` review state.

If you change Brave/Tavily environment variables while the app is running,
restart `tauri dev` so the sidecar sees the new environment.

## Build and Package

Build the frontend only:

```bash
cd apps/desktop
npm run build
```

Build all workspaces from the repository root:

```bash
npm run build
```

This currently builds:

- `packages/docd` TypeScript output to `packages/docd/dist`
- `packages/cli` TypeScript output to `packages/cli/dist`
- `apps/desktop` frontend bundle

Build/package the Tauri app for the current platform:

```bash
cd apps/desktop
npm run tauri build
```

The configured bundle targets are `"all"` in `apps/desktop/src-tauri/tauri.conf.json`.
The Rust/Tauri output is under `apps/desktop/src-tauri/target/`.

The packaged app is self-contained: `tauri build` bundles the docd sidecar as
`Resources/sidecar/` (a pinned Node binary, an esbuild-bundled `main.cjs`, and
the matching `better_sqlite3.node`). The Rust shell spawns it on a free port,
injects the port into the webview, logs to `~/.docuzen/logs/docd.log`, and
kills it on quit. Sidecar runtime pinning lives in `packages/docd/sidecar.json`;
`npm run sidecar:smoke --workspace @ai-native-doc/docd` verifies the artifact
end-to-end without a GUI.

On first launch the packaged app asks you to pick an agent harness (Pi or
Codex CLI) and stores the choice in `~/.docuzen/config.toml`; until then it
runs offline. `LLM_API_KEY` remains a dev-mode override that forces the live
Pi runner regardless of config.

## Lightweight Verification

Useful checks while setting up:

```bash
# Shows all available workspace scripts
npm run
npm run --workspace desktop
npm run --workspace @ai-native-doc/docd

# Runs workspace test suites
npm test

# Checks the desktop TypeScript/Vite build
cd apps/desktop && npm run build

# Checks the linked CLI build
npm run build --workspace docuzen
docuzen doctor
```

The full Tauri build can take longer because Rust dependencies compile on the
first run.

## Troubleshooting

### `failed to run 'cargo metadata' ... No such file or directory (os error 2)`

`tauri dev` shells out to `cargo` as its first step, and the OS could not find
the `cargo` executable. Either Rust is not installed, or `~/.cargo/bin` is not
on `PATH` in the shell that launched the app.

The `docuzen` CLI pre-checks for cargo and prints install instructions instead;
this raw error appears when running `npm run tauri dev` directly.

- Not installed: follow [Prerequisites](#2-rust-and-cargo), then restart your
  shell.
- Installed but not found: run `source "$HOME/.cargo/env"` or restart the
  terminal so the rustup PATH entry takes effect.
- `docuzen doctor` reports this as `✗ cargo: not found`.

### `open failed: ... was compiled against a different Node.js version using NODE_MODULE_VERSION ...`

The app window opens and connects, but opening any document fails. The sidecar
uses `better-sqlite3`, a native module compiled for a specific Node ABI. After
upgrading Node, the previously compiled binary no longer matches, and
`npm install` does not rebuild it as long as the lockfile is satisfied.

Fix by rebuilding against the current Node, then restart the app:

```bash
npm rebuild better-sqlite3
```

### `docd connection FAILED @ ws://127.0.0.1:8137`

The frontend cannot reach the sidecar.

- Start through `cd apps/desktop && npm run tauri dev`, not plain `npm run dev`.
- If you changed `DOCD_PORT`, restart the full Tauri dev process so Vite receives
  the matching `VITE_DOCD_PORT`.
- Make sure nothing else is using port `8137`, or run with another port:

```bash
cd apps/desktop
DOCD_PORT=8140 npm run tauri dev
```

### Vite says port `1420` is already in use

Tauri expects a fixed Vite dev URL. Stop the other process using port `1420` and
rerun `npm run tauri dev`.

### `pi model litellm/gpt-5.5 not found`

`LLM_API_KEY` is set, so the sidecar selected the live `PiRunner`, but the
default provider/model is missing from `~/.pi/agent/models.json`.

Fix by adding that model in `File -> Settings...`, writing `models.json`
directly, or starting with matching environment variables:

```bash
cd apps/desktop
LLM_PROVIDER=my-provider LLM_MODEL=my-model npm run tauri dev
```

### Discuss is disabled

The sidecar started without a usable harness and is using `FakePiRunner`.
Configure one in the first-launch setup modal (writes `~/.docuzen/config.toml`),
make sure the chosen pi model has an API key in `~/.pi/agent/models.json`, or
export `LLM_API_KEY` as a dev-mode override (e.g. via `~/.secrets`). Then
restart the app. The sidecar logs the exact reason it stayed offline — in dev
on the terminal, packaged in `~/.docuzen/logs/docd.log`.

### Brave or Tavily search errors

If the document setting selects Brave or Tavily, the sidecar must have
`BRAVE_API_KEY` or `TAVILY_API_KEY` in its environment. Add the key and restart
the app. DuckDuckGo does not need a key.

### Native menu shortcuts do not appear to work

Use the Tauri window, not the browser-only Vite tab. If shortcuts still look
stale after pulling changes to the Rust menu, fully quit and relaunch
`npm run tauri dev`; a webview reload is not always enough for native menu
changes.

### HTML edits did not save

For HTML documents, click `Edit`, make changes, click `Done`, then use
`File -> Save`. The HTML body is serialized from the iframe only when saving or
switching tabs.

### Review state looks wrong

Each document's review state lives under the nearest `.docuzen/` root at
`<relpath>.had/`. Export a `.hadz` bundle when you want to move a document
between machines with its annotations, threads, settings, and versions.
