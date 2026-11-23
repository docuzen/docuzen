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
import { constants } from "node:fs";
import { access, chmod, lstat, mkdir, readFile, readlink, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

let tmpSeq = 0;

/** Suffix of in-flight temp files; bundle export skips them. */
export const TMP_SUFFIX = ".tmp";

export interface WriteFileAtomicOptions {
  /**
   * The file's mode. Pass it for files holding secrets (0o600): the temp file is created
   * with it, so the bytes are never readable by anyone else, not even briefly. Without
   * it a replaced file keeps its own mode and a new file gets the default (umask) mode.
   */
  mode?: number;
}

/**
 * Write `data` to `path` atomically (temp file + rename), creating parent dirs. A symlink
 * at `path` is replaced, not followed (see `writeDocument` for the user's own files).
 */
export async function writeFileAtomic(
  path: string,
  data: string | Uint8Array,
  opts: WriteFileAtomicOptions = {},
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  // The temp file is born with its final mode: a 0600 file holding API keys must not
  // spend even a moment world-readable between the write and a later chmod.
  const existing = await stat(path).catch(() => null);
  const mode = opts.mode ?? (existing ? existing.mode & 0o777 : undefined);
  const tmp = `${path}.${process.pid}.${++tmpSeq}${TMP_SUFFIX}`;
  try {
    // "wx": never write through something already sitting at the temp path.
    await writeFile(tmp, data, { flag: "wx", ...(mode !== undefined ? { mode } : {}) });
    // The umask may have masked bits off the requested mode; set it exactly.
    if (mode !== undefined) await chmod(tmp, mode);
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

/** The file a write to `path` should land in: `path` itself, or its symlink's final target. */
async function writeTarget(path: string): Promise<string> {
  let target = path;
  for (let hops = 0; hops < 40; hops++) {
    const info = await lstat(target).catch((err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") return null;
      throw err;
    });
    if (!info?.isSymbolicLink()) return target;
    target = resolve(dirname(target), await readlink(target));
  }
  throw new Error(`too many levels of symbolic links: ${path}`);
}

/**
 * Write the user's document atomically, keeping its mode. A document that is a symlink is
 * written through to its target (the link stays a link), as an editor saving in place would.
 * A read-only document is refused, as an in-place write would be — renaming over it would
 * otherwise succeed. A writable document in a folder that refuses new files (so no temp
 * file can be made next to it) is written in place, as it always was.
 */
export async function writeDocument(docPath: string, text: string): Promise<void> {
  const target = await writeTarget(docPath);
  await access(target, constants.W_OK).catch((err: NodeJS.ErrnoException) => {
    if (err.code !== "ENOENT") throw err;
  });
  try {
    await writeFileAtomic(target, text);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "EACCES" && code !== "EPERM") throw err;
    await writeFile(target, text, "utf8");
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
export function writeJsonFile(path: string, value: unknown, opts: WriteFileAtomicOptions = {}): Promise<void> {
  return writeFileAtomic(path, JSON.stringify(value, null, 2) + "\n", opts);
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
 * Run `fn` holding the document's lock. Every writer of the user's document — save,
 * restore, approving or rejecting an agent's proposal — takes it, so none can read the
 * document, decide, and write over a change another made in between. Not re-entrant
 * (see `withFileLock`).
 */
export function withDocLock<T>(docPath: string, fn: () => Promise<T>): Promise<T> {
  return withFileLock(`${resolve(docPath)}#doc`, fn);
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
