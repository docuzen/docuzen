#!/usr/bin/env node
// Fetches the pinned Node binary and better-sqlite3 prebuild into the
// versioned cache (.sidecar-cache/darwin-<arch>/<node>-<addon>/).
// Every download lands in a temp dir, is SHA-256-verified against
// sidecar.json, extracted there, and only then renamed into the cache —
// an interrupted or tampered download can never occupy a cache key.
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cacheDirFor, downloadsFor, loadSidecarMeta, sha256File } from "./lib/sidecar-meta.mjs";

const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const archIdx = args.indexOf("--arch");
const arch = archIdx !== -1 ? args[archIdx + 1] : process.env.SIDECAR_ARCH ?? process.arch;

const meta = loadSidecarMeta(pkgDir);
const cacheDir = cacheDirFor(pkgDir, meta, arch);
mkdirSync(cacheDir, { recursive: true });

async function fetchVerified(dl, outFile) {
  const tmp = mkdtempSync(join(tmpdir(), "sidecar-dl-"));
  const archive = join(tmp, "download.tar.gz");
  try {
    console.log(`fetching ${dl.url}`);
    const curl = spawnSync("curl", ["-fsSL", "-o", archive, dl.url], { stdio: "inherit" });
    if (curl.status !== 0) throw new Error(`download failed: ${dl.url}`);
    const actual = await sha256File(archive);
    if (actual !== dl.sha256) {
      throw new Error(
        `SHA-256 mismatch for ${dl.url}\n  expected ${dl.sha256}\n  actual   ${actual}`,
      );
    }
    const tar = spawnSync("tar", ["-xzf", archive, "-C", tmp, dl.tarMember], { stdio: "inherit" });
    if (tar.status !== 0) throw new Error(`extract failed: ${dl.url}`);
    // Stage next to the destination, then rename: same-filesystem rename is
    // atomic, so the cache key is only ever occupied by a complete file.
    const staging = `${outFile}.tmp`;
    copyFileSync(join(tmp, dl.tarMember), staging);
    renameSync(staging, outFile);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

const dls = downloadsFor(meta, arch);

const nodeBin = resolve(cacheDir, "node");
if (!existsSync(nodeBin)) {
  await fetchVerified(dls.node, nodeBin);
  chmodSync(nodeBin, 0o755);
}

const nativeOut = resolve(cacheDir, "better_sqlite3.node");
if (!existsSync(nativeOut)) {
  await fetchVerified(dls.addon, nativeOut);
}
console.log(`sidecar runtime ready in ${cacheDir}`);
