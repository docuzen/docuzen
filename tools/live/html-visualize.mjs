// Live check for Visualize on an HTML document: real frontend + sidecar + model. Selects a
// table cell, asks for a diagram, clicks Insert, and checks the saved file and the view.
//
//   set -a; . ~/.secrets; set +a; node tools/live/html-visualize.mjs
import { chromium } from "playwright";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { launchTree } from "../parity/launch.mjs";

process.env.TAURI_DEV_HOST ??= "127.0.0.1";
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

const dir = await mkdtemp(join(tmpdir(), "live-html-"));
const docPath = join(dir, "report.html");
const HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Report</title><style>body{font-family:sans-serif}</style></head>
<body>
<h1>Rate limiter rollout</h1>
<p>The client calls the gateway, the gateway asks the limiter, and the limiter reads counters from Redis before the request reaches the service.</p>
<table><tr><th>Step</th><th>Owner</th></tr><tr><td>Deploy limiter</td><td>Platform</td></tr></table>
<p>Closing paragraph.</p>
</body></html>
`;
await writeFile(docPath, HTML);
const srv = await launchTree(repoRoot, { vitePort: 4632, docPath, realConfig: true });
const browser = await chromium.launch();
try {
  const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
  await page.goto(srv.url);
  const frame = page.frameLocator("iframe").first();
  await frame.locator("h1").waitFor({ state: "visible", timeout: 30_000 });
  await frame.locator("p").first().click({ clickCount: 3 });
  await page.locator("#popover").waitFor({ state: "visible", timeout: 5_000 });
  await page.locator("#popover button.popaction", { hasText: "Visualize" }).click();
  const insert = page.locator("#chatTurns .proposal .papply:not([disabled])");
  await insert.waitFor({ state: "visible", timeout: 180_000 });
  check("Insert into doc is enabled on an HTML document", true);
  check("the diagram preview rendered in the chat pane", (await page.locator("#chatTurns .proposal .mermaid-rendered svg").count()) === 1);
  await insert.click();
  await page.locator("#chatTurns .proposal").waitFor({ state: "detached", timeout: 30_000 });
  const saved = await readFile(docPath, "utf8");
  check("the saved HTML contains the diagram figure with an SVG", /<figure class="docuzen-diagram"[^>]*>\s*<svg/.test(saved));
  check("the figure sits right after the selected paragraph", /<\/p>\s*<figure class="docuzen-diagram"/.test(saved) && saved.indexOf("docuzen-diagram") < saved.indexOf("<table"));
  check("the rest of the document is intact", saved.includes("<td>Deploy limiter</td>") && saved.includes("Closing paragraph.") && !saved.includes("```"));
  await frame.locator("figure.docuzen-diagram svg").waitFor({ state: "visible", timeout: 15_000 });
  const box = await frame.locator("figure.docuzen-diagram svg").boundingBox();
  check("the diagram is visible in the document view", !!box && box.width > 100 && box.height > 40, box ? `${Math.round(box.width)}×${Math.round(box.height)}` : "");
  await page.screenshot({ path: process.env.SHOT ?? join(dir, "shot.png") });
} finally {
  await browser.close();
  await srv.stop();
  if (!process.env.SHOT) await rm(dir, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} check(s) FAILED` : "\nLIVE HTML VISUALIZE OK");
process.exit(failures ? 1 : 0);
