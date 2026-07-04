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
