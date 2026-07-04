import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  snapshot,
  listVersions,
  readVersion,
  latestVersionId,
  readVersionAnnotations,
} from "../../src/had/versions.js";
import { writeAnnotations } from "../../src/had/annotations.js";

let dir: string;
let docPath: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "had-"));
  docPath = join(dir, "plan.md");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("version store", () => {
  it("assigns sequential zero-padded ids", async () => {
    const v1 = await snapshot(docPath, "# v1\n", {
      cause: "manual-save",
      at: "2026-06-12T10:00:00.000Z",
    });
    const v2 = await snapshot(docPath, "# v2\n", {
      cause: "agent-edit",
      thread: "c0001",
      at: "2026-06-12T10:01:00.000Z",
    });
    expect(v1.id).toBe("v0001");
    expect(v2.id).toBe("v0002");
  });

  it("stores full snapshot content and records cause", async () => {
    await snapshot(docPath, "# hello\n", {
      cause: "manual-save",
      at: "2026-06-12T10:00:00.000Z",
    });
    expect(await readVersion(docPath, "v0001")).toBe("# hello\n");
    const entries = await listVersions(docPath);
    expect(entries).toHaveLength(1);
    expect(entries[0].cause).toBe("manual-save");
    expect(entries[0].timestamp).toBe("2026-06-12T10:00:00.000Z");
  });

  it("threads the causing thread id through the index", async () => {
    await snapshot(docPath, "x", {
      cause: "agent-edit",
      thread: "c0002",
      at: "2026-06-12T10:00:00.000Z",
    });
    const entries = await listVersions(docPath);
    expect(entries[0].thread).toBe("c0002");
  });

  it("returns an empty list when no versions exist", async () => {
    expect(await listVersions(docPath)).toEqual([]);
  });

  it("returns the existing version id when content is unchanged (dedupe)", async () => {
    const a = await snapshot(docPath, "SAME\n", { cause: "manual-save", at: "t1" });
    const b = await snapshot(docPath, "SAME\n", { cause: "manual-save", at: "t2" });
    expect(b.id).toBe(a.id);
    expect(await listVersions(docPath)).toHaveLength(1);
  });

  it("writes a new version when content changes", async () => {
    const a = await snapshot(docPath, "ONE\n", { cause: "manual-save", at: "t1" });
    const b = await snapshot(docPath, "TWO\n", { cause: "manual-save", at: "t2" });
    expect(b.id).not.toBe(a.id);
    expect(await listVersions(docPath)).toHaveLength(2);
  });

  it("latestVersionId returns the most recent id, or null when none", async () => {
    expect(await latestVersionId(docPath)).toBeNull();
    const a = await snapshot(docPath, "X\n", { cause: "manual-save", at: "t1" });
    expect(await latestVersionId(docPath)).toBe(a.id);
  });

  it("captures the current annotations with each version", async () => {
    await writeAnnotations(docPath, { version: 1, annotations: [{ id: "c1", type: "comment", anchor: { exact: "x", prefix: "", suffix: "" }, status: "open", thread: "threads/c1.md", session: "s", createdAt: "t" }] } as any);
    const v = await snapshot(docPath, "DOC A\n", { cause: "manual-save", at: "t1" });
    expect(await readVersionAnnotations(docPath, v.id)).toContain("c1");
  });

  it("makes a NEW version when annotations change even if the doc text is identical", async () => {
    await writeAnnotations(docPath, { version: 1, annotations: [{ id: "c1", type: "comment", anchor: { exact: "x", prefix: "", suffix: "" }, status: "open", thread: "t", session: "s", createdAt: "t" }] } as any);
    const a = await snapshot(docPath, "SAME\n", { cause: "manual-save", at: "t1" });
    await writeAnnotations(docPath, { version: 1, annotations: [] } as any); // delete all comments, doc unchanged
    const b = await snapshot(docPath, "SAME\n", { cause: "manual-save", at: "t2" });
    expect(b.id).not.toBe(a.id);                              // not deduped — annotations differ
    expect(await readVersionAnnotations(docPath, b.id)).not.toContain("c1");
  });

  it("still dedupes when BOTH doc and annotations are unchanged", async () => {
    await writeAnnotations(docPath, { version: 1, annotations: [] } as any);
    const a = await snapshot(docPath, "SAME\n", { cause: "manual-save", at: "t1" });
    const b = await snapshot(docPath, "SAME\n", { cause: "manual-save", at: "t2" });
    expect(b.id).toBe(a.id);
  });
});
