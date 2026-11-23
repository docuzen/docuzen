#!/usr/bin/env node
// End-to-end smoke test of the assembled sidecar artifact: spawn it with the
// BUNDLED node (not the dev machine's) the way the app shell does (a launch token
// in DOCD_TOKEN), wait for the DOCD_PORT line, check a client without the token is
// refused, make one RPC call over WebSocket, exit 0 on success. Hermetic: HOME is a temp dir and
// LLM_API_KEY is cleared. The temp HOME carries a pi model with a (dummy) stored
// key, so the sidecar must construct a REAL PiRunner — proving the pi SDK loads
// and initialises inside the CJS bundle under the pinned Node, not just that the
// server starts. No model call is made.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dir = resolve(process.cwd(), process.argv[2] ?? resolve(pkgDir, "dist-sidecar/bundle"));

const home = mkdtempSync(join(tmpdir(), "sidecar-smoke-home-"));
mkdirSync(join(home, ".pi", "agent"), { recursive: true });
mkdirSync(join(home, ".docuzen"), { recursive: true });
writeFileSync(
  join(home, ".pi", "agent", "models.json"),
  JSON.stringify({
    providers: {
      smoke: { api: "openai-completions", baseUrl: "http://127.0.0.1:9/v1", apiKey: "smoke", models: [{ id: "m" }] },
    },
  }),
);
writeFileSync(join(home, ".docuzen", "config.toml"), '[harness]\ndefault = "pi"\n\n[pi]\nmodel = "smoke/m"\n');

const token = randomBytes(32).toString("hex");
const env = {
  ...process.env,
  LLM_API_KEY: "",
  DOCD_NATIVE_BINDING: join(dir, "better_sqlite3.node"),
  DOCD_TOKEN: token,
  HOME: home,
};
delete env.DOCUZEN_CONFIG_DIR;
delete env.PI_CODING_AGENT_DIR;
const child = spawn(join(dir, "node"), [join(dir, "main.cjs"), "--port", "0"], { env });

// Generous: an x64 artifact smoke-tested on an arm64 runner runs under Rosetta, whose
// first launch translates the whole ~110 MB node binary before a line of JS runs. A
// native start takes well under a second.
const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS ?? 180_000);
const startedAt = Date.now();
const timeout = setTimeout(
  () => fail(`timed out after ${TIMEOUT_MS / 1000}s waiting for DOCD_PORT\nstdout so far:\n${out || "(none)"}`),
  TIMEOUT_MS,
);

let finished = false;
function fail(msg) {
  if (finished) return;
  finished = true;
  console.error(`smoke FAILED: ${msg}`);
  child.kill();
  process.exit(1);
}

let out = "";
let probed = false;
child.stdout.on("data", (d) => {
  out += String(d);
  // A whole line: a chunk boundary inside the number must not yield a truncated port.
  const m = out.match(/^DOCD_PORT=(\d+)\r?\n/m);
  if (m && !probed) {
    probed = true;
    // The app shell passes the token, so it must never be echoed (stdout goes to docd.log).
    if (out.includes("DOCD_TOKEN=")) fail(`sidecar printed the launch token it was given\n${out}`);
    else void probe(Number(m[1]));
  }
});
child.stderr.on("data", (d) => process.stderr.write(d));
// Any exit before the probe passed is a failure — a crash, a clean exit, or a signal —
// reported now rather than after the start timeout.
child.on("exit", (code, signal) => fail(`sidecar exited early (${signal ?? `code ${code}`})\n${out}`));

/** "open", or the HTTP status a WebSocket upgrade to `url` was refused with. */
function upgradeOutcome(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.on("open", () => {
      ws.close();
      resolve("open");
    });
    ws.on("unexpected-response", (_req, res) => {
      res.resume();
      resolve(res.statusCode);
    });
    ws.on("error", reject);
  });
}

async function probe(port) {
  const anonymous = await upgradeOutcome(`ws://127.0.0.1:${port}`).catch((e) => e.message);
  if (anonymous !== 401) return fail(`a client without the launch token got ${anonymous}, expected 401`);
  const ws = new WebSocket(`ws://127.0.0.1:${port}/?token=${token}`);
  ws.on("open", () => ws.send(JSON.stringify({ id: "smoke-1", method: "listHarnesses", params: {} })));
  ws.on("message", (data) => {
    const res = JSON.parse(String(data));
    if (res.id !== "smoke-1") return; // ignore streaming event frames
    clearTimeout(timeout);
    if (!res.ok) fail(res.error);
    const pi = res.result.find((h) => h.id === "pi");
    if (!pi?.available) {
      fail(`pi harness did not come up inside the bundle: ${pi?.unavailableReason ?? "not registered"}\n${out}`);
    }
    finished = true;
    child.kill();
    console.log(
      `smoke OK: listHarnesses -> ${res.result.length} harnesses on :${port}, pi live, unauthenticated client refused (${((Date.now() - startedAt) / 1000).toFixed(1)}s)`,
    );
    process.exit(0);
  });
  ws.on("error", (e) => fail(e.message));
}
