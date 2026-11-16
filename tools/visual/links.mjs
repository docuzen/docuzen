// Browser check for following links in documents: the real frontend + the real sidecar (no
// model), in WebKit (what the packaged app runs) and Chromium.
//
// Outside the packaged app there is no OS opener, so a file link that reaches it shows
// "Could not open <name>: …" — which is exactly the evidence wanted here: the click was
// recognised as a link, resolved to the right file, and handed to the opener. Links that
// stay inside the app (another markdown document, a #fragment) are checked for real.
//
//   node tools/visual/links.mjs            # both engines
//   ENGINE=webkit node tools/visual/links.mjs
import { chromium, webkit } from "playwright";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { launchTree, cleanupStaged } from "./support.mjs";

process.env.TAURI_DEV_HOST ??= "127.0.0.1";
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const shotDir = process.env.SHOT_DIR;
const filler = Array.from({ length: 40 }, (_, i) => `Filler paragraph ${i + 1} so the page is long enough to scroll.`);

const MD = `# Reading list

| File | Paper |
| --- | --- |
| [\`001_001\`](papers/001_001.pdf) | FunSearch |

See the [plan](other%20plan.md) and jump to [the end](#the-end).

${filler.join("\n\n")}

## The end

${filler.join("\n\n")}
`;
const HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Reading list</title></head>
<body>
<h1>Reading list</h1>
<table><tr><td><a href="papers/001_001.pdf"><code>001_001</code></a></td><td>FunSearch</td></tr></table>
<p>See the <a href="other%20plan.md">plan</a>.</p>
</body></html>
`;

let failures = 0;
function check(name, ok, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}

async function run(engineName, engine, kind, vitePort) {
  console.log(`\n${engineName} · ${kind}`);
  const dir = await mkdtemp(join(tmpdir(), "links-"));
  const docPath = join(dir, kind === "md" ? "list.md" : "list.html");
  const source = kind === "md" ? MD : HTML;
  await writeFile(docPath, source);
  await writeFile(join(dir, "other plan.md"), "# The other plan\n\nHello.\n");
  const srv = await launchTree(repoRoot, { vitePort, docPath });
  const browser = await engine.launch();
  try {
    const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
    await page.goto(srv.url);
    await page.locator("#log").filter({ hasText: "editor mounted" }).waitFor({ state: "attached", timeout: 30_000 });
    const root = kind === "md" ? page.locator("#editor") : page.frameLocator("iframe.htmlframe").locator("body");
    await root.locator("h1").waitFor({ state: "visible", timeout: 30_000 });
    const notice = page.locator("#docNotice");
    const noticeText = async () => ((await notice.isVisible().catch(() => false)) ? await notice.innerText() : "");
    const clearNotice = () => page.evaluate(() => document.querySelector("#docNotice")?.setAttribute("hidden", ""));
    const tabs = () => page.locator("#tabs > *").count();
    const fileLink = root.locator("a", { hasText: "001_001" });
    const docLink = root.locator("a", { hasText: "plan" });

    if (kind === "html") {
      // Review mode (Edit off): a plain click follows the link.
      await fileLink.click();
      await notice.waitFor({ state: "visible", timeout: 5_000 }).catch(() => {});
      check("review mode: a click hands the file to the opener", (await noticeText()).includes("001_001.pdf"), await noticeText());
      await clearNotice();
      await page.locator("#htmlEditToggle").click();
    }

    // Editable text: a plain click only places the caret.
    const before = await tabs();
    await fileLink.click();
    await docLink.click();
    await page.waitForTimeout(400);
    check("editable: a plain click opens nothing", (await noticeText()) === "" && (await tabs()) === before, await noticeText());

    // ⌘-click follows the link.
    await fileLink.click({ modifiers: ["Meta"] });
    await notice.waitFor({ state: "visible", timeout: 5_000 }).catch(() => {});
    check("editable: ⌘-click hands the file to the opener", (await noticeText()).includes("001_001.pdf"), await noticeText());
    if (shotDir) await page.screenshot({ path: join(shotDir, `links-${engineName}-${kind}.png`) });
    await clearNotice();

    if (kind === "md") {
      await root.locator("a", { hasText: "the end" }).click({ modifiers: ["Meta"] });
      await page.waitForTimeout(400);
      const top = await root.locator("h2").evaluate((el) => el.getBoundingClientRect().top);
      check("⌘-click on a #fragment scrolls to that heading", top >= 0 && top < 400, `heading top ${Math.round(top)}`);
    }

    // A linked markdown document opens in a tab of its own.
    await docLink.scrollIntoViewIfNeeded();
    await docLink.click({ modifiers: ["Meta"] });
    await page.locator("#editor h1", { hasText: "The other plan" }).waitFor({ state: "visible", timeout: 10_000 }).catch(() => {});
    check("⌘-click on a markdown link opens it in a new tab", (await tabs()) === before + 1 && (await page.locator("#editor h1").innerText()) === "The other plan");

    check("following links did not change the file", (await readFile(docPath, "utf8")) === source);
  } finally {
    await browser.close();
    await srv.stop();
    await rm(dir, { recursive: true, force: true });
  }
}

const engines = { webkit, chromium };
const wanted = process.env.ENGINE ? [process.env.ENGINE] : ["webkit", "chromium"];
let port = 4660;
try {
  for (const name of wanted) {
    for (const kind of ["md", "html"]) await run(name, engines[name], kind, port++);
  }
} finally {
  await cleanupStaged();
}
console.log(failures ? `\n${failures} check(s) FAILED` : "\nLINKS OK");
process.exit(failures ? 1 : 0);
