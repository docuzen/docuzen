import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, dirname, join, posix, resolve } from "node:path";
import AdmZip from "adm-zip";
import { hadPaths, isThreadId, isVersionId } from "./paths.js";
import { TMP_SUFFIX, withDocLock, writeDocument, writeFileAtomic } from "./io.js";
import { resolveHadDir } from "./resolve.js";
import { listVersions, readVersion } from "./versions.js";
import { contentHash, writeManifest } from "./manifest.js";
import { docRelativeLink } from "./assets.js";

export interface ExportHadzOptions {
  /** Bundle this version's doc content instead of the live doc on disk. */
  versionId?: string;
  outPath?: string;
}

/** Pack a document + its `.had` sidecar into a single `.hadz` zip. */
export async function exportHadz(
  docPath: string,
  opts: ExportHadzOptions = {},
): Promise<{ path: string }> {
  const paths = hadPaths(docPath);
  const zip = new AdmZip();
  if (opts.versionId) {
    const content = await readVersion(docPath, opts.versionId);
    zip.addFile(basename(docPath), Buffer.from(content, "utf8"));
  } else {
    zip.addLocalFile(docPath); // the doc at the zip root
  }
  zip.addLocalFolder(paths.dir, basename(paths.dir), (name) => !/\.db-(wal|shm)$/.test(name) && !name.endsWith(TMP_SUFFIX));
  const outPath = opts.outPath ?? `${docPath}.hadz`;
  zip.writeZip(outPath);
  return { path: outPath };
}

export interface ImportHadzOptions {
  /**
   * Called with the review-state folder an import is about to replace, before it is
   * touched, so a caller holding files in it open (the sidecar's per-document SQLite
   * task database) can close them first.
   */
  releaseHadDir?: (hadDir: string) => void;
}

/** An entry's name as extraction writes it (adm-zip's own normalization). */
function extractedName(entryName: string): string {
  return posix.normalize(`/${entryName.split("\\").join("/")}`).slice(1);
}

/** Parse a bundled JSON file, or throw naming it. */
function bundledJson(entry: AdmZip.IZipEntry, name: string): unknown {
  try {
    return JSON.parse(entry.getData().toString("utf8"));
  } catch {
    throw new Error(`invalid ${name} in .hadz bundle`);
  }
}

/**
 * Refuse a bundle whose review state names ids the store would never hand out: they
 * become file names (threads/<id>.md, versions/<id>.md), and a crafted one would point
 * outside the store. Checked before anything is written.
 */
function assertBundleIds(zip: AdmZip, hadFolder: string): void {
  for (const entry of zip.getEntries()) {
    const name = extractedName(entry.entryName);
    if (name === `${hadFolder}/annotations.json`) {
      const f = bundledJson(entry, "annotations.json") as { annotations?: unknown };
      if (!Array.isArray(f?.annotations)) throw new Error("invalid annotations.json in .hadz bundle");
      for (const a of f.annotations as { id?: unknown }[]) {
        if (!isThreadId(a?.id)) throw new Error(`invalid thread id in .hadz bundle: ${JSON.stringify(a?.id)}`);
      }
    } else if (name === `${hadFolder}/versions/index.json`) {
      const f = bundledJson(entry, "versions/index.json") as { entries?: unknown };
      if (!Array.isArray(f?.entries)) throw new Error("invalid versions/index.json in .hadz bundle");
      for (const v of f.entries as { id?: unknown }[]) {
        if (!isVersionId(v?.id)) throw new Error(`invalid version id in .hadz bundle: ${JSON.stringify(v?.id)}`);
      }
    }
  }
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Images are linked by a path relative to the document (`saveImage`), e.g.
 * `../.docuzen/docs/plan.md.had/assets/shot.png` for a doc one folder down in a repo.
 * An import puts the review state wherever it resolves for the new location, so links
 * written for the old location are pointed at the new assets folder — in the document
 * and in its saved versions (a restore must not bring broken links back).
 */
async function relinkAssets(docPath: string, hadFolder: string): Promise<void> {
  const paths = hadPaths(docPath);
  if (!existsSync(paths.assetsDir)) return;
  const old = new RegExp(
    // A relative reference (start of text or after a delimiter) that climbs any number
    // of folders into a `.docuzen/…/<hadFolder>/assets/` folder.
    String.raw`(?<![^\s("'<=])(?:\.\.\/)*\.docuzen\/(?:[^\/\s()"'<>]+\/)*?` +
      escapeRegExp(encodeURIComponent(hadFolder)) +
      String.raw`\/assets\/`,
    "g",
  );
  const now = `${docRelativeLink(docPath, paths.assetsDir)}/`;
  const relink = (text: string): string => text.replace(old, now);

  await withDocLock(docPath, async () => {
    const raw = await readFile(docPath, "utf8");
    const doc = relink(raw);
    if (doc !== raw) {
      await writeDocument(docPath, doc);
      await writeManifest(docPath, { version: 1, doc: basename(docPath), contentHash: contentHash(doc) });
    }
  });
  for (const v of await listVersions(docPath)) {
    const file = paths.versionFile(v.id);
    const before = await readFile(file, "utf8").catch(() => undefined);
    const after = before === undefined ? undefined : relink(before);
    if (after !== undefined && after !== before) await writeFileAtomic(file, after);
  }
}

/** Unpack a `.hadz` bundle, returning the path to its extracted document. */
export async function importHadz(
  hadzPath: string,
  destDir?: string,
  opts: ImportHadzOptions = {},
): Promise<{ docPath: string }> {
  const dest = resolve(destDir ?? `${hadzPath}.unpacked`);
  const zip = new AdmZip(hadzPath);
  const entryNames = zip.getEntries().map((e) => e.entryName);
  // The doc is the only root-level entry (the .had folder entries are nested).
  const docName = entryNames.find((n) => !n.includes("/") && !n.startsWith("."));
  if (!docName) throw new Error("no document found in .hadz bundle");
  const docPath = join(dest, docName);
  // Bundles carry the sidecar as a root-level `<doc>.had/` folder (older
  // bundles: `.<doc>.had/`). Move it to wherever review state now resolves
  // so hadPaths(docPath) finds it.
  const hadFolder = entryNames
    .filter((n) => n.includes("/"))
    .map((n) => n.split("/")[0])
    .find((seg) => seg.endsWith(".had"));
  if (hadFolder) assertBundleIds(zip, hadFolder);

  zip.extractAllTo(dest, /* overwrite */ true);
  if (hadFolder) {
    const from = join(dest, hadFolder);
    const to = resolveHadDir(docPath);
    if (from !== to) {
      opts.releaseHadDir?.(to);
      rmSync(to, { recursive: true, force: true });
      mkdirSync(dirname(to), { recursive: true });
      renameSync(from, to);
    }
    await relinkAssets(docPath, hadFolder);
  }
  return { docPath };
}
