// The storage core every review-state file goes through. Two guarantees, both of which
// the per-file modules used to leave to luck:
//
//  1. Atomic replace. A file is written to a sibling temp file and renamed over the
//     target, so a reader (or a crash) only ever sees the old complete file or the new
//     complete file — never a half-written annotations.json that then fails JSON.parse
//     and takes the document's whole review state with it.
//
//  2. Serialized read-modify-write. `withFileLock(path, fn)` runs `fn` exclusively per
//     path, in arrival order. Without it, two RPCs that each read a JSON file, change
//     it, and write it back (two annotations created at once, parallel directive agents
//     appending proposals, a status transition racing an appended turn) silently drop
//     one of the changes.
//
// In-process only, by design: one sidecar owns a document's store. It is not a
// cross-process lock.
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

let tmpSeq = 0;

/** Suffix of in-flight temp files; bundle export skips them. */
export const TMP_SUFFIX = ".tmp";

/** Write `data` to `path` atomically (temp file + rename), creating parent dirs. */
export async function writeFileAtomic(path: string, data: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${++tmpSeq}${TMP_SUFFIX}`;
  try {
    await writeFile(tmp, data, "utf8");
    // A replaced file keeps its permissions (e.g. a 0600 models.json holding API keys
    // must not come back world-readable because the temp file got the default mode).
    const existing = await stat(path).catch(() => null);
    if (existing) await chmod(tmp, existing.mode & 0o777);
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

/** Read a UTF-8 file, or `undefined` when it does not exist. Other errors propagate. */
export async function readFileIfExists(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

/** Parse a JSON file, or return `fallback()` when it does not exist. */
export async function readJsonFile<T>(path: string, fallback: () => T): Promise<T> {
  const raw = await readFileIfExists(path);
  return raw === undefined ? fallback() : (JSON.parse(raw) as T);
}

/** Atomically write `value` as pretty-printed JSON with a trailing newline. */
export function writeJsonFile(path: string, value: unknown): Promise<void> {
  return writeFileAtomic(path, JSON.stringify(value, null, 2) + "\n");
}

const tails = new Map<string, Promise<unknown>>();

/**
 * Run `fn` with exclusive access to `key` (a file path), after every earlier holder has
 * settled. A holder that throws releases the lock like any other; its error reaches only
 * its own caller. NOT re-entrant: calling `withFileLock(k)` from inside a `withFileLock(k)`
 * callback deadlocks, so the modules built on this keep their locked sections flat (public
 * function takes the lock, private `…Unlocked` helpers do the work).
 */
export function withFileLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = tails.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  tails.set(key, tail);
  // Drop the entry once this is the last holder, so the map doesn't grow per path forever.
  void tail.then(() => {
    if (tails.get(key) === tail) tails.delete(key);
  });
  return run;
}

/**
 * The read → change → write cycle for one JSON file, under its lock. `change` may mutate
 * and return the value, or return a new one; returning `undefined` skips the write.
 */
export function updateJsonFile<T, R = void>(
  path: string,
  fallback: () => T,
  change: (current: T) => { next?: T; result: R } | Promise<{ next?: T; result: R }>,
): Promise<R> {
  return withFileLock(path, async () => {
    const { next, result } = await change(await readJsonFile(path, fallback));
    if (next !== undefined) await writeJsonFile(path, next);
    return result;
  });
}
