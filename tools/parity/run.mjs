// Orchestrates a parity run: for each tree (main, candidate) × scenario
// (md, html), launch sidecar+vite, drive the flows, write report + shots.
import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { launchTree, stageDoc, cleanupTempDirs } from "./launch.mjs";
import { runFlows } from "./flows.mjs";
import { compareReports } from "./compare.mjs";

const here = dirname(fileURLToPath(import.meta.url));

const USAGE = "usage: node tools/parity/run.mjs --main <tree> --candidate <tree>";

function arg(args, name, dflt) {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return dflt;
  if (i + 1 >= args.length) {
    console.error(USAGE);
    process.exit(2);
  }
  return resolve(args[i + 1]);
}

const SCENARIOS = [
  { scenario: "md", sample: "apps/desktop/sample/plan-rate-limiting.md" },
  { scenario: "html", sample: "apps/desktop/sample/report.html" },
];
const VITE_PORTS = { main: 4501, candidate: 4502 };

async function main() {
  const args = process.argv.slice(2);
  const trees = {
    main: arg(args, "main", null),
    candidate: arg(args, "candidate", null),
  };
  if (!trees.main || !trees.candidate) {
    console.error(USAGE);
    process.exit(2);
  }

  const browser = await chromium.launch();
  const reports = { main: {}, candidate: {} };
  try {
    for (const [side, tree] of Object.entries(trees)) {
      const outDir = resolve(here, "out", side);
      await mkdir(outDir, { recursive: true });
      for (const { scenario, sample } of SCENARIOS) {
        const docPath = await stageDoc(tree, sample);
        const srv = await launchTree(tree, { vitePort: VITE_PORTS[side], docPath });
        try {
          const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
          try {
            const page = await ctx.newPage();
            const report = await runFlows(page, { scenario, url: srv.url, outDir });
            reports[side][scenario] = report;
            await writeFile(resolve(outDir, `report-${scenario}.json`), JSON.stringify(report, null, 2));
          } finally {
            await ctx.close();
          }
        } finally {
          await srv.stop();
        }
        console.log(`[parity] ${side}/${scenario}: ${reports[side][scenario].steps.map(s => `${s.name}=${s.ok ? "ok" : "FAIL"}`).join(" ")}`);
      }
    }
  } finally {
    await browser.close();
    await cleanupTempDirs();
  }

  const failures = compareReports(reports.main, reports.candidate);
  if (failures.length) {
    console.error("\nPARITY MISMATCH:");
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log("\nPARITY OK — candidate matches main on all recorded features.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
