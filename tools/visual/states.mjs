// The fixed set of UI states this suite screenshots, driven end-to-end
// against a live docd sidecar + Vite dev server (same boot sequence as
// tools/parity/flows.mjs). Every state here is reachable with zero LLM
// configuration — see README.md's "what's covered" section for the states
// that were deliberately left out because they require a live agent call.
export const STATE_NAMES = [
  "01-table-doc",
  "02-annotated",
  "03-chat-turn",
  "04-search-open",
  "05-left-collapsed",
  "06-both-collapsed",
  "07-diagram-lightbox",
];

/**
 * Drive one full pass through all four states on `page` (already pointed at
 * a fresh sidecar+Vite instance for the table-doc fixture) and screenshot
 * each into `outDir`. Both the light-scheme and dark-scheme runs call this
 * with the exact same script against independently-launched, identically-
 * seeded servers, so any pixel difference between a light run and a dark run
 * of the same state is a real rendering difference, not incidental drift
 * from e.g. one run's annotation landing before the other's.
 */
export async function captureStates(page, url, outDir, shoot) {
  // ---- 01: boot the table doc ----
  await page.goto(url);
  // #log lives inside a collapsed <details>, so it's never "visible" until
  // Diagnostics is expanded — wait for it to be attached instead (mirrors
  // tools/parity/flows.mjs's own boot wait).
  await page.locator("#log").filter({ hasText: "editor mounted" }).waitFor({ state: "attached", timeout: 20_000 });
  // Docname readiness now comes from the active tab label — the topbar's
  // separate `#docname` subtitle was removed as redundant with the tab strip.
  await page.waitForFunction(() => {
    const el = document.querySelector("#tabs .tab.active .tname");
    return !!el && el.textContent !== "";
  });
  await page.waitForFunction(() => (document.querySelector("#editor")?.textContent ?? "").length > 100);
  // Wait for the GFM table to actually render as a <table> (deliverable 1's
  // own regression target) rather than screenshotting mid-parse.
  await page.locator("#editor table").waitFor({ state: "visible", timeout: 10_000 });
  await shoot(page, outDir, STATE_NAMES[0]);

  // ---- 02: annotate — triple-click the leading paragraph, open the
  // selection popover, click Comment (creates a real annotation + a
  // right-rail comment card; no agent call involved). ----
  const para = page.locator("#editor p").first();
  await para.click({ clickCount: 3 });
  await page.locator("#popover").waitFor({ state: "visible", timeout: 5_000 });
  const before = await page.locator("#comments > *").count();
  await page.locator("#popover button.popcomment").click();
  await page.waitForFunction(
    (n) => document.querySelectorAll("#comments > *").length > n,
    before,
    { timeout: 10_000 },
  );
  await shoot(page, outDir, STATE_NAMES[1]);

  // ---- 03: chat pane with a discussion turn ----
  // Typing into the new comment card and clicking "Ask agent" renders the
  // "you" turn into the chat pane SYNCHRONOUSLY, client-side, before any RPC
  // fires (chat.ts's runCardAskAgent calls chatTurn("you", …) first) — so a
  // real `.turn-you` bubble is guaranteed regardless of what the backend
  // does next. What the backend does next is also deterministic here: this
  // suite's docd sidecar is launched (via tools/parity/launch.mjs) with
  // LLM_API_KEY deleted from its env, and orchestrator.ts's discuss() calls
  // harnessForDoc() — which resolves the "pi" harness registered with
  // `available: false` and throws synchronously, before any network I/O —
  // as its very first statement. So the agent side always settles to the
  // same "⚠ agent harness unavailable: pi …" error bubble, fast and without
  // ever attempting a live LLM call. This is a real, agent-free discussion
  // turn — not a fake one — and it's the only way to render one without
  // wiring up either a live LLM or a scripted fake-runner sidecar.
  const card = page.locator(".comment-card").first();
  await card.locator(".cinput").fill("What do you think about this table?");
  await card.locator(".discuss").click();
  await page.locator(".turn.turn-you").first().waitFor({ state: "visible", timeout: 5_000 });
  await page.locator(".turn.turn-agent .tbody").filter({ hasText: "⚠" }).waitFor({ state: "visible", timeout: 15_000 });
  await shoot(page, outDir, STATE_NAMES[2]);

  // ---- 04: search open with matches ----
  // "token-bucket" appears once in prose and once inside a table cell (see
  // tools/visual/fixtures/table-doc.md), so this also re-confirms search
  // reaches table-cell text, not just top-level paragraphs.
  await page.locator("#searchBtn").click();
  await page.locator("#searchPanel").waitFor({ state: "visible" });
  await page.locator("#searchInput").fill("token-bucket");
  await page.waitForFunction(() => {
    const c = document.querySelector("#searchCount")?.textContent ?? "";
    return c !== "Type to search" && c.trim() !== "";
  });
  await shoot(page, outDir, STATE_NAMES[3]);
  await page.locator("#searchClose").click();

  // ---- 05: left pane (Agent discussion) collapsed via the topbar toggle ----
  // Phase 11 T1's sidebar toggles: clicking hides the pane (`display: none`
  // via a `.collapsed` class) and the doc canvas expands to fill the freed
  // space (`.doc`'s `flex: 1`) — this is the regression target.
  await page.locator("#toggleLeftBtn").click();
  await page.locator(".chatpane").waitFor({ state: "hidden" });
  await shoot(page, outDir, STATE_NAMES[4]);

  // ---- 06: both panes collapsed — the doc canvas at its widest ----
  await page.locator("#toggleRightBtn").click();
  await page.locator(".panel").waitFor({ state: "hidden" });
  await shoot(page, outDir, STATE_NAMES[5]);

  // ---- 07: mermaid diagram lightbox — hover the rendered diagram to reveal
  // its "expand" button, click it, and confirm the full-viewport pan/zoom
  // overlay (mermaid-lightbox.ts) opens. table-doc.md's "Annotation lifecycle"
  // fenced ```mermaid block is the only diagram in this fixture, so `.first()`
  // is just a defensive selector, not disambiguating between several. ----
  const diagramBox = page.locator(".mermaid-rendered").first();
  await diagramBox.hover();
  await diagramBox.locator(".mermaid-expand").click();
  await page.locator("#mermaidLightbox").waitFor({ state: "visible", timeout: 5_000 });
  await shoot(page, outDir, STATE_NAMES[6]);
}
