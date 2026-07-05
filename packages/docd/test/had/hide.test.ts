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
