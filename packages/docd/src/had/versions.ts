import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { VersionCause, VersionEntry, VersionsFile } from "./types.js";
import { hadPaths } from "./paths.js";

export interface SnapshotOptions {
  cause: VersionCause;
  thread?: string;
  note?: string;
  /** ISO timestamp; injected by callers (no Date.now in the pure core). */
  at: string;
}

async function readIndex(docPath: string): Promise<VersionsFile> {
  const p = hadPaths(docPath);
  try {
    return JSON.parse(await readFile(p.versionsIndex, "utf8")) as VersionsFile;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT")
      return { version: 1, entries: [] };
    throw err;
  }
}

function nextId(entries: VersionEntry[]): string {
  return `v${String(entries.length + 1).padStart(4, "0")}`;
}

/** Read the live annotations.json as a raw string ("" if the file doesn't exist). */
async function readCurrentAnnotationsRaw(docPath: string): Promise<string> {
  try {
    return await readFile(hadPaths(docPath).annotations, "utf8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw err;
  }
}

/**
 * Read the annotations captured at a given version as a raw string. Returns ""
 * for versions snapshotted before annotation-versioning (no per-version file).
 */
export async function readVersionAnnotations(
  docPath: string,
  id: string,
): Promise<string> {
  try {
    return await readFile(hadPaths(docPath).versionAnnotationsFile(id), "utf8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw err;
  }
}

export async function snapshot(
  docPath: string,
  content: string,
  opts: SnapshotOptions,
): Promise<VersionEntry> {
  const p = hadPaths(docPath);
  await mkdir(p.versionsDir, { recursive: true });
  const idx = await readIndex(docPath);
  const annotations = await readCurrentAnnotationsRaw(docPath);
  // Dedupe: reuse the latest version only if BOTH its doc content AND its
  // captured annotations match the current ones — so deleting comments while the
  // doc text is unchanged still produces a new, restorable version.
  const latest = idx.entries[idx.entries.length - 1];
  if (
    latest &&
    (await readVersion(docPath, latest.id)) === content &&
    (await readVersionAnnotations(docPath, latest.id)) === annotations
  ) {
    return latest;
  }
  const id = nextId(idx.entries);
  await writeFile(p.versionFile(id), content, "utf8");
  await writeFile(p.versionAnnotationsFile(id), annotations, "utf8");
  const entry: VersionEntry = {
    id,
    timestamp: opts.at,
    cause: opts.cause,
    ...(opts.thread ? { thread: opts.thread } : {}),
    ...(opts.note ? { note: opts.note } : {}),
  };
  idx.entries.push(entry);
  await writeFile(p.versionsIndex, JSON.stringify(idx, null, 2) + "\n", "utf8");
  return entry;
}

export async function listVersions(docPath: string): Promise<VersionEntry[]> {
  return (await readIndex(docPath)).entries;
}

export async function readVersion(docPath: string, id: string): Promise<string> {
  const p = hadPaths(docPath);
  return readFile(p.versionFile(id), "utf8");
}

export async function latestVersionId(docPath: string): Promise<string | null> {
  const entries = (await readIndex(docPath)).entries;
  return entries.length ? entries[entries.length - 1].id : null;
}
