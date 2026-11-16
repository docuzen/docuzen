// Browser check for images in documents: the real frontend + the real sidecar (no model),
// in WebKit (what the packaged app runs) and Chromium. Drops and pastes an image onto a
// markdown and an HTML document and asserts what a user would see and what lands on disk:
// the picture renders, the file is in `<doc>.had/assets/`, and the saved document links it
// by a relative path with nothing app-specific in it.
//
//   node tools/visual/images.mjs            # both engines
//   ENGINE=webkit node tools/visual/images.mjs
//   SHOT_DIR=/some/dir node tools/visual/images.mjs   # also write screenshots
//
// Not part of `npm test` (needs browsers + servers, takes ~30s).
import { chromium, webkit } from "playwright";
import { mkdir, mkdtemp, readFile, readdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { launchTree, cleanupStaged } from "./support.mjs";

process.env.TAURI_DEV_HOST ??= "127.0.0.1";
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const shotDir = process.env.SHOT_DIR;
// A 40x24 solid PNG, so "it rendered" is checkable by its natural size.
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAACgAAAAYCAIAAAAH5iiXAAAAKElEQVR42mPQz78wIIhh1OJRi0ctHrV41OJRi0ctHrV41OJRi4ePxQAdsFzMFVZOYwAAAABJRU5ErkJggg==";

const MD = `# Rollout plan

The first paragraph explains the goal of the rollout in a sentence or two.

The second paragraph covers the risks and who owns each of them.

![existing](pics/existing.png)
`;
const HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Report</title><style>body{font-family:sans-serif;max-width:640px;margin:2rem auto}</style></head>
<body>
<h1>Rate limiter rollout</h1>
<p>The client calls the gateway, and the gateway asks the limiter.</p>
<ul><li>First step</li><li>Second step</li></ul>
<p>Closing paragraph. <img src="pics/existing.png" alt="existing"></p>
</body></html>
`;

/** Real images only: ProseMirror adds its own caret-helper <img>s around an inline node. */
const IMG = "img:not(.ProseMirror-separator)";

let failures = 0;
function check(name, ok, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}

/** Dispatch a drop/paste carrying one PNG file on `locator`, at the given fraction of its height. */
async function sendImage(locator, type, name, yFraction = 0.75) {
  await locator.evaluate(
    (el, { type, name, b64, yFraction }) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const dt = new DataTransfer();
      dt.items.add(new File([bytes], name, { type: "image/png" }));
      const r = el.getBoundingClientRect();
      const init = { bubbles: true, cancelable: true, clientX: r.left + 20, clientY: r.top + r.height * yFraction };
      const win = el.ownerDocument.defaultView;
      const ev =
        type === "paste"
          ? new win.ClipboardEvent("paste", { ...init, clipboardData: dt })
          : new win.DragEvent(type, { ...init, dataTransfer: dt });
      el.dispatchEvent(ev);
    },
    { type, name, b64: PNG_B64, yFraction },
  );
}

const loaded = (img) => img.evaluate((el) => el.complete && el.naturalWidth === 40);

async function run(engineName, engine, kind, vitePort) {
  console.log(`\n${engineName} · ${kind}`);
  const dir = await mkdtemp(join(tmpdir(), "images-"));
  const docPath = join(dir, kind === "md" ? "my plan.md" : "my report.html");
  await writeFile(docPath, kind === "md" ? MD : HTML);
  await mkdir(join(dir, "pics"));
  await writeFile(join(dir, "pics", "existing.png"), Buffer.from(PNG_B64, "base64"));
  const assets = join(dir, ".docuzen", `${kind === "md" ? "my plan.md" : "my report.html"}.had`, "assets");
  const srv = await launchTree(repoRoot, { vitePort, docPath });
  const browser = await engine.launch();
  try {
    const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
    await page.goto(srv.url);
    await page.locator("#log").filter({ hasText: "editor mounted" }).waitFor({ state: "attached", timeout: 30_000 });
    const root = kind === "md" ? page.locator("#editor") : page.frameLocator("iframe.htmlframe").locator("body");
    await root.locator("h1").waitFor({ state: "visible", timeout: 30_000 });

    // An image the document already links by a relative path renders.
    const existing = root.locator(IMG).first();
    await existing.waitFor({ state: "attached", timeout: 10_000 });
    await page.waitForTimeout(500);
    check("an existing relative image renders", await loaded(existing));

    // Drop on the lower half of the first paragraph: the image becomes the next block.
    const firstPara = root.locator("p").first();
    await sendImage(firstPara, "dragover", "Screen Shot.png");
    await sendImage(firstPara, "drop", "Screen Shot.png");
    await page.waitForFunction(
      (k) => {
        const d = k === "md" ? document : document.querySelector("iframe.htmlframe").contentDocument;
        return d.querySelectorAll(k === "md" ? "#editor img:not(.ProseMirror-separator)" : "body img").length === 2;
      },
      kind,
      { timeout: 10_000 },
    );
    const dropped = root.locator(IMG).first();
    await page.waitForTimeout(500);
    check("the dropped image renders", await loaded(dropped));
    const order = await root.evaluate((el) =>
      [...el.querySelectorAll("h1, p, ul")].map((b) => (b.querySelector("img:not(.ProseMirror-separator)") ? "IMG" : b.tagName)).join(" "),
    );
    check("it sits right after the paragraph it was dropped on", /^H1 P IMG /.test(order), order);
    check("the file is in the document's .had/assets", (await readdir(assets)).join() === "Screen-Shot.png");

    // Paste a screenshot at the caret (end of the last paragraph).
    const lastPara = root.locator("p").nth(2);
    await lastPara.click();
    await sendImage(lastPara, "paste", "image.png");
    await page.waitForFunction(
      (k) => {
        const d = k === "md" ? document : document.querySelector("iframe.htmlframe").contentDocument;
        return d.querySelectorAll(k === "md" ? "#editor img:not(.ProseMirror-separator)" : "body img").length === 3;
      },
      kind,
      { timeout: 10_000 },
    );
    const names = (await readdir(assets)).sort();
    check("a pasted image is stored once (same bytes) under the dropped file's name or a pasted- name", names.length >= 1 && names.length <= 2, names.join(", "));

    // A text file dropped on the document is refused and the app is still there.
    await root.locator("h1").evaluate((el) => {
      const dt = new DataTransfer();
      dt.items.add(new File(["hello"], "notes.txt", { type: "text/plain" }));
      el.dispatchEvent(new el.ownerDocument.defaultView.DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
    });
    await page.waitForTimeout(200);
    check("a non-image drop changes nothing", (await root.locator(IMG).count()) === 3 && ((await page.locator("#log").textContent()) ?? "").includes("only image files"));

    if (shotDir) await page.screenshot({ path: join(shotDir, `images-${engineName}-${kind}.png`) });

    // Sync the document to disk (the directive pass saves first; no model is configured,
    // so nothing else happens) and read what was written.
    await page.locator("#resolveDirectivesBtn").click({ force: true }).catch(() => {});
    let saved = "";
    for (let i = 0; i < 40 && !saved.includes("assets/"); i++) {
      await page.waitForTimeout(250);
      saved = await readFile(docPath, "utf8");
    }
    const link = kind === "md" ? "![Screen Shot](.docuzen/my%20plan.md.had/assets/Screen-Shot.png)" : 'src=".docuzen/my%20report.html.had/assets/Screen-Shot.png"';
    check("the saved document links the image by a relative path", saved.includes(link), saved.match(/[^\n]*assets\/[^\n]*/)?.[0]?.slice(0, 120) ?? "(no link)");
    check("the saved document keeps the existing link as authored", saved.includes("pics/existing.png"));
    check("nothing app-specific leaks into the saved file", !saved.includes("127.0.0.1") && !saved.includes("data-had"));
  } finally {
    await browser.close();
    await srv.stop();
    await rm(dir, { recursive: true, force: true });
  }
}

const engines = { webkit, chromium };
const wanted = process.env.ENGINE ? [process.env.ENGINE] : ["webkit", "chromium"];
let port = 4640;
try {
  for (const name of wanted) {
    for (const kind of ["md", "html"]) await run(name, engines[name], kind, port++);
  }
} finally {
  await cleanupStaged();
}
console.log(failures ? `\n${failures} check(s) FAILED` : "\nIMAGES OK");
process.exit(failures ? 1 : 0);
