// Standing visual regression suite: boots one sidecar+Vite instance per
// color scheme (tools/parity/launch.mjs's own launcher — see support.mjs),
// drives Playwright through a fixed set of UI states (states.mjs), and
// pixel-diffs each screenshot against a committed baseline (compare.mjs).
//
// Usage:
//   node tools/visual/run.mjs            # compare current run against baseline/, exit non-zero on mismatch
//   node tools/visual/run.mjs --update   # regenerate baseline/ instead of comparing
import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { launchTree, stageFixture, cleanupStaged, shoot } from "./support.mjs";
import { captureStates, STATE_NAMES } from "./states.mjs";
import { compareImage } from "./compare.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");
const fixture = resolve(here, "fixtures/table-doc.md");

const UPDATE = process.argv.includes("--update");
// Spare port, distinct from tools/parity/run.mjs's 4501/4502 so both suites
// can run without colliding if ever invoked back to back.
const VITE_PORT = 4610;

const SCHEMES = ["light", "dark"];

async function runScheme(browser, scheme) {
  const outDir = resolve(here, UPDATE ? "baseline" : "current", scheme);
  await mkdir(outDir, { recursive: true });
  const docPath = await stageFixture(fixture);
  const srv = await launchTree(repoRoot, { vitePort: VITE_PORT, docPath });
  try {
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, colorScheme: scheme });
    try {
      const page = await ctx.newPage();
      await captureStates(page, srv.url, outDir, shoot);
    } finally {
      await ctx.close();
    }
  } finally {
    await srv.stop();
  }
  console.log(`[visual] ${scheme}: captured ${STATE_NAMES.length} states -> ${outDir}`);
}

async function main() {
  const browser = await chromium.launch();
  try {
    for (const scheme of SCHEMES) {
      await runScheme(browser, scheme);
    }
  } finally {
    await browser.close();
    await cleanupStaged();
  }

  if (UPDATE) {
    console.log(
      "\n[visual] baseline updated — eyeball tools/visual/baseline/**/*.png before committing " +
        "(nothing here checks that a screenshot looks right, only that it stops changing).",
    );
    return;
  }

  const failures = [];
  for (const scheme of SCHEMES) {
    for (const name of STATE_NAMES) {
      const baselinePath = resolve(here, "baseline", scheme, `${name}.png`);
      const currentPath = resolve(here, "current", scheme, `${name}.png`);
      const diffPath = resolve(here, "diff", scheme, `${name}.png`);
      const result = compareImage(baselinePath, currentPath, diffPath);
      if (result.pass) {
        console.log(`[visual] ${scheme}/${name}: OK`);
      } else {
        const detail =
          result.reason ?? `${result.mismatched}/${result.total} px differ (${(result.ratio * 100).toFixed(3)}%)`;
        console.error(`[visual] ${scheme}/${name}: FAIL — ${detail}`);
        failures.push(`${scheme}/${name}: ${detail}`);
      }
    }
  }

  if (failures.length) {
    console.error(`\n${failures.length} state(s) failed:`);
    for (const f of failures) console.error(`  - ${f}`);
    console.error("Diff images written under tools/visual/diff/.");
    process.exit(1);
  }
  console.log(`\nVISUAL OK — all ${SCHEMES.length * STATE_NAMES.length} states matched their baseline.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
