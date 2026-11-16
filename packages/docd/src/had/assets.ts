// Images dropped or pasted into a document. They live with the rest of the document's
// review state, in `<doc>.had/assets/`, and the document links them by a path relative to
// its own directory — so the file stays a plain markdown/HTML file any other tool can read,
// and an exported `.hadz` (which packs the whole `.had` folder) carries the images along.
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, sep } from "node:path";
import { hadPaths } from "./paths.js";
import { withFileLock } from "./io.js";
import { isHtmlDoc } from "./doc-format.js";
import { ensureDocuzenHidden } from "./hide.js";

/** Extension -> MIME type of every image kind a document may embed. */
export const IMAGE_TYPES: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
};

/** Largest image accepted, in bytes. A screenshot is ~1 MB; this is a typo guard. */
export const MAX_IMAGE_BYTES = 50 * 1024 * 1024;

/** MIME type for an image path, or undefined when the extension is not an image. */
export function imageMimeType(path: string): string | undefined {
  return IMAGE_TYPES[extname(path).toLowerCase()];
}

export interface SaveImageInput {
  /** Original file name; only its base name and extension are used. */
  name: string;
  /** The image bytes, base64 (a browser drop or paste). */
  dataBase64?: string;
  /** Or an absolute path to copy from (a native file picker). */
  sourcePath?: string;
}

export interface SavedImage {
  /** Absolute path of the stored file. */
  path: string;
  /** What the document should link: POSIX, percent-encoded, relative to the doc's directory. */
  relPath: string;
  /** Stored file name (may differ from the requested one). */
  name: string;
}

/** A filesystem-safe base name: letters, digits, dash, underscore, dot. */
function safeStem(name: string): string {
  const stem = basename(name, extname(name))
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 60);
  return stem || "image";
}

/** Path from the document's directory to `target`, as a URL-style relative reference. */
export function docRelativeLink(docPath: string, target: string): string {
  return relative(dirname(docPath), target).split(sep).map(encodeURIComponent).join("/");
}

/**
 * Store an image in the document's `.had/assets/` folder. Dropping the same bytes under
 * the same name twice reuses the file; a different image with a taken name gets a
 * numbered one (`shot-2.png`), so an existing link never changes what it shows.
 */
export async function saveImage(docPath: string, input: SaveImageInput): Promise<SavedImage> {
  const ext = extname(input.name || input.sourcePath || "").toLowerCase();
  if (!IMAGE_TYPES[ext]) throw new Error(`not an image file: ${input.name || input.sourcePath || "(unnamed)"}`);
  let bytes: Buffer;
  if (input.sourcePath !== undefined) {
    if (!isAbsolute(input.sourcePath)) throw new Error("sourcePath must be absolute");
    const info = await stat(input.sourcePath);
    if (info.size > MAX_IMAGE_BYTES) throw new Error("image is too large (limit 50 MB)");
    bytes = await readFile(input.sourcePath);
  } else if (input.dataBase64 !== undefined) {
    bytes = Buffer.from(input.dataBase64, "base64");
  } else {
    throw new Error("saveImage needs dataBase64 or sourcePath");
  }
  if (bytes.length === 0) throw new Error("image is empty");
  if (bytes.length > MAX_IMAGE_BYTES) throw new Error("image is too large (limit 50 MB)");

  ensureDocuzenHidden();
  const dir = hadPaths(docPath).assetsDir;
  const stem = safeStem(input.name || input.sourcePath || "image");
  return withFileLock(dir, async () => {
    await mkdir(dir, { recursive: true });
    for (let n = 1; ; n++) {
      const name = `${stem}${n === 1 ? "" : `-${n}`}${ext}`;
      const path = join(dir, name);
      const existing = await readFile(path).catch(() => null);
      if (existing && !existing.equals(bytes)) continue; // taken by a different image
      if (!existing) await writeFile(path, bytes);
      return { path, relPath: docRelativeLink(docPath, path), name };
    }
  });
}

/** An image file's bytes, for a webview that could not load it over HTTP. Images only. */
export async function readImage(path: string): Promise<{ mime: string; dataBase64: string }> {
  const mime = imageMimeType(path);
  if (!isAbsolute(path) || !mime) throw new Error("not an image path");
  const info = await stat(path);
  if (info.size > MAX_IMAGE_BYTES) throw new Error("image is too large (limit 50 MB)");
  return { mime, dataBase64: (await readFile(path)).toString("base64") };
}

function titleFromPath(docPath: string): string {
  return basename(docPath, extname(docPath)).replace(/[-_]+/g, " ").trim() || "Untitled";
}

const escapeHtml = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Starting content for a new document: a title from the file name and room to write. */
export function newDocContent(docPath: string): string {
  const title = titleFromPath(docPath);
  if (!isHtmlDoc(docPath)) return `# ${title}\n\n`;
  const t = escapeHtml(title);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${t}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; line-height: 1.6; max-width: 720px; margin: 2rem auto; padding: 0 1.5rem; }
  img { max-width: 100%; height: auto; }
</style>
</head>
<body>
<h1>${t}</h1>
<p>Start writing here.</p>
</body>
</html>
`;
}

/**
 * Create a new document at `docPath` with starter content. Replaces an existing file:
 * the caller is a save dialog, which has already asked before overwriting.
 */
export async function createDoc(docPath: string): Promise<{ docPath: string }> {
  if (!isAbsolute(docPath)) throw new Error("docPath must be absolute");
  if (!/\.(md|markdown|html|htm)$/i.test(docPath)) throw new Error("a new document must be .md or .html");
  await mkdir(dirname(docPath), { recursive: true });
  await writeFile(docPath, newDocContent(docPath), "utf8");
  return { docPath };
}
