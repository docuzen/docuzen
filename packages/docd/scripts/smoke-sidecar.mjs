#!/usr/bin/env node
// End-to-end smoke test of the assembled sidecar artifact: spawn it with the
// BUNDLED node (not the dev machine's), wait for the DOCD_PORT line, make one
// RPC call over WebSocket, exit 0 on success. Hermetic: HOME is a temp dir
// and LLM_API_KEY is cleared, so the offline FakePiRunner always answers.
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dir = resolve(process.cwd(), process.argv[2] ?? resolve(pkgDir, "dist-sidecar/bundle"));

const child = spawn(join(dir, "node"), [join(dir, "main.cjs"), "--port", "0"], {
  env: {
    ...process.env,
    LLM_API_KEY: "",
    DOCD_NATIVE_BINDING: join(dir, "better_sqlite3.node"),
    HOME: mkdtempSync(join(tmpdir(), "sidecar-smoke-home-")),
  },
});

const timeout = setTimeout(() => fail("timed out waiting for DOCD_PORT"), 15_000);

function fail(msg) {
  console.error(`smoke FAILED: ${msg}`);
  child.kill();
  process.exit(1);
}

let out = "";
let probed = false;
child.stdout.on("data", (d) => {
  out += String(d);
  const m = out.match(/DOCD_PORT=(\d+)/);
  if (m && !probed) {
    probed = true;
    probe(Number(m[1]));
  }
});
child.stderr.on("data", (d) => process.stderr.write(d));
child.on("exit", (code) => {
  if (code !== null && code !== 0) fail(`sidecar exited with ${code}\n${out}`);
});

function probe(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  ws.on("open", () => ws.send(JSON.stringify({ id: "smoke-1", method: "listHarnesses", params: {} })));
  ws.on("message", (data) => {
    const res = JSON.parse(String(data));
    if (res.id !== "smoke-1") return; // ignore streaming event frames
    clearTimeout(timeout);
    child.kill();
    if (res.ok) {
      console.log(`smoke OK: listHarnesses -> ${res.result.length} harnesses on :${port}`);
      process.exit(0);
    }
    fail(res.error);
  });
  ws.on("error", (e) => fail(e.message));
}
