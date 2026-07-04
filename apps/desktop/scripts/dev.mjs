// Dev launcher for `tauri dev`: starts the docd sidecar (fixed port) and Vite,
// injecting the sidecar port + the doc path into the webview via VITE_* env.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(here, "..");
const repoRoot = resolve(appDir, "..", "..");
const docPath = process.env.DOCUZEN_DOC_PATH
  ? resolve(process.env.DOCUZEN_DOC_PATH)
  : resolve(appDir, "sample", "plan-rate-limiting.md");
const PORT = process.env.DOCD_PORT ?? "8137";

const children = [];
function run(cmd, args, env) {
  const child = spawn(cmd, args, { stdio: "inherit", cwd: repoRoot, env: { ...process.env, ...env } });
  children.push(child);
  return child;
}

console.log(`[dev] sidecar on :${PORT}, doc = ${docPath}`);

// Source ~/.secrets (for LLM_API_KEY) then run the sidecar; the live runner
// resolves its model/baseUrl from ~/.pi/agent/models.json.
const mainPath = resolve(repoRoot, "packages/docd/src/server/main.ts");
// `tsx watch` reloads the sidecar whenever packages/docd source changes, so backend
// edits take effect without a manual restart (the frontend already hot-reloads via
// Vite). In-memory pi sessions reset on reload; reply()/improve() resume from the
// thread transcript, so a mid-conversation reload is non-destructive.
const sidecarCmd = `source ~/.secrets 2>/dev/null; exec npx tsx watch ${mainPath} --port ${PORT}`;
const sidecar = spawn("bash", ["-lc", sidecarCmd], {
  stdio: "inherit",
  cwd: repoRoot,
  env: {
    ...process.env,
    LLM_MODEL: process.env.LLM_MODEL ?? "gpt-5.5",
  },
});
children.push(sidecar);

const vite = spawn("npx", ["vite"], {
  stdio: "inherit",
  cwd: appDir,
  env: { ...process.env, VITE_DOCD_PORT: PORT, VITE_DOC_PATH: docPath },
});
children.push(vite);

function shutdown() {
  for (const c of children) c.kill();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
vite.on("exit", shutdown);
