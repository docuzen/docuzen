import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { hadPaths } from "./paths.js";
import { updateJsonFile, withDocLock, writeDocument } from "./io.js";
import { isHtmlDoc } from "./doc-format.js";
import { documentBody, replaceBody } from "./frontmatter.js";
import { ensureDocuzenHidden } from "./hide.js";
import { readManifest, writeManifest, initManifest, contentHash } from "./manifest.js";
import { highestAnnotationSeq, readAnnotations } from "./annotations.js";
import { readThread } from "./thread.js";
import { snapshot, readVersion, readVersionAnnotations } from "./versions.js";
import type { Annotation, AnnotationsFile } from "./types.js";

export interface OpenDocResult {
  text: string;
  format: "markdown" | "html";
  annotations: Array<Annotation & { body?: string; parent?: string }>;
}

/**
 * Open a document: ensure its sidecar manifest exists, strip frontmatter for
 * markdown display, and enrich each comment annotation with its first turn's
 * body and branch lineage (see openDoc case history — the UI must not infer
 * branches from matching anchor text). Opening never mutates the document:
 * the sidecar is located by the path resolver, not a frontmatter pointer.
 */
export async function openDoc(docPath: string): Promise<OpenDocResult> {
  ensureDocuzenHidden();
  const isHtml = isHtmlDoc(docPath);
  // Under the document lock: a save landing between reading the doc and writing its
  // manifest would otherwise leave a hash of the text it replaced.
  await withDocLock(docPath, async () => {
    if ((await readManifest(docPath)) === null) {
      await writeManifest(docPath, await initManifest(docPath));
    }
  });
  const raw = await readFile(docPath, "utf8");
  // For markdown, strip frontmatter (it's metadata, not editor content);
  // for HTML, return it raw (the webview converts it for display).
  const text = documentBody(raw, docPath);
  const format = isHtml ? "html" : "markdown";
  const annotations = (await readAnnotations(docPath)).annotations;
  const withBodies = await Promise.all(
    annotations.map(async (a) => {
      if (a.type !== "comment") return a;
      try {
        const thread = await readThread(docPath, a.id);
        // Human comments show their first "you" turn; agent-review findings have
        // no "you" turn, so fall back to the first agent turn (the finding note).
        const note =
          thread.turns.find((t) => t.role === "you") ??
          thread.turns.find((t) => t.role === "agent");
        return {
          ...a,
          ...(note ? { body: note.body } : {}),
          ...(thread.frontmatter.parent ? { parent: thread.frontmatter.parent } : {}),
        };
      } catch {
        return a; // no thread file yet
      }
    }),
  );
  return { text, annotations: withBodies, format };
}

/** Save the editor's body back to disk, preserving frontmatter, and snapshot a version. */
export async function saveDoc(
  docPath: string,
  text: string,
  now: string,
): Promise<{ saved: boolean; version: string }> {
  return withDocLock(docPath, async () => {
    // HTML is written verbatim (no YAML frontmatter); markdown keeps whatever precedes
    // the body on disk (frontmatter the user put there themselves, a BOM) byte for byte.
    const full = isHtmlDoc(docPath) ? text : replaceBody(await readFile(docPath, "utf8"), docPath, text);
    await writeDocument(docPath, full);
    await writeManifest(docPath, {
      version: 1,
      doc: basename(docPath),
      contentHash: contentHash(full),
    });
    const v = await snapshot(docPath, full, { cause: "manual-save", at: now });
    return { saved: true, version: v.id };
  });
}

/** Restore a past version as the live doc, preserving the pre-restore state as a new version. */
export async function restoreVersion(
  docPath: string,
  versionId: string,
  now: string,
): Promise<{ restored: boolean; version: string }> {
  return withDocLock(docPath, async () => {
    // Read (and check) everything being restored before changing anything.
    const content = await readVersion(docPath, versionId);
    // undefined: a version snapshotted before annotation-versioning, which captured no
    // annotations → leave the live annotations.json untouched. "": the document had no
    // annotations file at that version → restore "no annotations".
    const captured = await readVersionAnnotations(docPath, versionId);
    const restored: AnnotationsFile | undefined =
      captured === undefined
        ? undefined
        : captured === ""
          ? { version: 1, annotations: [] }
          : (JSON.parse(captured) as AnnotationsFile);

    // Preserve the current doc so a restore never loses work.
    const current = await readFile(docPath, "utf8");
    await snapshot(docPath, current, { cause: "manual-save", at: now });
    await writeDocument(docPath, content);
    await writeManifest(docPath, {
      version: 1,
      doc: basename(docPath),
      contentHash: contentHash(content),
    });
    if (restored) {
      // Ids are never reused (see AnnotationsFile.lastSeq): the restored file must not take
      // the high-water mark back to what it was at that version, or the next new comment
      // would get the id of one made since — and inherit its thread, proposals and tasks.
      await updateJsonFile<AnnotationsFile>(hadPaths(docPath).annotations, () => ({ version: 1, annotations: [] }), (live) => ({
        next: { ...restored, lastSeq: Math.max(highestAnnotationSeq(live), highestAnnotationSeq(restored)) },
        result: undefined,
      }));
    }
    return { restored: true, version: versionId };
  });
}
