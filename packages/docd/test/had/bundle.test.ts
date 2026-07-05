import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import AdmZip from "adm-zip";
import { exportHadz, importHadz } from "../../src/had/bundle.js";
import { resolveHadDir } from "../../src/had/resolve.js";
import { openDoc, saveDoc } from "../../src/had/doc-store.js";
import { readManifest } from "../../src/had/manifest.js";
import { addAnnotation, readAnnotations } from "../../src/had/annotations.js";
import { initThread, appendTurn, readThread } from "../../src/had/thread.js";
import { listVersions, readVersion } from "../../src/had/versions.js";

let dir: string;
let docPath: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "bundle-"));
  docPath = join(dir, "plan.md");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Give the doc a realistic `.had` sidecar: pointer + manifest, a comment thread, and two saved versions. */
async function seedDocWithHadState(): Promise<void> {
  await writeFile(docPath, "# Plan\n\nRedis is used here.\n", "utf8");
  await openDoc(docPath); // ensures the had: pointer + initial manifest
  await addAnnotation(docPath, {
    id: "c0001",
    type: "comment",
    anchor: { exact: "Redis", prefix: "", suffix: " is used here." },
    status: "open",
    thread: "threads/c0001.md",
    session: "sessions/c0001.session.jsonl",
    createdAt: "2026-06-12T10:00:00.000Z",
  });
  await initThread(docPath, {
    id: "c0001",
    anchorExact: "Redis",
    stance: "none",
    status: "open",
    piSession: "sessions/c0001.session.jsonl",
  });
  await appendTurn(docPath, "c0001", { role: "you", timestamp: "t1", body: "Why Redis?" });
  await saveDoc(docPath, "# Plan\n\nRedis is used here for caching.\n", "2026-06-12T10:00:05.000Z");
}

describe("exportHadz / importHadz round-trip", () => {
  it("packs the doc + .had sidecar and unpacks into a fresh dir with doc, annotations, thread, and versions intact", async () => {
    await seedDocWithHadState();

    const { path: hadzPath } = await exportHadz(docPath);
    expect(hadzPath).toBe(`${docPath}.hadz`);
    expect(existsSync(hadzPath)).toBe(true);

    const destDir = await mkdtemp(join(tmpdir(), "bundle-import-"));
    try {
      const { docPath: importedDocPath } = await importHadz(hadzPath, destDir);
      expect(basename(importedDocPath)).toBe("plan.md");

      // the imported state physically lands at the resolver's `.docuzen/` location
      // (fresh dir, no .git -> <unpacked-dir>/.docuzen/<basename>.had), never as a
      // legacy sibling sidecar
      const importedHadDir = resolveHadDir(importedDocPath);
      expect(importedHadDir).toBe(join(destDir, ".docuzen", "plan.md.had"));
      expect(existsSync(importedHadDir)).toBe(true);
      expect(existsSync(join(destDir, ".plan.md.had"))).toBe(false);
      expect(existsSync(join(destDir, "plan.md.had"))).toBe(false);

      // the document itself survives verbatim, including its had: frontmatter pointer
      const originalDoc = await readFile(docPath, "utf8");
      const importedDoc = await readFile(importedDocPath, "utf8");
      expect(importedDoc).toBe(originalDoc);
      expect(importedDoc).toContain("Redis is used here for caching.");

      // the manifest survives
      expect(await readManifest(importedDocPath)).toEqual(await readManifest(docPath));

      // the annotation and its thread turn survive
      const importedAnnotations = await readAnnotations(importedDocPath);
      expect(importedAnnotations.annotations.map((a) => a.id)).toEqual(["c0001"]);
      const importedThread = await readThread(importedDocPath, "c0001");
      expect(importedThread.turns[0]).toMatchObject({ role: "you", body: "Why Redis?" });

      // the full version history survives with matching content per version
      const originalVersions = await listVersions(docPath);
      const importedVersions = await listVersions(importedDocPath);
      expect(importedVersions.map((v) => v.id)).toEqual(originalVersions.map((v) => v.id));
      for (const v of importedVersions) {
        expect(await readVersion(importedDocPath, v.id)).toBe(await readVersion(docPath, v.id));
      }
    } finally {
      await rm(destDir, { recursive: true, force: true });
    }
  });

  it("writes to a custom outPath when given one", async () => {
    await seedDocWithHadState();
    const customPath = join(dir, "custom-bundle.hadz");

    const { path: hadzPath } = await exportHadz(docPath, { outPath: customPath });

    expect(hadzPath).toBe(customPath);
    expect(existsSync(customPath)).toBe(true);
    expect(existsSync(`${docPath}.hadz`)).toBe(false);
  });

  it("bundles a past version's doc content (not the live doc) when versionId is given, while the .had history still travels whole", async () => {
    await writeFile(docPath, "# v1\n", "utf8");
    await openDoc(docPath);
    const v1 = await saveDoc(docPath, "# v1\n", "t1");
    const v1Content = await readVersion(docPath, v1.version); // includes the had: pointer saveDoc preserves
    await saveDoc(docPath, "# v2 live\n", "t2"); // live doc has since moved on to v2

    const { path: hadzPath } = await exportHadz(docPath, {
      versionId: v1.version,
      outPath: join(dir, "v1.hadz"),
    });

    const destDir = await mkdtemp(join(tmpdir(), "bundle-import-v1-"));
    try {
      const { docPath: importedDocPath } = await importHadz(hadzPath, destDir);
      const importedDoc = await readFile(importedDocPath, "utf8");
      expect(importedDoc).toBe(v1Content);
      expect(importedDoc).toContain("# v1");
      expect(importedDoc).not.toContain("v2 live");

      // the bundled .had folder still carries the FULL version history (v1 and v2),
      // even though the exported document itself is pinned to v1's content.
      const versions = await listVersions(importedDocPath);
      expect(versions.map((v) => v.id)).toContain(v1.version);
      expect(versions.length).toBeGreaterThanOrEqual(2);
      expect(await readVersion(importedDocPath, v1.version)).toBe(v1Content);
    } finally {
      await rm(destDir, { recursive: true, force: true });
    }
  });

  it("importHadz throws when the bundle has no root-level document entry", async () => {
    const zip = new AdmZip();
    zip.addFile(".plan.md.had/manifest.json", Buffer.from("{}", "utf8"));
    const badZipPath = join(dir, "broken.hadz");
    zip.writeZip(badZipPath);

    await expect(
      importHadz(badZipPath, join(dir, "broken-unpacked")),
    ).rejects.toThrow("no document found in .hadz bundle");
  });
});
