import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import matter from "gray-matter";
import { openDoc, saveDoc, restoreVersion } from "../../src/had/doc-store.js";
import { hadPaths } from "../../src/had/paths.js";
import { readManifest } from "../../src/had/manifest.js";
import { addAnnotation, readAnnotations } from "../../src/had/annotations.js";
import { writeThread } from "../../src/had/thread.js";
import { listVersions, readVersion } from "../../src/had/versions.js";
import { readPointer } from "../../src/had/pointer.js";

let dir: string;
let docPath: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "doc-store-"));
  docPath = join(dir, "plan.md");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("openDoc", () => {
  it("adds the had pointer and initializes the manifest on first open", async () => {
    await writeFile(docPath, "# Plan\n\nBody text.\n", "utf8");
    expect(await readManifest(docPath)).toBeNull();

    const res = await openDoc(docPath);

    expect(await readPointer(docPath)).toBe(".plan.md.had/");
    const manifest = await readManifest(docPath);
    expect(manifest).not.toBeNull();
    expect(manifest!.doc).toBe("plan.md");
    expect(res.format).toBe("markdown");
  });

  it("does not overwrite an existing manifest on a later open", async () => {
    await writeFile(docPath, "# Plan\n", "utf8");
    await openDoc(docPath);
    const first = await readManifest(docPath);
    await writeFile(docPath, "# Plan\n\nEdited outside saveDoc.\n".replace("Plan", "Plan"), "utf8");
    // Re-open: manifest already exists, so it must be left untouched (no re-hash).
    await openDoc(docPath);
    expect(await readManifest(docPath)).toEqual(first);
  });

  it("strips had frontmatter from the returned markdown body", async () => {
    await writeFile(docPath, "# Plan\n\nBody text.\n", "utf8");
    const res = await openDoc(docPath);
    expect(res.text).not.toContain("had:");
    expect(res.text).toContain("Body text.");
  });

  it("returns HTML raw with format html, leaving the file untouched", async () => {
    const htmlPath = join(dir, "report.html");
    const html = "<h1>Report</h1>\n<p>Latency is high.</p>\n";
    await writeFile(htmlPath, html, "utf8");
    const res = await openDoc(htmlPath);
    expect(res.format).toBe("html");
    expect(res.text).toBe(html);
    expect(await readFile(htmlPath, "utf8")).toBe(html);
    // no had: pointer for html (no YAML in HTML), but the manifest is still initialized
    expect(await readManifest(htmlPath)).not.toBeNull();
  });

  it("attaches a comment annotation's first you/agent turn body and branch parent", async () => {
    await writeFile(docPath, "# Plan\n\nRedis is used here.\n", "utf8");
    await addAnnotation(docPath, {
      id: "c0001",
      type: "comment",
      anchor: { exact: "Redis", prefix: "", suffix: "" },
      status: "open",
      thread: "threads/c0001.md",
      session: "sessions/c0001.session.jsonl",
      createdAt: "2026-06-12T10:00:00.000Z",
    });
    await writeThread(docPath, {
      frontmatter: {
        id: "c0001",
        anchorExact: "Redis",
        stance: "none",
        status: "open",
        piSession: "sessions/c0001.session.jsonl",
        parent: "c0000",
      },
      turns: [{ role: "you", timestamp: "t1", body: "Why Redis?" }],
    });

    const res = await openDoc(docPath);
    const ann = res.annotations.find((a) => a.id === "c0001");
    expect(ann?.body).toBe("Why Redis?");
    expect(ann?.parent).toBe("c0000");
  });

  it("leaves a comment annotation without a thread file unenriched (no throw)", async () => {
    await writeFile(docPath, "# Plan\n\nRedis is used here.\n", "utf8");
    await addAnnotation(docPath, {
      id: "c0001",
      type: "comment",
      anchor: { exact: "Redis", prefix: "", suffix: "" },
      status: "open",
      thread: "threads/c0001.md",
      session: "sessions/c0001.session.jsonl",
      createdAt: "2026-06-12T10:00:00.000Z",
    });
    const res = await openDoc(docPath);
    const ann = res.annotations.find((a) => a.id === "c0001");
    expect(ann?.body).toBeUndefined();
  });
});

