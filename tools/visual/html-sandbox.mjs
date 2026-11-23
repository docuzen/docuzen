// Can an HTML document's own scripts be blocked while the app keeps working on its page?
// The app reads, annotates and edits the document through listeners it attaches from the
// parent window (click, selectionchange, keydown, input), so whatever blocks the document's
// scripts must not also silence those. Two ways, each checked in WebKit (the macOS app's
// engine) and Chromium:
//
//   sandbox  <iframe sandbox="allow-same-origin">           (no allow-scripts)
//   csp      <iframe sandbox="allow-same-origin allow-scripts"> plus a
//            <meta http-equiv="Content-Security-Policy" content="script-src 'none'"> put
//            ahead of the document's own markup (marked data-had-overlay, so it is not saved)
//
// Everything is driven from the parent page by coordinates: Playwright cannot inject its
// helpers into a frame whose scripts are disabled, so frame locators hang there.
//
//   node tools/visual/html-sandbox.mjs           # both engines
//   ENGINE=webkit node tools/visual/html-sandbox.mjs
import { chromium, webkit } from "playwright";

const CSP_META = `<meta data-had-overlay http-equiv="Content-Security-Policy" content="script-src 'none'; object-src 'none'">`;

// Every way a document can run script: head and body <script>, an inline handler, an
// onerror, an SVG <script>, a nested srcdoc frame, and a javascript: link.
const DOC = `<!doctype html><html><head><title>t</title><script>document.title = "head script ran"</script></head><body>
<h1>Title</h1><p id="p">Hello world text here</p>
<p><a id="a" href="other.html">link</a> <a id="js" href="javascript:document.title='js url ran'">js</a></p>
<script>document.title = "body script ran";</script>
<p onclick="document.title='handler ran'" id="h">click me</p>
<img src="x-missing.png" onerror="document.title='onerror ran'">
<svg><script>document.title='svg script ran'</script></svg>
<iframe srcdoc="<script>parent.document.title='nested ran'</script>"></iframe>
</body></html>`;

/** Put the CSP meta first in <head>: after leading comments and the doctype, before any markup. */
function withCsp(html) {
  const lead = /^(﻿?\s*(?:<!--[\s\S]*?-->\s*)*<!doctype[^>]*>)/i.exec(html);
  return lead ? lead[1] + CSP_META + html.slice(lead[1].length) : CSP_META + html;
}

const MODES = {
  sandbox: { flags: "allow-same-origin", html: DOC },
  csp: { flags: "allow-same-origin allow-scripts", html: withCsp(DOC) },
};

const results = [];
function check(engine, mode, name, ok, detail = "") {
  results.push({ engine, mode, ok });
  console.log(`${ok ? "  ok  " : "  FAIL"} ${engine} · ${mode} · ${name}${detail ? ` — ${detail}` : ""}`);
}

