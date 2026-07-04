import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSettings, writeSettings } from "../../src/had/settings.js";
import { hadPaths } from "../../src/had/paths.js";

let dir: string;
let docPath: string;
let configDir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "had-set-"));
  docPath = join(dir, "plan.md");
  await writeFile(docPath, "# Plan\n", "utf8");
  // Isolate from the real ~/.docuzen/config.toml so tests are hermetic
  configDir = mkdtempSync(join(tmpdir(), "docd-cfg-"));
  process.env.DOCUZEN_CONFIG_DIR = configDir;
});
afterEach(async () => {
  delete process.env.DOCUZEN_CONFIG_DIR;
  rmSync(configDir, { recursive: true, force: true });
  await rm(dir, { recursive: true, force: true });
});

describe("settings", () => {
  it("defaults scope to the document folder + propose mode + keyless web search when none saved", async () => {
    expect(await readSettings(docPath)).toEqual({
      scope: "folder",
      harness: "pi",
      agentEdit: "propose",
      webSearch: { enabled: true, provider: "ddg" },
    });
  });

  it("round-trips saved settings (web-search default merged in)", async () => {
    await writeSettings(docPath, { scope: "repo", model: "gpt-5.5", agentEdit: "direct" });
    expect(await readSettings(docPath)).toEqual({
      scope: "repo",
      harness: "pi",
      model: "gpt-5.5",
      agentEdit: "direct",
      webSearch: { enabled: true, provider: "ddg" },
    });
  });

  it("round-trips a harness override", async () => {
    await writeSettings(docPath, { scope: "folder", harness: "codex" });
    expect((await readSettings(docPath)).harness).toBe("codex");
  });

  it("round-trips an explicit web-search override", async () => {
    await writeSettings(docPath, { scope: "folder", webSearch: { enabled: true, provider: "brave" } });
    expect((await readSettings(docPath)).webSearch).toEqual({ enabled: true, provider: "brave" });
  });

  it("merges over defaults", async () => {
    await writeSettings(docPath, { scope: "repo" });
    const s = await readSettings(docPath);
    expect(s.scope).toBe("repo");
  });
});

describe("settings — harness default from app config", () => {
  it("fresh doc harness defaults to 'pi' when no config.toml exists", async () => {
    // configDir is empty (no config.toml), set by the outer beforeEach
    const s = await readSettings(docPath);
    expect(s.harness).toBe("pi");
  });

  it("fresh doc harness reads 'codex' when app config sets [harness] default = codex", async () => {
    writeFileSync(join(configDir, "config.toml"), '[harness]\ndefault = "codex"\n', "utf8");
    const s = await readSettings(docPath);
    expect(s.harness).toBe("codex");
  });

  it("explicit harness in the doc settings file overrides app config default", async () => {
    writeFileSync(join(configDir, "config.toml"), '[harness]\ndefault = "codex"\n', "utf8");
    await writeSettings(docPath, { scope: "folder", harness: "pi" });
    const s = await readSettings(docPath);
    expect(s.harness).toBe("pi");
  });
});
