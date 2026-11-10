// Perf probe: load a document of a given size in the real frontend (Vite dev, hermetic
// sidecar), then CPU-profile typing and cursor movement. Prints timings + top functions.
//
//   node tools/perf/probe.mjs [paragraphs=400] [comments=0]
import { chromium } from "playwright";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { launchTree, cleanupTempDirs } from "../parity/launch.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
process.env.TAURI_DEV_HOST ??= "127.0.0.1";

const PARAS = Number(process.argv[2] ?? 400);
const COMMENTS = Number(process.argv[3] ?? 0);
const para = (i) =>
  `Paragraph ${i}: the rate limiter uses a token bucket per API key, stored in Redis with a TTL, and **falls back** to a local in-memory bucket when Redis is unreachable so that requests are never blocked by a cache outage. See \`limits.ts\` for the refill math.`;
let doc = "# Perf fixture\n\n";
for (let i = 1; i <= PARAS; i++) {
  if (i % 40 === 0) doc += `## Section ${i / 40}\n\n`;
  if (i % 100 === 0) doc += "| Feature | Status |\n|---|---|\n| Limits | Done |\n| Retries | WIP |\n\n";
  doc += para(i) + "\n\n";
}
const dir = await mkdtemp(join(tmpdir(), "perf-"));
const docPath = join(dir, "big.md");
await writeFile(docPath, doc);

const srv = await launchTree(repo, { vitePort: 4640, docPath });
const browser = await chromium.launch();
try {
  const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
  const t0 = Date.now();
  await page.goto(srv.url);
  await page.locator("#log").filter({ hasText: "editor mounted" }).waitFor({ state: "attached", timeout: 60_000 });
  await page.waitForFunction((n) => document.querySelectorAll("#editor p").length >= n, PARAS, { timeout: 60_000 });
  const loadMs = Date.now() - t0;

  // optional: add comments to exercise annotation decorations + rail
  for (let i = 0; i < COMMENTS; i++) {
    await page.locator("#editor p").nth(i * 3 + 1).click({ clickCount: 3 });
    await page.locator("#popover").waitFor({ state: "visible", timeout: 5_000 });
    await page.locator("#popover button.popcomment").click();
    await page.waitForFunction((n) => document.querySelectorAll("#comments > *").length > n, i, { timeout: 10_000 });
  }

  const cdp = await page.context().newCDPSession(page);
  async function profile(label, fn, events) {
    await cdp.send("Profiler.enable");
    await cdp.send("Profiler.setSamplingInterval", { interval: 200 });
    await cdp.send("Profiler.start");
    const t = Date.now();
    await fn();
    // let trailing work (debounced serialization) settle
    await page.waitForTimeout(400);
    const wall = Date.now() - t - 400;
    const { profile } = await cdp.send("Profiler.stop");
    const self = new Map();
    const dt = profile.timeDeltas;
    const byId = new Map(profile.nodes.map((n) => [n.id, n]));
    let total = 0;
    profile.samples.forEach((id, i) => {
      const n = byId.get(id);
      const f = n.callFrame;
      const file = (f.url.split("/").pop() || "").split("?")[0];
      const key = `${f.functionName || "(anonymous)"} ${file}:${f.lineNumber + 1}`;
      const us = dt[i] ?? 0;
      if (f.functionName !== "(idle)" && f.functionName !== "(program)") total += us;
      self.set(key, (self.get(key) ?? 0) + us);
    });
    const top = [...self.entries()].filter(([k]) => !k.startsWith("(idle)") && !k.startsWith("(program)")).sort((a, b) => b[1] - a[1]).slice(0, 12);
    console.log(`\n== ${label}: ${events} events, wall ${wall} ms (${(wall / events).toFixed(1)} ms/event), JS busy ${(total / 1000).toFixed(0)} ms (${(total / 1000 / events).toFixed(1)} ms/event)`);
    for (const [k, us] of top) console.log(`   ${(us / 1000).toFixed(0).padStart(6)} ms  ${k}`);
  }

  const target = page.locator("#editor p").nth(Math.floor(PARAS / 2));
  await target.click();
  await profile("typing 60 chars mid-document", async () => {
    await page.keyboard.type("the quick brown fox jumps over the lazy dog and keeps running", { delay: 0 });
  }, 60);
  await profile("moving the cursor 60 times (no edits)", async () => {
    for (let i = 0; i < 60; i++) await page.keyboard.press("ArrowLeft");
  }, 60);
  const heap = await page.evaluate(() => performance.memory?.usedJSHeapSize ?? 0);
  console.log(`\nload → rendered: ${loadMs} ms; doc ${(doc.length / 1024).toFixed(0)} KB, ${PARAS} paragraphs, ${COMMENTS} comments; DOM nodes ${await page.evaluate(() => document.querySelectorAll("*").length)}; JS heap ${(heap / 1e6).toFixed(0)} MB`);
} finally {
  await browser.close();
  await srv.stop();
  await cleanupTempDirs();
  await rm(dir, { recursive: true, force: true });
}