describe("saveDoc", () => {
  it("writes the body back, preserving frontmatter data, and snapshots a manual-save version", async () => {
    await writeFile(docPath, "---\nhad: .plan.md.had/\n---\n# Original\n", "utf8");
    const res = await saveDoc(docPath, "# Edited Plan\n\nNew body.\n", "2026-06-12T10:00:05.000Z");
    expect(res.saved).toBe(true);

    const onDisk = await readFile(docPath, "utf8");
    expect(onDisk).toContain("# Edited Plan");
    const parsed = matter(onDisk);
    expect(parsed.data.had).toBe(".plan.md.had/"); // frontmatter preserved

    const manifest = await readManifest(docPath);
    expect(manifest!.contentHash).toBeTruthy();

    const versions = await listVersions(docPath);
    expect(versions.some((v) => v.id === res.version && v.cause === "manual-save")).toBe(true);
  });

  it("writes HTML verbatim without injecting frontmatter", async () => {
    const htmlPath = join(dir, "report.html");
    await writeFile(htmlPath, "<h1>Old</h1>\n", "utf8");
    const res = await saveDoc(htmlPath, "<h1>New</h1>\n", "t1");
    expect(res.saved).toBe(true);
    expect(await readFile(htmlPath, "utf8")).toBe("<h1>New</h1>\n");
  });
});

describe("restoreVersion", () => {
  it("restores a past version's content, preserving current state as a new version", async () => {
    await mkdir(hadPaths(docPath).dir, { recursive: true });
    await writeFile(docPath, "# v1\n", "utf8");
    const v1 = await saveDoc(docPath, "# v1\n", "t1");
    // Mutate the live doc without going through saveDoc, so restoreVersion's
    // preservation snapshot is the only thing capturing this content.
    await writeFile(docPath, "# v2 unsaved\n", "utf8");

    const res = await restoreVersion(docPath, v1.version, "t3");
    expect(res.restored).toBe(true);
    expect(await readFile(docPath, "utf8")).toContain("v1");

    // the pre-restore (unsaved v2) state was preserved as its own version, nothing lost
    const versions = await listVersions(docPath);
    expect(versions.length).toBeGreaterThanOrEqual(2);
    expect(await readVersion(docPath, v1.version)).toContain("v1");
  });

  it("restores the annotations captured at that version", async () => {
    await writeFile(docPath, "# Plan\n\nRedis.\n", "utf8");
    await addAnnotation(docPath, {
      id: "c0001",
      type: "comment",
      anchor: { exact: "Redis", prefix: "", suffix: "" },
      status: "open",
      thread: "threads/c0001.md",
      session: "sessions/c0001.session.jsonl",
      createdAt: "t0",
    });
    const withComment = await saveDoc(docPath, "with comment", "t1");
    // delete the annotation, save again (new version has none captured)
    await import("../../src/had/annotations.js").then(({ writeAnnotations }) =>
      writeAnnotations(docPath, { version: 1, annotations: [] }),
    );
    await saveDoc(docPath, "no comment", "t2");
    expect((await readAnnotations(docPath)).annotations).toHaveLength(0);

    await restoreVersion(docPath, withComment.version, "t3");
    const after = await readAnnotations(docPath);
    expect(after.annotations.map((a) => a.id)).toContain("c0001");
  });

  it("leaves live annotations untouched when the restored version has none captured (legacy version)", async () => {
    await writeFile(docPath, "# Plan\n", "utf8");
    const v1 = await saveDoc(docPath, "# Plan\n", "t1");
    // simulate a legacy version with no per-version annotations file
    await rm(hadPaths(docPath).versionAnnotationsFile(v1.version), { force: true });
    await addAnnotation(docPath, {
      id: "c0001",
      type: "comment",
      anchor: { exact: "Plan", prefix: "", suffix: "" },
      status: "open",
      thread: "threads/c0001.md",
      session: "sessions/c0001.session.jsonl",
      createdAt: "t0",
    });

    await restoreVersion(docPath, v1.version, "t2");
    const after = await readAnnotations(docPath);
    expect(after.annotations.map((a) => a.id)).toContain("c0001"); // untouched
  });
});
