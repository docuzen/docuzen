import { rm } from "node:fs/promises";
import type { Annotation, AnnotationsFile, AnnotationType } from "./types.js";
import { hadPaths } from "./paths.js";
import { readJsonFile, updateJsonFile, withFileLock, writeJsonFile } from "./io.js";

const empty = (): AnnotationsFile => ({ version: 1, annotations: [] });

export async function readAnnotations(docPath: string): Promise<AnnotationsFile> {
  return readJsonFile(hadPaths(docPath).annotations, empty);
}

/** Replace the whole annotations file (atomic, serialized with every other writer). */
export async function writeAnnotations(docPath: string, f: AnnotationsFile): Promise<void> {
  const path = hadPaths(docPath).annotations;
  await withFileLock(path, () => writeJsonFile(path, f));
}

export async function addAnnotation(docPath: string, a: Annotation): Promise<void> {
  await updateJsonFile(hadPaths(docPath).annotations, empty, (f) => {
    f.annotations.push(a);
    return { next: f, result: undefined };
  });
}

export async function updateAnnotation(
  docPath: string,
  id: string,
  patch: Partial<Omit<Annotation, "id">>,
): Promise<void> {
  await updateJsonFile(hadPaths(docPath).annotations, empty, (f) => {
    const idx = f.annotations.findIndex((a) => a.id === id);
    if (idx === -1) throw new Error(`annotation not found: ${id}`);
    f.annotations[idx] = { ...f.annotations[idx], ...patch };
    return { next: f, result: undefined };
  });
}

/** Remove an annotation by id. No-op if it doesn't exist. */
export async function removeAnnotation(docPath: string, id: string): Promise<void> {
  await updateJsonFile(hadPaths(docPath).annotations, empty, (f) => {
    const next = f.annotations.filter((a) => a.id !== id);
    if (next.length === f.annotations.length) return { result: undefined };
    // Remember the high-water mark before the id disappears from the list (files written
    // before lastSeq existed don't carry one), so the deleted id is never handed out again.
    const lastSeq = Number(/^c(\d+)$/.exec(nextAnnotationId(f.annotations, f.lastSeq))![1]) - 1;
    return { next: { ...f, annotations: next, lastSeq }, result: undefined };
  });
}

/** Next sequential annotation id ("c0001", "c0002", …) given the existing ones. */
export function nextAnnotationId(existing: Annotation[], lastSeq = 0): string {
  let max = lastSeq;
  for (const a of existing) {
    const m = /^c(\d+)$/.exec(a.id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `c${String(max + 1).padStart(4, "0")}`;
}

/**
 * Allocate the next sequential id and append the annotation `build` makes for it, as ONE
 * locked step. Allocating outside the lock (read ids, then add) lets two concurrent
 * creations pick the same id — the second then overwrites the first one's thread file.
 */
export async function appendAnnotation(
  docPath: string,
  build: (id: string) => Annotation,
): Promise<Annotation> {
  return updateJsonFile(hadPaths(docPath).annotations, empty, (f) => {
    const annotation = build(nextAnnotationId(f.annotations, f.lastSeq));
    f.annotations.push(annotation);
    const seq = /^c(\d+)$/.exec(annotation.id);
    if (seq) f.lastSeq = Number(seq[1]);
    return { next: f, result: annotation };
  });
}

export interface CreateAnnotationInput {
  kind: AnnotationType;
  anchor: Annotation["anchor"];
  color?: string;
  author?: string;
}

export interface CreateAnnotationDeps {
  /** ISO timestamp; injected by callers (no Date.now in the pure core). */
  now: string;
  /** System user name; falls back to "you" when neither this nor input.author is set. */
  defaultAuthor?: string;
}

/** Build a new annotation with a sequential id and persist it. */
export async function createAnnotation(
  docPath: string,
  input: CreateAnnotationInput,
  deps: CreateAnnotationDeps,
): Promise<Annotation> {
  return appendAnnotation(docPath, (id) => ({
    id,
    type: input.kind,
    anchor: input.anchor,
    status: "open",
    thread: `threads/${id}.md`,
    session: `sessions/${id}.session.jsonl`,
    createdAt: deps.now,
    ...(input.color ? { color: input.color } : {}),
    author: input.author ?? deps.defaultAuthor ?? "you",
  }));
}

/** Remove an annotation and its thread/session files. No-op on missing files. */
export async function deleteAnnotation(docPath: string, id: string): Promise<void> {
  await removeAnnotation(docPath, id);
  const paths = hadPaths(docPath);
  await rm(paths.threadFile(id), { force: true });
  await rm(paths.sessionFile(id), { force: true });
}
