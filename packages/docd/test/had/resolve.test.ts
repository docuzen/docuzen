import { describe, expect, test } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveHadDir } from "../../src/had/resolve.js";

function tmp(): string { return mkdtempSync(join(tmpdir(), "resolve-")); }

describe("resolveHadDir", () => {
  test("doc in a git repo -> <root>/.docuzen/<relpath>.had", () => {
    const root = tmp();
    mkdirSync(join(root, ".git"));
    mkdirSync(join(root, "docs"));
    const doc = join(root, "docs", "plan.md");
    writeFileSync(doc, "# plan\n");
    expect(resolveHadDir(doc)).toBe(join(root, ".docuzen", "docs", "plan.md.had"));
  });

  test("doc at repo root -> <root>/.docuzen/<basename>.had", () => {
    const root = tmp();
    mkdirSync(join(root, ".git"));
    const doc = join(root, "readme.md");
    writeFileSync(doc, "# r\n");
    expect(resolveHadDir(doc)).toBe(join(root, ".docuzen", "readme.md.had"));
  });

  test("worktree: .git is a FILE, still detected", () => {
    const root = tmp();
    writeFileSync(join(root, ".git"), "gitdir: /elsewhere/.git/worktrees/x\n");
    const doc = join(root, "plan.md");
    writeFileSync(doc, "# p\n");
    expect(resolveHadDir(doc)).toBe(join(root, ".docuzen", "plan.md.had"));
  });

  test("no git repo -> <doc-dir>/.docuzen/<basename>.had", () => {
    const dir = tmp();
    const doc = join(dir, "loose.md");
    writeFileSync(doc, "# l\n");
    expect(resolveHadDir(doc)).toBe(join(dir, ".docuzen", "loose.md.had"));
  });

  test("path with spaces", () => {
    const root = tmp();
    mkdirSync(join(root, ".git"));
    mkdirSync(join(root, "my docs"));
    const doc = join(root, "my docs", "a b.md");
    writeFileSync(doc, "x\n");
    expect(resolveHadDir(doc)).toBe(join(root, ".docuzen", "my docs", "a b.md.had"));
  });
});
