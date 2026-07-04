import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import matter from "gray-matter";
import { ensurePointer, readPointer } from "../../src/had/pointer.js";

let dir: string;
let docPath: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "had-"));
  docPath = join(dir, "plan.md");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("ensurePointer", () => {
  it("adds had frontmatter to a doc that has none, preserving body", async () => {
    await writeFile(docPath, "# Plan\n\nBody text.\n", "utf8");
    await ensurePointer(docPath);
    const parsed = matter(await readFile(docPath, "utf8"));
    expect(parsed.data.had).toBe(".plan.md.had/");
    expect(parsed.content.trim()).toBe("# Plan\n\nBody text.");
  });

  it("merges into existing frontmatter without dropping keys", async () => {
    await writeFile(docPath, "---\ntitle: My Plan\n---\n\n# Plan\n", "utf8");
    await ensurePointer(docPath);
    const parsed = matter(await readFile(docPath, "utf8"));
    expect(parsed.data.title).toBe("My Plan");
    expect(parsed.data.had).toBe(".plan.md.had/");
  });

  it("is idempotent", async () => {
    await writeFile(docPath, "# Plan\n", "utf8");
    await ensurePointer(docPath);
    const once = await readFile(docPath, "utf8");
    await ensurePointer(docPath);
    expect(await readFile(docPath, "utf8")).toBe(once);
  });

  it("readPointer returns the had value or null", async () => {
    await writeFile(docPath, "# Plan\n", "utf8");
    expect(await readPointer(docPath)).toBeNull();
    await ensurePointer(docPath);
    expect(await readPointer(docPath)).toBe(".plan.md.had/");
  });
});
