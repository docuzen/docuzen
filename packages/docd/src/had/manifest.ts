import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import type { Manifest } from "./types.js";
import { hadPaths } from "./paths.js";

export function contentHash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Build a fresh manifest from the document's current contents on disk. */
export async function initManifest(docPath: string): Promise<Manifest> {
  const text = await readFile(docPath, "utf8");
  return { version: 1, doc: basename(docPath), contentHash: contentHash(text) };
}

export async function writeManifest(docPath: string, m: Manifest): Promise<void> {
  const p = hadPaths(docPath);
  await mkdir(p.dir, { recursive: true });
  await writeFile(p.manifest, JSON.stringify(m, null, 2) + "\n", "utf8");
}

export async function readManifest(docPath: string): Promise<Manifest | null> {
  const p = hadPaths(docPath);
  try {
    const raw = await readFile(p.manifest, "utf8");
    return JSON.parse(raw) as Manifest;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}
