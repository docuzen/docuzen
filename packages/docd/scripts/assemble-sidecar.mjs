#!/usr/bin/env node
// Assembles the complete sidecar artifact (node + main.cjs + native addon)
// into --out <dir>. This is what tauri.conf.json bundles as a resource.
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cacheDirFor, loadSidecarMeta } from "./lib/sidecar-meta.mjs";

const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const outIdx = args.indexOf("--out");
const outDir = resolve(process.cwd(), outIdx !== -1 ? args[outIdx + 1] : "dist-sidecar/bundle");
const archIdx = args.indexOf("--arch");
const arch = archIdx !== -1 ? args[archIdx + 1] : process.env.SIDECAR_ARCH ?? process.arch;

function run(script, extra = []) {
  const r = spawnSync(process.execPath, [resolve(pkgDir, "scripts", script), ...extra], {
    stdio: "inherit",
  });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

run("bundle-sidecar.mjs");
run("fetch-sidecar-runtime.mjs", ["--arch", arch]);

const cacheDir = cacheDirFor(pkgDir, loadSidecarMeta(pkgDir), arch);
mkdirSync(outDir, { recursive: true });
copyFileSync(resolve(cacheDir, "node"), resolve(outDir, "node"));
chmodSync(resolve(outDir, "node"), 0o755);
copyFileSync(resolve(pkgDir, "dist-sidecar/main.cjs"), resolve(outDir, "main.cjs"));
copyFileSync(resolve(cacheDir, "better_sqlite3.node"), resolve(outDir, "better_sqlite3.node"));
console.log(`sidecar assembled -> ${outDir}`);
