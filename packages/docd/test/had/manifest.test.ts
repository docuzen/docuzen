import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  contentHash,
  readManifest,
  writeManifest,
  initManifest,
} from "../../src/had/manifest.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "had-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("contentHash", () => {
  it("is stable sha256 hex of the bytes", () => {
    expect(contentHash("hello")).toBe(contentHash("hello"));
    expect(contentHash("a")).not.toBe(contentHash("b"));
    expect(contentHash("hello")).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("manifest read/write", () => {
  it("round-trips a manifest through disk", async () => {
    const docPath = join(dir, "plan.md");
    await writeFile(docPath, "# Plan\n", "utf8");
    const m = await initManifest(docPath);
    expect(m.version).toBe(1);
    expect(m.doc).toBe("plan.md");
    expect(m.contentHash).toBe(contentHash("# Plan\n"));

    await writeManifest(docPath, m);
    const back = await readManifest(docPath);
    expect(back).toEqual(m);
  });

  it("returns null when no manifest exists", async () => {
    const docPath = join(dir, "missing.md");
    expect(await readManifest(docPath)).toBeNull();
  });
});
