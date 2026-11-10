import { readFile } from "node:fs/promises";
import type { VersionCause, VersionEntry, VersionsFile } from "./types.js";
import { hadPaths } from "./paths.js";
import { readFileIfExists, readJsonFile, withFileLock, writeFileAtomic, writeJsonFile } from "./io.js";

export interface SnapshotOptions {
  cause: VersionCause;
  thread?: string;
  note?: string;
  /** ISO timestamp; injected by callers (no Date.now in the pure core). */
  at: string;
}

async function readIndex(docPath: string): Promise<VersionsFile> {
  return readJsonFile(hadPaths(docPath).versionsIndex, () => ({ version: 1, entries: [] }));
}

function nextId(entries: VersionEntry[]): string {
  return `v${String(entries.length + 1).padStart(4, "0")}`;
}

/** Read the live annotations.json as a raw string ("" if the file doesn't exist). */
async function readCurrentAnnotationsRaw(docPath: string): Promise<string> {
  return (await readFileIfExists(hadPaths(docPath).annotations)) ?? "";
}

/**
 * Read the annotations captured at a given version as a raw string. Returns ""
 * for versions snapshotted before annotation-versioning (no per-version file).
 */
export async function readVersionAnnotations(
  docPath: string,
  id: string,
): Promise<string> {
  return (await readFileIfExists(hadPaths(docPath).versionAnnotationsFile(id))) ?? "";
}

export async function snapshot(
  docPath: string,
  content: string,
  opts: SnapshotOptions,
): Promise<VersionEntry> {
  const p = hadPaths(docPath);
  // One snapshot at a time per document: the id is "entries.length + 1", so two
  // concurrent snapshots (an approve racing a turn-base stamp) would otherwise both
  // claim the same id and overwrite each other's version file.
  return withFileLock(p.versionsIndex, async () => {
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
  // Content files first, index last: a crash in between leaves orphan files that the
  // next snapshot overwrites, never an index entry pointing at a missing version.
  await writeFileAtomic(p.versionFile(id), content);
  await writeFileAtomic(p.versionAnnotationsFile(id), annotations);
  const entry: VersionEntry = {
    id,
    timestamp: opts.at,
    cause: opts.cause,
    ...(opts.thread ? { thread: opts.thread } : {}),
    ...(opts.note ? { note: opts.note } : {}),
  };
  idx.entries.push(entry);
  await writeJsonFile(p.versionsIndex, idx);
  return entry;
  });
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
