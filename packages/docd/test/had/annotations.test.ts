import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readAnnotations,
  addAnnotation,
  updateAnnotation,
  removeAnnotation,
} from "../../src/had/annotations.js";
import type { Annotation } from "../../src/had/types.js";

let dir: string;
let docPath: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "had-"));
  docPath = join(dir, "plan.md");
  await writeFile(docPath, "# Plan\n", "utf8");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const sample: Annotation = {
  id: "c0001",
  type: "comment",
  anchor: { exact: "Plan", prefix: "# ", suffix: "\n" },
  status: "open",
  thread: "threads/c0001.md",
  session: "sessions/c0001.session.jsonl",
  createdAt: "2026-06-12T10:00:00.000Z",
};

describe("annotations index", () => {
  it("returns an empty file when none exists", async () => {
    const f = await readAnnotations(docPath);
    expect(f).toEqual({ version: 1, annotations: [] });
  });

  it("adds then reads back an annotation", async () => {
    await addAnnotation(docPath, sample);
    const f = await readAnnotations(docPath);
    expect(f.annotations).toHaveLength(1);
    expect(f.annotations[0]).toEqual(sample);
  });

  it("updates an existing annotation by id", async () => {
    await addAnnotation(docPath, sample);
    await updateAnnotation(docPath, "c0001", { status: "orphaned" });
    const f = await readAnnotations(docPath);
    expect(f.annotations[0].status).toBe("orphaned");
  });

  it("throws when updating a missing id", async () => {
    await expect(
      updateAnnotation(docPath, "nope", { status: "resolved" }),
    ).rejects.toThrow(/nope/);
  });

  it("removes an annotation by id", async () => {
    await addAnnotation(docPath, sample);
    await addAnnotation(docPath, { ...sample, id: "c0002" });
    await removeAnnotation(docPath, "c0001");
    const f = await readAnnotations(docPath);
    expect(f.annotations.map((a) => a.id)).toEqual(["c0002"]);
  });

  it("removeAnnotation is a no-op for a missing id", async () => {
    await addAnnotation(docPath, sample);
    await removeAnnotation(docPath, "nope");
    expect((await readAnnotations(docPath)).annotations).toHaveLength(1);
  });
});
