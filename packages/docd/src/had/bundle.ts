import { basename, join } from "node:path";
import AdmZip from "adm-zip";
import { hadPaths } from "./paths.js";
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
  // The doc is the only root-level entry (the .had folder entries are nested).
  const docName = zip
    .getEntries()
    .map((e) => e.entryName)
    .find((n) => !n.includes("/") && !n.startsWith("."));
  if (!docName) throw new Error("no document found in .hadz bundle");
  return { docPath: join(dest, docName) };
}
