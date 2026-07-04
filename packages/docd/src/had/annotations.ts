import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import type { Annotation, AnnotationsFile, AnnotationType } from "./types.js";
import { hadPaths } from "./paths.js";

const EMPTY: AnnotationsFile = { version: 1, annotations: [] };

export async function readAnnotations(docPath: string): Promise<AnnotationsFile> {
  const p = hadPaths(docPath);
  try {
    const raw = await readFile(p.annotations, "utf8");
    return JSON.parse(raw) as AnnotationsFile;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT")
      return { version: EMPTY.version, annotations: [] };
    throw err;
  }
}

export async function writeAnnotations(
  docPath: string,
  f: AnnotationsFile,
): Promise<void> {
  const p = hadPaths(docPath);
  await mkdir(p.dir, { recursive: true });
  await writeFile(p.annotations, JSON.stringify(f, null, 2) + "\n", "utf8");
}

export async function addAnnotation(docPath: string, a: Annotation): Promise<void> {
  const f = await readAnnotations(docPath);
  f.annotations.push(a);
  await writeAnnotations(docPath, f);
}

export async function updateAnnotation(
  docPath: string,
  id: string,
  patch: Partial<Omit<Annotation, "id">>,
): Promise<void> {
  const f = await readAnnotations(docPath);
  const idx = f.annotations.findIndex((a) => a.id === id);
  if (idx === -1) throw new Error(`annotation not found: ${id}`);
  f.annotations[idx] = { ...f.annotations[idx], ...patch };
  await writeAnnotations(docPath, f);
}

/** Remove an annotation by id. No-op if it doesn't exist. */
export async function removeAnnotation(docPath: string, id: string): Promise<void> {
  const f = await readAnnotations(docPath);
  const next = f.annotations.filter((a) => a.id !== id);
  if (next.length === f.annotations.length) return;
  await writeAnnotations(docPath, { ...f, annotations: next });
}

/** Next sequential annotation id ("c0001", "c0002", …) given the existing ones. */
export function nextAnnotationId(existing: Annotation[]): string {
  let max = 0;
  for (const a of existing) {
    const m = /^c(\d+)$/.exec(a.id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `c${String(max + 1).padStart(4, "0")}`;
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
  const existing = (await readAnnotations(docPath)).annotations;
  const id = nextAnnotationId(existing);
  const annotation: Annotation = {
    id,
    type: input.kind,
    anchor: input.anchor,
    status: "open",
    thread: `threads/${id}.md`,
    session: `sessions/${id}.session.jsonl`,
    createdAt: deps.now,
    ...(input.color ? { color: input.color } : {}),
    author: input.author ?? deps.defaultAuthor ?? "you",
  };
  await addAnnotation(docPath, annotation);
  return annotation;
}

/** Remove an annotation and its thread/session files. No-op on missing files. */
export async function deleteAnnotation(docPath: string, id: string): Promise<void> {
  await removeAnnotation(docPath, id);
  const paths = hadPaths(docPath);
  await rm(paths.threadFile(id), { force: true });
  await rm(paths.sessionFile(id), { force: true });
}