async function run(engineName, engine, mode) {
  const { flags, html } = MODES[mode];
  const browser = await engine.launch();
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(5000);
    await page.setContent(`<!doctype html><html><body style="margin:0"><div id="host"></div></body></html>`);
    // What the app does on load (html-surface.ts / surface.ts): listeners from the parent, a
    // badge it creates whose click must not reach the page, links it handles itself.
    await page.evaluate(
      ({ flags, html }) =>
        new Promise((resolve) => {
          const f = document.createElement("iframe");
          f.setAttribute("sandbox", flags);
          f.style.cssText = "width:600px;height:500px;border:0";
          document.getElementById("host").appendChild(f);
          window.__seen = [];
          const seen = (what) => window.__seen.push(what);
          f.onload = () => {
            const doc = f.contentDocument;
            doc.addEventListener("selectionchange", () => seen("selectionchange"));
            doc.body.addEventListener("input", () => seen("input"));
            doc.addEventListener("keydown", () => seen("keydown"), true);
            doc.addEventListener("click", (e) => {
              const a = e.target.closest?.("a[href]");
              // Like surface.ts: a javascript: link is left to the page (so its blocking is tested).
              if (!a || /^javascript:/i.test(a.getAttribute("href"))) return;
              e.preventDefault();
              seen(`link:${a.id}`);
            });
            const badge = doc.createElement("span");
            badge.id = "badge";
            badge.textContent = " 1";
            badge.addEventListener("click", (e) => {
              e.stopPropagation();
              seen("badge");
            });
            doc.getElementById("p").appendChild(badge);
            resolve();
          };
          f.srcdoc = html;
        }),
      { flags, html },
    );
    await page.waitForTimeout(300);
    const box = (sel) =>
      page.evaluate((sel) => {
        const f = document.querySelector("iframe");
        const r = f.contentDocument.querySelector(sel).getBoundingClientRect();
        const fr = f.getBoundingClientRect();
        return { x: fr.left + r.left, y: fr.top + r.top, w: r.width, h: r.height };
      }, sel);
    const clickOn = async (sel, at = 0.5) => {
      const r = await box(sel);
      await page.mouse.click(r.x + r.w * at, r.y + r.h / 2);
    };
    const seen = () => page.evaluate(() => window.__seen);
    const frameTitle = () => page.evaluate(() => document.querySelector("iframe").contentDocument.title);

    await clickOn("#badge");
    await clickOn("#a");
    await clickOn("#h");
    await clickOn("#js");
    await page.waitForTimeout(300);
    const title = await frameTitle();
    check(engineName, mode, "the document's own scripts do not run", title === "t" && (await page.title()) === "", `title "${title}"`);
    const s1 = await seen();
    check(engineName, mode, "the app's click handlers run (badge, links)", s1.includes("badge") && s1.includes("link:a"), s1.join(" "));

    // Edit mode: type into the paragraph.
    await page.evaluate(() => (document.querySelector("iframe").contentDocument.body.contentEditable = "true"));
    await clickOn("#h", 0.98);
    await page.keyboard.press("End");
    await page.keyboard.type("XYZ");
    await page.waitForTimeout(300);
    const typed = await page.evaluate(() => document.querySelector("iframe").contentDocument.getElementById("h").textContent);
    check(engineName, mode, "editing works", typed.endsWith("XYZ"), JSON.stringify(typed));
    const s2 = await seen();
    check(engineName, mode, "the app sees keydown and input while editing", s2.includes("keydown") && s2.includes("input"));
    await page.evaluate(() => (document.querySelector("iframe").contentDocument.body.contentEditable = "false"));

    // Select by dragging (last: under Playwright's Chromium driver a drag in a frame with
    // scripts disabled closes the page).
    try {
      const r = await box("#p");
      await page.mouse.move(r.x + 2, r.y + r.h / 2);
      await page.mouse.down();
      await page.mouse.move(r.x + 80, r.y + r.h / 2, { steps: 5 });
      await page.mouse.up();
      const selected = await page.evaluate(() => document.querySelector("iframe").contentDocument.getSelection().toString());
      check(engineName, mode, "text can be selected", selected.length > 0, JSON.stringify(selected));
      check(engineName, mode, "the app sees selectionchange", (await seen()).includes("selectionchange"));
    } catch (err) {
      console.log(`  ----  ${engineName} · ${mode} · selecting by drag not measurable here: ${String(err.message).split("\n")[0]}`);
    }
  } finally {
    await browser.close();
  }
}

const engines = { webkit, chromium };
const wanted = process.env.ENGINE ? [process.env.ENGINE] : ["webkit", "chromium"];
for (const name of wanted) for (const mode of Object.keys(MODES)) await run(name, engines[name], mode);

for (const mode of Object.keys(MODES)) {
  const failed = results.filter((r) => r.mode === mode && !r.ok);
  console.log(`${mode}: ${failed.length ? `${failed.length} check(s) FAILED (${[...new Set(failed.map((r) => r.engine))].join(", ")})` : "OK"}`);
}
