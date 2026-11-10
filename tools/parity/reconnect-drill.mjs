// Reconnect drill: boot app, kill sidecar, assert amber status, restart sidecar,
// assert green + a working RPC (search still returns counts) — all without reload.
//
//   node tools/parity/reconnect-drill.mjs
//
// Self-contained: stages the sample doc into a temp dir, starts the sidecar on a
// fixed port (so the respawned one lands where the frontend reconnects), and
// starts its own Vite dev server — nothing has to be running beforehand.
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { mkdtemp, copyFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const WT = new URL("../..", import.meta.url).pathname;
// A stub app config so the first-run harness modal never covers the UI (it would
// intercept the clicks below on a machine with no ~/.docuzen/config.toml). The pi
// harness stays offline (no model), which is fine: the drill makes no agent calls.
const configDir = await mkdtemp(join(tmpdir(), "reconnect-drill-config-"));
await writeFile(join(configDir, "config.toml"), "[harness]\ndefault = \"pi\"\n");
const SIDECAR_PORT = 8337;
const VITE_PORT = 4600; // distinct from parity (4501/4502), visual (4610), demo (4620)

function startSidecar() {
  const child = spawn("npx", ["tsx", "packages/docd/src/server/main.ts", "--port", String(SIDECAR_PORT)],
    { cwd: WT, env: { ...process.env, LLM_API_KEY: "", DOCUZEN_CONFIG_DIR: configDir }, stdio: ["ignore", "pipe", "inherit"], detached: true });
  return new Promise((res, rej) => {
    let buf = "";
    child.stdout.on("data", d => { buf += d; if (buf.includes("DOCD_PORT=")) res(child); });
    child.on("exit", c => rej(new Error("sidecar died " + c)));
    setTimeout(() => rej(new Error("sidecar start timeout")), 20000);
  });
}

async function waitForHttp(url, timeoutMs = 30_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try { const r = await fetch(url); if (r.ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timeout waiting for ${url}`);
}

async function startVite(docPath) {
  const child = spawn("npx", ["vite", "--port", String(VITE_PORT), "--strictPort"], {
    cwd: join(WT, "apps/desktop"),
    env: { ...process.env, VITE_DOCD_PORT: String(SIDECAR_PORT), VITE_DOC_PATH: docPath, TAURI_DEV_HOST: "127.0.0.1" },
    stdio: ["ignore", "ignore", "inherit"],
    detached: true,
  });
  await waitForHttp(`http://127.0.0.1:${VITE_PORT}/`);
  return child;
}

function killGroup(child, signal) {
  try { process.kill(-child.pid, signal); } catch { /* already gone */ }
}

const stageDir = await mkdtemp(join(tmpdir(), "reconnect-drill-"));
const docPath = join(stageDir, "plan-rate-limiting.md");
await copyFile(join(WT, "apps/desktop/sample/plan-rate-limiting.md"), docPath);

let sidecar = await startSidecar();
const vite = await startVite(docPath);
const browser = await chromium.launch();
try {
  const page = await (await browser.newContext()).newPage();
  await page.goto(`http://127.0.0.1:${VITE_PORT}/?docdPort=${SIDECAR_PORT}`);
  await page.waitForFunction(() => (document.querySelector("#log")?.textContent ?? "").includes("editor mounted"), null, { timeout: 20000 });
  // Docname readiness comes from the active tab label (the topbar's separate
  // `#docname` subtitle was removed as redundant with the tab strip).
  await page.waitForFunction(() => {
    const el = document.querySelector("#tabs .tab.active .tname");
    return !!el && el.textContent !== "";
  }, null, { timeout: 15000 });
  const status = () => page.locator("#connStatus").innerText();
  console.log("boot status:", await status());

  killGroup(sidecar, "SIGKILL"); // group-kill: npx wraps the real server
  await page.waitForFunction(() => /reconnect/i.test(document.querySelector("#connStatus")?.textContent ?? ""), null, { timeout: 15000 });
  console.log("after kill:", await status());

  sidecar = await startSidecar();
  await page.waitForFunction(() => !/reconnect|disconnect/i.test(document.querySelector("#connStatus")?.textContent ?? ""), null, { timeout: 20000 });
  console.log("after restart:", await status());

  // prove RPC works post-reconnect without reload: open search and get a real count
  await page.locator("#searchBtn").click();
  await page.locator("#searchInput").fill("the");
  await page.waitForFunction(() => {
    const c = document.querySelector("#searchCount")?.textContent ?? "";
    return c !== "Type to search" && c.trim() !== "";
  }, null, { timeout: 10000 });
  console.log("post-reconnect search count:", await page.locator("#searchCount").textContent());
  console.log("DRILL OK");
} finally {
  await browser.close();
  killGroup(sidecar, "SIGTERM");
  killGroup(vite, "SIGTERM");
  await rm(stageDir, { recursive: true, force: true });
  await rm(configDir, { recursive: true, force: true });
}
