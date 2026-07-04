#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");
const desktopDir = resolve(repoRoot, "apps", "desktop");
const sampleDoc = resolve(desktopDir, "sample", "plan-rate-limiting.md");

function usage(): void {
  console.log(`docuzen

Usage:
  docuzen                 Launch the desktop app (dev checkout)
  docuzen open <file>     Launch the desktop app with a document path
  docuzen dev [file]      Alias for launch in developer mode
  docuzen doctor          Check local setup
  docuzen update          Print update instructions (placeholder)
  docuzen help            Show this help

Current local-link flow:
  npm install
  npm run build
  npm link
  docuzen open ./document.md
`);
}

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv = {}): never {
  const res = spawnSync(cmd, args, {
    cwd: repoRoot,
    stdio: "inherit",
    env: { ...process.env, ...env },
  });
  process.exit(res.status ?? 1);
}

function cargoVersion(): string | null {
  const res = spawnSync("cargo", ["--version"], { encoding: "utf8" });
  return res.status === 0 ? res.stdout.trim() : null;
}

function launch(file?: string): never {
  if (!existsSync(desktopDir)) {
    console.error(`Cannot find desktop app at ${desktopDir}.`);
    console.error("This linked CLI currently expects to run from a Docuzen repository checkout.");
    process.exit(1);
  }
  if (cargoVersion() === null) {
    console.error("docuzen needs the Rust toolchain, but `cargo` was not found on PATH.");
    console.error("");
    console.error("Install it:   curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh");
    console.error('Then restart your terminal (or run: source "$HOME/.cargo/env") and retry.');
    console.error("");
    console.error("See docs/install.md (Prerequisites), or run `docuzen doctor` for a full check.");
    process.exit(1);
  }
  const docPath = file ? resolve(process.cwd(), file) : sampleDoc;
  run("npm", ["run", "tauri", "--workspace", "desktop", "--", "dev"], {
    DOCUZEN_DOC_PATH: docPath,
  });
}

function doctor(): void {
  const checks: [string, boolean, string][] = [
    ["repo root", existsSync(resolve(repoRoot, "package.json")), repoRoot],
    ["desktop app", existsSync(resolve(desktopDir, "package.json")), desktopDir],
    ["docd package", existsSync(resolve(repoRoot, "packages", "docd", "package.json")), "packages/docd"],
    ["sample doc", existsSync(sampleDoc), sampleDoc],
  ];
  let ok = true;
  for (const [label, pass, detail] of checks) {
    ok &&= pass;
    console.log(`${pass ? "✓" : "✗"} ${label}: ${detail}`);
  }
  const node = spawnSync("node", ["--version"], { encoding: "utf8" });
  console.log(`${node.status === 0 ? "✓" : "✗"} node: ${node.stdout.trim() || "not found"}`);
  const cargo = cargoVersion();
  console.log(`${cargo ? "✓" : "✗"} cargo: ${cargo ?? "not found"}`);
  if (!process.env.LLM_API_KEY) {
    console.log("! LLM_API_KEY is not set; the sidecar will use the offline fake runner.");
  }
  process.exit(ok ? 0 : 1);
}

function update(): void {
  console.log(`docuzen update is not automated yet.

For a linked checkout:
  git pull
  npm install
  npm run build
  npm link

For future packaged releases, this command will check npm/GitHub Releases and update the CLI/app.`);
}

const [cmd, arg] = process.argv.slice(2);
switch (cmd ?? "open") {
  case "open":
    launch(arg);
  case "dev":
    launch(arg);
  case "doctor":
    doctor();
    break;
  case "update":
    update();
    break;
  case "help":
  case "--help":
  case "-h":
    usage();
    break;
  default:
    console.error(`Unknown command: ${cmd}`);
    usage();
    process.exit(1);
}
