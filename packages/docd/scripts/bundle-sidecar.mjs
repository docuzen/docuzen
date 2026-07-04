#!/usr/bin/env node
// Bundles the docd sidecar into a single CommonJS file for packaging.
// CJS (not ESM) because better-sqlite3 resolves its native addon with a
// dynamic require(), which esbuild only preserves natively in CJS output.
// docd itself has no import.meta or __dirname (verified), so CJS is safe.
import { build } from "esbuild";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = resolve(pkgDir, "dist-sidecar");
mkdirSync(outDir, { recursive: true });

await build({
  entryPoints: [resolve(pkgDir, "src/server/main.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  outfile: resolve(outDir, "main.cjs"),
  // ws's optional native peers; not installed, guarded by try/catch at runtime.
  external: ["bufferutil", "utf-8-validate"],
  // pi-coding-agent uses import.meta.url at module load time; CJS output
  // replaces import.meta with {}, making .url undefined. Inject a CJS-safe
  // shim at the top of the bundle and reference it via define.
  banner: {
    js: "const __importMetaUrl = require('url').pathToFileURL(__filename).href;",
  },
  define: {
    "import.meta.url": "__importMetaUrl",
  },
  logLevel: "info",
});
console.log(`bundled sidecar -> ${resolve(outDir, "main.cjs")}`);
