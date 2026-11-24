#!/usr/bin/env node
// Bundles the docd sidecar into a single CommonJS file for packaging.
// CJS (not ESM) because better-sqlite3 resolves its native addon with a
// dynamic require(), which esbuild only preserves natively in CJS output.
// docd itself has no import.meta or __dirname (verified), so CJS is safe.
import { build } from "esbuild";
import { createRequire } from "node:module";
import { mkdirSync, copyFileSync } from "node:fs";
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

// Only the JS adapter ships in the app. Its native Claude runtime is supplied by the user's CLI.
const require = createRequire(import.meta.url);
const adapterDir = dirname(require.resolve("@agentclientprotocol/claude-agent-acp/package.json"));
await build({
  entryPoints: [resolve(adapterDir, "dist/index.js")],
  bundle: true, platform: "node", format: "esm", target: "node22",
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
  external: ["@anthropic-ai/claude-agent-sdk-*"],
  outfile: resolve(outDir, "claude-agent-acp.mjs"),
  legalComments: "eof",
});
copyFileSync(resolve(adapterDir, "LICENSE"), resolve(outDir, "claude-agent-acp-LICENSE"));
const sdkDir = dirname(require.resolve("@anthropic-ai/claude-agent-sdk", { paths: [adapterDir] }));
copyFileSync(resolve(sdkDir, "LICENSE.md"), resolve(outDir, "claude-agent-sdk-LICENSE.md"));
