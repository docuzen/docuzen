import { mkdirSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import AdmZip from "adm-zip";
import { hadPaths } from "./paths.js";
import { resolveHadDir } from "./resolve.js";
import { readVersion } from "./versions.js";

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
  zip.addLocalFolder(paths.dir, basename(paths.dir), (name) => !/\.db-(wal|shm)$/.test(name));
  const outPath = opts.outPath ?? `${docPath}.hadz`;
  zip.writeZip(outPath);
  return { path: outPath };
}

/** Unpack a `.hadz` bundle, returning the path to its extracted document. */
export async function importHadz(
  hadzPath: string,
  destDir?: string,
): Promise<{ docPath: string }> {
  const dest = destDir ?? `${hadzPath}.unpacked`;
  const zip = new AdmZip(hadzPath);
  zip.extractAllTo(dest, /* overwrite */ true);
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
  if (hadFolder) {
    const from = join(dest, hadFolder);
    const to = resolveHadDir(docPath);
    if (from !== to) {
      rmSync(to, { recursive: true, force: true });
      mkdirSync(dirname(to), { recursive: true });
      renameSync(from, to);
    }
  }
  return { docPath };
}
