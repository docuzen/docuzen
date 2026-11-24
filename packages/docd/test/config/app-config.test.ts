import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { parse } from "smol-toml";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appConfigPath, readAppConfig, writeAppConfig } from "../../src/config/app-config.js";
import { createCodexHarness } from "../../src/agent/codex-runner.js";
import { acpAgentSpecs } from "../../src/agent/acp-agents.js";

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

  test("keeps sections and keys it does not manage", () => {
    writeFileSync(
      appConfigPath(),
      '[harness]\ndefault = "pi"\n\n[pi]\nmodel = "a/b"\nthinking = "high"\n\n[codex]\ncommand = "/bin/codex"\n\n[mine]\nkey = "kept"\n',
    );
    writeAppConfig({ harness: { default: "codex" }, pi: { model: "c/d" } });
    const raw = parse(readFileSync(appConfigPath(), "utf8")) as Record<string, Record<string, unknown>>;
    expect(raw.harness).toEqual({ default: "codex" });
    expect(raw.pi).toEqual({ model: "c/d", thinking: "high" });
    expect(raw.codex).toBeUndefined();
    expect(raw.mine).toEqual({ key: "kept" });
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

  test("[acp.<name>] tables become additional ACP harnesses", () => {
    writeFileSync(
      appConfigPath(),
      [
        "[acp.gemini]",
        'command = "gemini"',
        'args = ["--experimental-acp"]',
        'label = "Gemini CLI"',
        'read_only_mode = "default"',
        "[acp.gemini.env]",
        'GEMINI_API_KEY_FILE = "/k"',
        "",
        "[acp.goose]",
        'command = "goose"',
        'args = ["acp"]',
        "",
        "[acp.nocommand]",
        'label = "skipped: no command"',
        "",
        '[acp."bad name"]',
        'command = "x"',
        "",
      ].join("\n"),
    );
    const cfg = readAppConfig();
    expect(cfg.acp).toEqual({
      gemini: {
        command: "gemini",
        args: ["--experimental-acp"],
        label: "Gemini CLI",
        env: { GEMINI_API_KEY_FILE: "/k" },
        readOnlyMode: "default",
      },
      goose: { command: "goose", args: ["acp"] },
    });
    expect(acpAgentSpecs(cfg).map((a) => [a.id, a.label, a.command, a.readOnlyMode])).toEqual([
      ["acp:gemini", "Gemini CLI", "gemini", "default"],
      ["acp:goose", "goose", "goose", undefined],
    ]);
  });

  test("writing the config keeps the user's [acp.*] tables as written", () => {
    writeFileSync(appConfigPath(), '[acp.goose]\ncommand = "goose"\nargs = ["acp"]\n');
    writeAppConfig({ harness: { default: "pi" } });
    const raw = parse(readFileSync(appConfigPath(), "utf8")) as Record<string, unknown>;
    expect(raw.acp).toEqual({ goose: { command: "goose", args: ["acp"] } });
  });
});
