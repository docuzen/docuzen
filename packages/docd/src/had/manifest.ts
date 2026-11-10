import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { Manifest } from "./types.js";
import { hadPaths } from "./paths.js";
import { readFileIfExists, writeJsonFile } from "./io.js";

export function contentHash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Build a fresh manifest from the document's current contents on disk. */
export async function initManifest(docPath: string): Promise<Manifest> {
  const text = await readFile(docPath, "utf8");
  return { version: 1, doc: basename(docPath), contentHash: contentHash(text) };
}

export async function writeManifest(docPath: string, m: Manifest): Promise<void> {
  await writeJsonFile(hadPaths(docPath).manifest, m);
}

export async function readManifest(docPath: string): Promise<Manifest | null> {
  const raw = await readFileIfExists(hadPaths(docPath).manifest);
  return raw === undefined ? null : (JSON.parse(raw) as Manifest);
}
