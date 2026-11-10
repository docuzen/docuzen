// Startup + render probe: how long until a document is usable, per browser engine, and
// what it costs to (re)render a document with mermaid diagrams — the work a tab switch or
// a post-approve reload repeats.
//
//   node tools/perf/startup.mjs
import { chromium, webkit } from "playwright";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { launchTree, cleanupTempDirs } from "../parity/launch.mjs";

process.env.TAURI_DEV_HOST ??= "127.0.0.1";
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function makeDoc(paras, diagrams) {
  let doc = "# Perf fixture\n\n";
  for (let i = 1; i <= paras; i++) {
    doc += `Paragraph ${i}: the rate limiter uses a token bucket per API key, stored in Redis with a TTL, and **falls back** to a local bucket when Redis is unreachable.\n\n`;
    if (diagrams && i % Math.ceil(paras / diagrams) === 0) {
      doc += "```mermaid\nflowchart LR\n  Client --> Gateway --> Limiter --> Redis\n  Limiter --> Service\n  Service --> DB\n```\n\n";
    }
  }
  return doc;
}

const dir = await mkdtemp(join(tmpdir(), "perf-startup-"));
async function measure(engineName, engine, paras, diagrams) {
  const docPath = join(dir, `d-${paras}-${diagrams}.md`);
  const text = makeDoc(paras, diagrams);
  diagrams = (text.match(/```mermaid/g) ?? []).length; // what the fixture really contains
  await writeFile(docPath, text);
  const srv = await launchTree(repo, { vitePort: 4641, docPath });
  const browser = await engine.launch();
  try {
    const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
    let requests = 0;
    let bytes = 0;
    page.on("response", async (r) => {
      requests++;
      const len = Number(r.headers()["content-length"] ?? 0);
      bytes += len;
    });
    const t0 = Date.now();
    await page.goto(srv.url);
    await page.locator("#log").filter({ hasText: "editor mounted" }).waitFor({ state: "attached", timeout: 90_000 });
    const mounted = Date.now() - t0;
    await page.waitForFunction((n) => document.querySelectorAll("#editor p").length >= n, paras, { timeout: 90_000 });
    if (diagrams) {
      await page.waitForFunction((n) => document.querySelectorAll("#editor .mermaid-rendered svg").length >= n, diagrams, { timeout: 120_000 });
    }
    const usable = Date.now() - t0;

    // typing wall-clock (no profiler: works on every engine)
    await page.locator("#editor p").nth(Math.floor(paras / 2)).click();
    const tt = Date.now();
    await page.keyboard.type("the quick brown fox jumps over the lazy dog", { delay: 0 });
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    const typing = (Date.now() - tt) / 43;

    // what a tab switch / post-approve reload repeats: re-render the whole document
    const tr = Date.now();
    await page.reload();
    await page.locator("#log").filter({ hasText: "editor mounted" }).waitFor({ state: "attached", timeout: 90_000 });
    await page.waitForFunction((n) => document.querySelectorAll("#editor p").length >= n, paras, { timeout: 90_000 });
    if (diagrams) {
      await page.waitForFunction((n) => document.querySelectorAll("#editor .mermaid-rendered svg").length >= n, diagrams, { timeout: 120_000 });
    }
    const warm = Date.now() - tr;
    console.log(
      `${engineName.padEnd(9)} ${String(paras).padStart(4)} paras ${String(diagrams).padStart(2)} diagrams | cold: mounted ${String(mounted).padStart(5)} ms, usable ${String(usable).padStart(5)} ms | warm reload ${String(warm).padStart(5)} ms | typing ${typing.toFixed(1)} ms/key | ${requests} requests`,
    );
  } finally {
    await browser.close();
    await srv.stop();
  }
}

try {
  for (const [name, engine] of [["chromium", chromium], ["webkit", webkit]]) {
    for (const [paras, diagrams] of [[100, 0], [400, 0], [100, 8], [1500, 0]]) {
      try {
        await measure(name, engine, paras, diagrams);
      } catch (e) {
        console.log(`${name.padEnd(9)} ${paras} paras ${diagrams} diagrams | FAILED: ${String(e).split("\n")[0]}`);
      }
    }
  }
} finally {
  await cleanupTempDirs();
  await rm(dir, { recursive: true, force: true });
}
