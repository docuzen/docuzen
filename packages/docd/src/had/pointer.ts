import { readFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import matter from "gray-matter";

/** The relative pointer value stored in the doc's frontmatter. */
export function pointerValue(docPath: string): string {
  return `.${basename(docPath)}.had/`;
}

export async function readPointer(docPath: string): Promise<string | null> {
  const parsed = matter(await readFile(docPath, "utf8"));
  const had = (parsed.data as Record<string, unknown>).had;
  return typeof had === "string" ? had : null;
}

/** Ensure the doc's frontmatter contains the `had:` pointer. Idempotent. */
export async function ensurePointer(docPath: string): Promise<void> {
  const raw = await readFile(docPath, "utf8");
  const parsed = matter(raw);
  const want = pointerValue(docPath);
  if ((parsed.data as Record<string, unknown>).had === want) return;
  const data = { ...parsed.data, had: want };
  await writeFile(docPath, matter.stringify(parsed.content, data), "utf8");
}
