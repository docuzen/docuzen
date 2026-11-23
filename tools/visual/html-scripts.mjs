// Browser check that an HTML document's own scripts stay blocked until the user runs them,
// with the real frontend + the real sidecar (no model), in WebKit (what the packaged app runs)
// and Chromium. The app itself must keep working on the page meanwhile: its listeners select,
// comment and handle links from the parent window.
//
// Why a policy and not the iframe sandbox: WebKit delivers no events to the app's listeners in
// a frame sandboxed without allow-scripts (see the history of tools/visual/html-sandbox.mjs).
//
//   node tools/visual/html-scripts.mjs            # both engines
//   ENGINE=webkit node tools/visual/html-scripts.mjs
import { chromium, webkit } from "playwright";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { launchTree, cleanupStaged } from "./support.mjs";

process.env.TAURI_DEV_HOST ??= "127.0.0.1";
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

// Every way the document could run code marks <html data-ran>.
const HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Scripts</title>
<script>document.documentElement.dataset.ran = "head script";</script></head>
<body>
<h1>Scripts</h1>
<p id="p">Select this sentence to comment on it.</p>
<p><a id="js" href="javascript:document.documentElement.dataset.ran='javascript: link'">a javascript link</a></p>
<p onclick="document.documentElement.dataset.ran='inline handler'" id="h">a paragraph with a handler</p>
<img src="missing.png" alt="" onerror="document.documentElement.dataset.ran='onerror'">
<svg width="10" height="10"><script>document.documentElement.dataset.ran='svg script'</script></svg>
<iframe srcdoc="<script>parent.document.documentElement.dataset.ran='nested frame'</script>"></iframe>
<script>document.documentElement.dataset.ran = "body script";</script>
</body></html>
`;

let failures = 0;
function check(name, ok, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}

async function run(engineName, engine, vitePort) {
  console.log(`\n${engineName}`);
  const dir = await mkdtemp(join(tmpdir(), "scripts-"));
  const docPath = join(dir, "scripts.html");
  await writeFile(docPath, HTML);
  const srv = await launchTree(repoRoot, { vitePort, docPath });
  const browser = await engine.launch();
  try {
    const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
    await page.goto(srv.url);
    await page.locator("#log").filter({ hasText: "editor mounted" }).waitFor({ state: "attached", timeout: 30_000 });
    const frame = page.frameLocator("iframe.htmlframe");
    await frame.locator("h1").waitFor({ state: "visible", timeout: 30_000 });
    await page.waitForTimeout(500); // let an onerror or a nested frame have its chance
    const ran = () =>
      page.evaluate(() => document.querySelector("iframe.htmlframe")?.contentDocument?.documentElement?.dataset.ran ?? "");
    const notice = page.locator(".htmlscripts");

    check("no script of the document ran", (await ran()) === "", await ran());
    check("the page says its scripts are blocked", await notice.isVisible());

    await frame.locator("#h").click();
    await frame.locator("#js").click();
    await page.waitForTimeout(300);
    check("an inline handler and a javascript: link do nothing", (await ran()) === "", await ran());

    await frame.locator("#p").click({ clickCount: 3 });
    await page.locator("#popover").waitFor({ state: "visible", timeout: 5_000 }).catch(() => {});
    check("selecting text still opens the comment popover", await page.locator("#popover").isVisible());
    const before = await page.locator("#comments > *").count();
    await page.locator("#popover button.popcomment").click();
    await page.waitForFunction((n) => document.querySelectorAll("#comments > *").length > n, before, { timeout: 10_000 }).catch(() => {});
    check("and commenting still works", (await page.locator("#comments > *").count()) > before);

    await notice.locator("button").click();
    await page.waitForFunction(
      () => !!document.querySelector("iframe.htmlframe")?.contentDocument?.documentElement?.dataset.ran,
      null,
      { timeout: 10_000 },
    ).catch(() => {});
    check("Run scripts runs them", (await ran()) !== "", await ran());
    check("and the notice goes away", !(await notice.isVisible()));

    check("blocking and running scripts never changed the file", (await readFile(docPath, "utf8")) === HTML);
  } finally {
    await browser.close();
    await srv.stop();
    await rm(dir, { recursive: true, force: true });
  }
}

const engines = { webkit, chromium };
const wanted = process.env.ENGINE ? [process.env.ENGINE] : ["webkit", "chromium"];
let port = 4680;
try {
  for (const name of wanted) await run(name, engines[name], port++);
} finally {
  await cleanupStaged();
}
console.log(failures ? `\nHTML SCRIPTS: ${failures} check(s) failed` : "\nHTML SCRIPTS OK");
process.exit(failures ? 1 : 0);
