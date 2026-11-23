// smoke-sidecar.mjs against fake bundles: whatever goes wrong must fail the smoke at once and
// say why — not after the 180 s start timeout, and never by probing a half-read port.
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const script = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "scripts", "smoke-sidecar.mjs");

/** A bundle dir whose `node` runs `body` instead of the sidecar. */
function fakeBundle(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "smoke-fake-"));
  writeFileSync(join(dir, "node"), `#!/bin/sh\n${body}\n`);
  chmodSync(join(dir, "node"), 0o755);
  return dir;
}

function smoke(dir: string) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [script, dir], {
    encoding: "utf8",
    env: { ...process.env, SMOKE_TIMEOUT_MS: "20000" },
    timeout: 30_000,
  });
  return { status: r.status, stderr: r.stderr, ms: Date.now() - t0 };
}

describe("smoke-sidecar.mjs", () => {
  it("fails at once when the sidecar exits cleanly before reporting a port", () => {
    const r = smoke(fakeBundle("exit 0"));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("exited early (code 0)");
    expect(r.ms).toBeLessThan(10_000);
  }, 40_000);

  it("fails at once when the sidecar dies from a signal", () => {
    const r = smoke(fakeBundle("kill -9 $$"));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("exited early (SIGKILL)");
    expect(r.ms).toBeLessThan(10_000);
  }, 40_000);

  it("reads the whole port line, even when it arrives in pieces", () => {
    // Nothing listens on 9: the probe's error names the port it actually tried.
    const r = smoke(fakeBundle("printf 'DOCD_PORT=1'; sleep 0.5; printf '9\\n'; sleep 30"));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("127.0.0.1:19");
    expect(r.stderr).not.toMatch(/127\.0\.0\.1:1\b(?!9)/);
  }, 40_000);
});
