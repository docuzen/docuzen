import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appConfigPath, readAppConfig, writeAppConfig } from "../../src/config/app-config.js";
import { createCodexHarness } from "../../src/agent/codex-runner.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "docuzen-config-"));
  process.env.DOCUZEN_CONFIG_DIR = dir;
});

afterEach(() => {
  delete process.env.DOCUZEN_CONFIG_DIR;
});

describe("app config", () => {
  test("path honors DOCUZEN_CONFIG_DIR", () => {
    expect(appConfigPath()).toBe(join(dir, "config.toml"));
  });

  test("missing file reads as unconfigured", () => {
    expect(readAppConfig()).toEqual({ harness: null });
  });

  test("write/read roundtrip", () => {
    writeAppConfig({ harness: { default: "pi" }, pi: { model: "litellm/gpt-5.5" } });
    const cfg = readAppConfig();
    expect(cfg.harness).toEqual({ default: "pi" });
    expect(cfg.pi).toEqual({ model: "litellm/gpt-5.5" });
  });

  test("codex harness roundtrip", () => {
    writeAppConfig({ harness: { default: "codex" } });
    expect(readAppConfig().harness).toEqual({ default: "codex" });
  });

  test("malformed toml reads as unconfigured, never throws", () => {
    writeFileSync(join(dir, "config.toml"), "not [valid toml ===", "utf8");
    expect(readAppConfig()).toEqual({ harness: null });
  });

  test("unknown harness value reads as unconfigured", () => {
    writeFileSync(join(dir, "config.toml"), '[harness]\ndefault = "gemini"\n', "utf8");
    expect(readAppConfig().harness).toBeNull();
  });

  test("non-string pi.model reads as absent, never crashes selectRunner downstream", () => {
    writeFileSync(join(dir, "config.toml"), '[harness]\ndefault = "pi"\n\n[pi]\nmodel = 42\n', "utf8");
    const cfg = readAppConfig();
    expect(cfg.harness).toEqual({ default: "pi" });
    expect(cfg.pi).toBeUndefined();
  });

  test("non-string codex.command reads as absent", () => {
    writeFileSync(join(dir, "config.toml"), '[harness]\ndefault = "codex"\n\n[codex]\ncommand = 3\n', "utf8");
    expect(readAppConfig().codex).toBeUndefined();
  });

  test("a blank codex.command reads as absent, so codex detection falls back to the default command", () => {
    const shims = mkdtempSync(join(tmpdir(), "docuzen-codex-shim-"));
    const shim = join(shims, "codex");
    writeFileSync(shim, '#!/bin/sh\necho "codex-cli 9.9.9"\n');
    chmodSync(shim, 0o755);
    const prevBin = process.env.CODEX_BIN;
    process.env.CODEX_BIN = shim; // stands in for `codex` on PATH
    try {
      for (const blank of ['""', '"   "']) {
        writeFileSync(join(dir, "config.toml"), `[harness]\ndefault = "codex"\n\n[codex]\ncommand = ${blank}\n`, "utf8");
        const cfg = readAppConfig();
        expect(cfg.codex, blank).toBeUndefined();
        // Before: detectCodexCli("") → spawnSync("") throws, and docd died at startup.
        const codex = createCodexHarness({ config: { ...cfg.codex } });
        expect(codex, blank).toMatchObject({ available: true, status: "codex-cli 9.9.9" });
      }
    } finally {
      if (prevBin === undefined) delete process.env.CODEX_BIN;
      else process.env.CODEX_BIN = prevBin;
    }
  });

  test("a blank pi.model reads as absent, and surrounding whitespace is trimmed", () => {
    writeFileSync(join(dir, "config.toml"), '[pi]\nmodel = "  "\n\n[codex]\ncommand = " /opt/codex "\n', "utf8");
    const cfg = readAppConfig();
    expect(cfg.pi).toBeUndefined();
    expect(cfg.codex).toEqual({ command: "/opt/codex" });
  });
});
