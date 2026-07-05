import { readFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import matter from "gray-matter";
import { hadPaths } from "./paths.js";
import { isHtmlDoc } from "./doc-format.js";
import { readManifest, writeManifest, initManifest, contentHash } from "./manifest.js";
import { readAnnotations } from "./annotations.js";
import { readThread } from "./thread.js";
import { snapshot, readVersion, readVersionAnnotations } from "./versions.js";
import type { Annotation } from "./types.js";

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
  const isHtml = isHtmlDoc(docPath);
  if ((await readManifest(docPath)) === null) {
    await writeManifest(docPath, await initManifest(docPath));
  }
  const raw = await readFile(docPath, "utf8");
  // For markdown, strip frontmatter (it's metadata, not editor content);
  // for HTML, return it raw (the webview converts it for display).
  const text = isHtml ? raw : matter(raw).content;
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
  // HTML is written verbatim (no YAML frontmatter); markdown preserves any
  // frontmatter the user put there themselves.
  let full: string;
  if (isHtmlDoc(docPath)) {
    full = text;
  } else {
    const raw = await readFile(docPath, "utf8");
    const data = matter(raw).data;
    full = matter.stringify(text, data);
  }
  await writeFile(docPath, full, "utf8");
  await writeManifest(docPath, {
    version: 1,
    doc: basename(docPath),
    contentHash: contentHash(full),
  });
  const v = await snapshot(docPath, full, { cause: "manual-save", at: now });
  return { saved: true, version: v.id };
}

/** Restore a past version as the live doc, preserving the pre-restore state as a new version. */
export async function restoreVersion(
  docPath: string,
  versionId: string,
  now: string,
): Promise<{ restored: boolean; version: string }> {
  // Preserve the current doc so a restore never loses work.
  const current = await readFile(docPath, "utf8");
  await snapshot(docPath, current, { cause: "manual-save", at: now });
  const content = await readVersion(docPath, versionId);
  await writeFile(docPath, content, "utf8");
  await writeManifest(docPath, {
    version: 1,
    doc: basename(docPath),
    contentHash: contentHash(content),
  });
  // Restore the annotations captured at that version. Old versions
  // (snapshotted before annotation-versioning) have no captured file →
  // leave the live annotations.json untouched.
  const versionAnnotations = await readVersionAnnotations(docPath, versionId);
  if (versionAnnotations !== "") {
    await writeFile(hadPaths(docPath).annotations, versionAnnotations, "utf8");
  }
  return { restored: true, version: versionId };
}
