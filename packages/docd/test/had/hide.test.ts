import { afterEach, describe, expect, test } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ensureDocuzenHidden } from "../../src/had/hide.js";

afterEach(() => { delete process.env.DOCUZEN_GIT_EXCLUDES_FILE; });

function excludesPath(): string {
  const p = join(mkdtempSync(join(tmpdir(), "excl-")), "nested", "ignore");
  process.env.DOCUZEN_GIT_EXCLUDES_FILE = p;
  return p;
}

describe("ensureDocuzenHidden", () => {
  test("creates the excludes file (and parents) with .docuzen/ when absent", () => {
    const p = excludesPath();
    ensureDocuzenHidden();
    expect(existsSync(p)).toBe(true);
    expect(readFileSync(p, "utf8")).toContain(".docuzen/");
  });

  test("is idempotent — no duplicate line on repeated calls", () => {
    const p = excludesPath();
    ensureDocuzenHidden();
    ensureDocuzenHidden();
    const lines = readFileSync(p, "utf8").split("\n").filter((l) => l.trim() === ".docuzen/");
    expect(lines.length).toBe(1);
  });

  test("preserves existing content and appends once", () => {
    const p = excludesPath();
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, "*.log\nbuild/\n");
    ensureDocuzenHidden();
    const out = readFileSync(p, "utf8");
    expect(out).toContain("*.log");
    expect(out).toContain(".docuzen/");
  });

  test("does not re-add when already present", () => {
    const p = excludesPath();
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, ".docuzen/\n");
    ensureDocuzenHidden();
    expect(readFileSync(p, "utf8")).toBe(".docuzen/\n");
  });
});

describe("which excludes file it falls back to (L9)", () => {
  test("with no global setting it uses the system one, never the current repo's local config", async () => {
    const { vi } = await import("vitest");
    const { execFileSync } = await import("node:child_process");
    const root = mkdtempSync(join(tmpdir(), "hide-l9-"));
    const repo = join(root, "repo");
    mkdirSync(repo);
    execFileSync("git", ["init", "-q", repo]);
    const local = join(root, "local-ignore");
    execFileSync("git", ["-C", repo, "config", "core.excludesFile", local]);
    const globalCfg = join(root, "global.gitconfig");
    writeFileSync(globalCfg, "");
    const systemCfg = join(root, "system.gitconfig");
    const system = join(root, "system-ignore");
    writeFileSync(systemCfg, `[core]\n\texcludesFile = ${system}\n`);

    const saved = { ...process.env };
    const cwd = process.cwd();
    try {
      delete process.env.DOCUZEN_GIT_EXCLUDES_FILE;
      process.env.GIT_CONFIG_GLOBAL = globalCfg;
      process.env.GIT_CONFIG_SYSTEM = systemCfg;
      delete process.env.GIT_CONFIG_NOSYSTEM;
      process.chdir(repo);
      vi.resetModules();
      const fresh = await import("../../src/had/hide.js");
      fresh.ensureDocuzenHidden();
      expect(existsSync(local)).toBe(false);
      expect(readFileSync(system, "utf8")).toContain(".docuzen/");
    } finally {
      process.chdir(cwd);
      for (const k of ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_NOSYSTEM", "DOCUZEN_GIT_EXCLUDES_FILE"]) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  });
});
