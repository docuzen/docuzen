// What a local path really is, for following a link written in a document. The desktop app
// opens only documents and media from a link (doc-links.ts); it classifies by name, and a
// name can lie: `notes.txt` may be a symlink to a script or an app. This resolves the path
// the way the OS will when it opens it, so the app can classify the real target.
import { realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";

export interface PathInfo {
  /** The path with every symlink resolved, or null when nothing is there. */
  realPath: string | null;
  kind: "file" | "directory" | "other" | "missing";
}

const MISSING = new Set(["ENOENT", "ENOTDIR", "ELOOP"]);

export async function inspectPath(path: string): Promise<PathInfo> {
  if (!isAbsolute(path)) throw new Error("path must be absolute");
  let real: string;
  try {
    real = await realpath(path);
  } catch (err) {
    if (MISSING.has((err as NodeJS.ErrnoException).code ?? "")) return { realPath: null, kind: "missing" };
    throw err;
  }
  const info = await stat(real);
  return { realPath: real, kind: info.isFile() ? "file" : info.isDirectory() ? "directory" : "other" };
}
