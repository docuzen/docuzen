// Single source of truth for sidecar runtime downloads: versions and pinned
// SHA-256 checksums from sidecar.json, cache layout keyed by BOTH the node
// and addon versions so a version bump can never reuse a stale binary.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const require = createRequire(import.meta.url);

export function loadSidecarMeta(pkgDir) {
  const sidecar = JSON.parse(readFileSync(resolve(pkgDir, "sidecar.json"), "utf8"));
  const addonVersion = require("better-sqlite3/package.json").version;
  return { ...sidecar, addonVersion };
}

export function cacheDirFor(pkgDir, meta, arch) {
  return resolve(pkgDir, ".sidecar-cache", `darwin-${arch}`, `${meta.nodeVersion}-${meta.addonVersion}`);
}

function requiredChecksum(meta, key) {
  const value = meta.checksums?.[key];
  if (!value) throw new Error(`sidecar.json is missing checksum "${key}"`);
  return value;
}

export function downloadsFor(meta, arch) {
  const nodeName = `node-v${meta.nodeVersion}-darwin-${arch}`;
  return {
    node: {
      url: `https://nodejs.org/dist/v${meta.nodeVersion}/${nodeName}.tar.gz`,
      sha256: requiredChecksum(meta, `node-darwin-${arch}`),
      tarMember: `${nodeName}/bin/node`,
    },
    addon: {
      url: `https://github.com/WiseLibs/better-sqlite3/releases/download/v${meta.addonVersion}/better-sqlite3-v${meta.addonVersion}-node-v${meta.abi}-darwin-${arch}.tar.gz`,
      sha256: requiredChecksum(meta, `better-sqlite3-darwin-${arch}`),
      tarMember: "build/Release/better_sqlite3.node",
    },
  };
}

export async function sha256File(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}
