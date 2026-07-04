// Scripted feature flows. Every recorded detail must be deterministic —
// identical on any tree that implements the same behavior.

// Error messages can embed nondeterministic values — the per-run
// `?docdPort=<random>` URL, temp dirs from stageDoc — that would otherwise
// leak into the report and cause spurious main-vs-candidate mismatches.
// Keep only the error constructor name and the first line, with those
// values redacted.
function sanitizeError(e) {
  const ctorName = (e && e.constructor && e.constructor.name) || "Error";
  // String(e) already yields "<Name>: <message>" for real Error instances
  // (Error.prototype.toString), so prepending ctorName again duplicated it
  // ("Error: Error: ..."). Take the message on its own and build the
  // "<Name>: <first line>" prefix exactly once.
  const message = e && e.message != null ? String(e.message) : String(e);
  const firstLine = message.split("\n")[0]
    .replace(/http:\/\/127\.0\.0\.1:\d+[^\s"]*/g, "<url>")
    .replace(/\/tmp\/parity-[^\s"']*/g, "<tmp>")
    .replace(/\/var\/folders\/[^\s"']*/g, "<tmp>");
  return `${ctorName}: ${firstLine}`;
}

async function step(report, name, fn) {
  try {
    const details = (await fn()) ?? {};
    report.steps.push({ name, ok: true, details });
  } catch (e) {
    report.steps.push({ name, ok: false, details: { error: sanitizeError(e) } });
  }
}

async function shoot(page, outDir, name) {
  await page.screenshot({ path: `${outDir}/${name}.png`, fullPage: true });
}

export async function runFlows(page, { scenario, url, outDir }) {
  const report = { scenario, steps: [] };

  await step(report, "boot", async () => {
    await page.goto(url);
    // #log lives inside a collapsed <details>, so it's never "visible" (waitFor's
    // default state) until the user expands Diagnostics — wait for it to be
    // attached with the expected text instead of visible.
    await page.locator("#log").filter({ hasText: "editor mounted" }).waitFor({ state: "attached", timeout: 20_000 });
    // openDoc round-trip: the active tab's label is set once the doc loads.
    // (The topbar used to mirror this in a separate `#docname` subtitle, but
    // that was removed as a redundant-with-the-tab-strip UI cleanup — main
    // still has `#docname`, so this reads the active tab label instead,
    // which is identical DOM on both trees, see apps/desktop/src/shell.ts's
    // `renderTabBar`/main's `main.ts` equivalent.)
    await page.waitForFunction(() => {
      const el = document.querySelector("#tabs .tab.active .tname");
      return !!el && el.textContent !== "";
    });
    await shoot(page, outDir, `${scenario}-01-boot`);
    return {
      docname: await page.locator("#tabs .tab.active .tname").textContent(),
      tabCount: await page.locator("#tabs > *").count(),
      editorVisible: await page.locator("#editor").isVisible(),
      htmlHostVisible: await page.locator("#htmlHost").isVisible(),
    };
  });

  await step(report, "render", async () => {
    if (scenario === "md") {
      await page.waitForFunction(() => (document.querySelector("#editor")?.textContent ?? "").length > 100);
      const text = await page.locator("#editor").innerText();
      const headings = await page.locator("#editor h1, #editor h2, #editor h3").allInnerTexts();
      return { textLength: text.length, headings };
    }
    const frame = page.frameLocator("#htmlHost iframe");
    await frame.locator("body").waitFor({ timeout: 20_000 });
    const text = await frame.locator("body").innerText();
    return { textLength: text.length, headings: await frame.locator("h1, h2, h3").allInnerTexts() };
  });

  await step(report, "search", async () => {
    await page.locator("#searchBtn").click();
    await page.locator("#searchPanel").waitFor({ state: "visible" });
    await page.locator("#searchInput").fill("the");
    await page.waitForFunction(() => {
      const c = document.querySelector("#searchCount")?.textContent ?? "";
      return c !== "Type to search" && c.trim() !== "";
    });
    const count = await page.locator("#searchCount").textContent();
    await shoot(page, outDir, `${scenario}-02-search`);
    await page.locator("#searchClose").click();
    return { count };
  });

  if (scenario === "md") {
    await step(report, "annotate", async () => {
      // Triple-click selects a paragraph; the selection popover offers swatches
      // (highlight only, no margin card) and a Comment action. The margin rail
      // (#comments) only grows for comments, so exercise that button.
      const para = page.locator("#editor p").first();
      await para.click({ clickCount: 3 });
      await page.locator("#popover").waitFor({ state: "visible", timeout: 5_000 });
      await shoot(page, outDir, `${scenario}-03-popover`);
      const before = await page.locator("#comments > *").count();
      await page.locator("#popover button.popcomment").click();
      await page.waitForFunction(
        (n) => document.querySelectorAll("#comments > *").length > n, before, { timeout: 10_000 });
      await shoot(page, outDir, `${scenario}-04-annotated`);
      return { cardsAfter: await page.locator("#comments > *").count() };
    });

    await step(report, "annotation-persists", async () => {
      await page.reload();
      await page.locator("#log").filter({ hasText: "editor mounted" }).waitFor({ state: "attached", timeout: 20_000 });
      await page.waitForFunction(() => document.querySelectorAll("#comments > *").length > 0, undefined, { timeout: 15_000 });
      await shoot(page, outDir, `${scenario}-05-persisted`);
      return { cards: await page.locator("#comments > *").count() };
    });
  }

  await step(report, "agents-panel", async () => {
    await page.locator("#agentsBtn").click();
    await page.locator("#agentsPanel").waitFor({ state: "visible" });
    // The panel starts empty and fills in once the async listTasks RPC resolves;
    // wait for that instead of racing it right after the click.
    await page.waitForFunction(() => (document.querySelector("#agentsPanel")?.textContent ?? "").trim().length > 0, undefined, { timeout: 10_000 });
    await shoot(page, outDir, `${scenario}-06-agents`);
    const text = await page.locator("#agentsPanel").innerText();
    await page.locator("#agentsBtn").click();
    return { empty: /no agent tasks/i.test(text) };
  });

  await step(report, "review-form", async () => {
    await page.locator("#reviewDocBtn").click();
    await page.locator("#reviewForm").waitFor({ state: "visible" });
    await shoot(page, outDir, `${scenario}-07-review-form`);
    await page.locator("#reviewCancel").click();
    return { reopens: true };
  });

  return report;
}
