import { describe, expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const cliPath = resolve(here, "..", "dist", "cli.js");

function runCli(args: string[], pathValue: string) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    encoding: "utf8",
    env: { ...process.env, PATH: pathValue },
  });
}

function makeShim(dir: string, name: string, script: string): void {
  const file = join(dir, name);
  writeFileSync(file, `#!/bin/sh\n${script}\n`);
  chmodSync(file, 0o755);
}

describe("launch preflight", () => {
  test("fails with install instructions when cargo is not on PATH", () => {
    const emptyDir = mkdtempSync(join(tmpdir(), "docuzen-nopath-"));
    const res = runCli(["open", "somefile.md"], emptyDir);

    expect(res.status).toBe(1);
    expect(res.stderr).toContain("cargo");
    expect(res.stderr).toContain("docs/install.md");
  });

  test("proceeds to npm when cargo is available", () => {
    const binDir = mkdtempSync(join(tmpdir(), "docuzen-shims-"));
    makeShim(binDir, "cargo", 'echo "cargo 1.0.0 (shim)"');
    makeShim(binDir, "npm", 'echo "NPM_INVOKED $@"');
    const res = runCli(["open", "somefile.md"], `${binDir}:/usr/bin:/bin`);

    expect(res.stderr).not.toContain("docs/install.md");
    expect(res.stdout).toContain("NPM_INVOKED");
    expect(res.status).toBe(0);
  });
});

describe("doctor", () => {
  test("reports a missing node instead of crashing, and fails", () => {
    const binDir = mkdtempSync(join(tmpdir(), "docuzen-doctor-"));
    makeShim(binDir, "cargo", 'echo "cargo 1.0.0 (shim)"');
    const res = runCli(["doctor"], binDir); // no node on PATH (the CLI itself runs on process.execPath)

    expect(res.stderr).not.toContain("TypeError");
    expect(res.stdout).toContain("✗ node: not found");
    expect(res.status).toBe(1);
  });

  test("fails when cargo is missing", () => {
    const binDir = mkdtempSync(join(tmpdir(), "docuzen-doctor-"));
    makeShim(binDir, "node", 'echo "v22.0.0"');
    const res = runCli(["doctor"], binDir);

    expect(res.stdout).toContain("✓ node: v22.0.0");
    expect(res.stdout).toContain("✗ cargo: not found");
    expect(res.status).toBe(1);
  });

  test("fails when node is on PATH but broken", () => {
    const binDir = mkdtempSync(join(tmpdir(), "docuzen-doctor-"));
    makeShim(binDir, "node", "exit 3");
    makeShim(binDir, "cargo", 'echo "cargo 1.0.0 (shim)"');
    const res = runCli(["doctor"], binDir);

    expect(res.stdout).toContain("✗ node");
    expect(res.status).toBe(1);
  });

  test("passes when everything is there", () => {
    const binDir = mkdtempSync(join(tmpdir(), "docuzen-doctor-"));
    makeShim(binDir, "node", 'echo "v22.0.0"');
    makeShim(binDir, "cargo", 'echo "cargo 1.0.0 (shim)"');
    const res = runCli(["doctor"], binDir);

    expect(res.stdout).toContain("✓ node: v22.0.0");
    expect(res.stdout).toContain("✓ cargo: cargo 1.0.0 (shim)");
    expect(res.status).toBe(0);
  });
});
