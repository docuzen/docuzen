// Live UI check: the real frontend (Vite) + the real sidecar + a REAL model, driven
// through a browser the way a reviewer would. Complements tools/live/run.mjs (which
// drives the sidecar's RPC directly): this one proves the UI wiring end to end.
//
//   node tools/live/ui.mjs            # needs a usable pi model in ~/.docuzen/config.toml
//
// Not part of `npm test`: needs a key, costs tokens, takes a minute or two. Assertions are
// structural (a reply rendered, the document text changed), never about wording.
import { chromium } from "playwright";
import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { launchTree, stageFixture, cleanupStaged } from "../visual/support.mjs";

process.env.TAURI_DEV_HOST ??= "127.0.0.1";
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const fixture = resolve(repoRoot, "tools/demo/fixtures/demo.md");

let failures = 0;
function check(name, ok, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}

const docPath = await stageFixture(fixture);
const original = await readFile(docPath, "utf8");
const srv = await launchTree(repoRoot, { vitePort: 4630, docPath, realConfig: true });
const browser = await chromium.launch();
try {
  const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
  await page.goto(srv.url);
  await page.locator("#log").filter({ hasText: "editor mounted" }).waitFor({ state: "attached", timeout: 20_000 });
  await page.waitForFunction(() => (document.querySelector("#editor")?.textContent ?? "").length > 80);
  // The badge fills in after boot (listHarnesses + getSettings) — wait for it, don't race it.
  await page
    .waitForFunction(() => (document.querySelector("#harnessBadge")?.textContent ?? "").trim() !== "", undefined, { timeout: 15_000 })
    .catch(() => {});
  const badge = (await page.locator("#harnessBadge").textContent()) ?? "";
  const badgeTitle = (await page.locator("#harnessBadge").getAttribute("title")) ?? "";
  check("topbar shows the live harness + model", /Pi/.test(badge), `"${badge.replace(/\s+/g, " ").trim()}" (${badgeTitle.slice(0, 80)})`);

  // --- comment on the first paragraph, ask the agent from the card ---
  await page.locator("#editor p").first().click({ clickCount: 3 });
  await page.locator("#popover").waitFor({ state: "visible", timeout: 5_000 });
  await page.locator("#popover button.popcomment").click();
  const card = page.locator(".comment-card").first();
  await card.locator(".cinput").fill("Is this sentence too wordy? Answer in one sentence.");
  await card.locator(".discuss").click();
  await page.locator(".turn.turn-you").first().waitFor({ state: "visible", timeout: 5_000 });
  check("Stop is offered while the turn runs", await page.locator("#chatStop").isVisible());
  // The wait before the model's first byte shows a phase and a running clock, not a bare spinner.
  const seen = new Set();
  const watchPhases = (async () => {
    for (let i = 0; i < 400 && (await page.locator("#chatTurns .turn-agent.working").count()); i++) {
      const txt = await page.locator("#chatTurns .turn-agent.working .spin").first().textContent().catch(() => null);
      if (txt) seen.add(txt.replace(/ \d+s$/, (m) => ((seen.clock = true), "")));
      await page.waitForTimeout(100);
    }
  })();

  // type a follow-up WHILE the first turn is running: it must queue, then send itself
  await page.locator("#chatInput").fill("Now suggest a shorter version in one sentence.");
  await page.locator("#chatSend").click();
  const queuedShown = await page.locator(".turn.turn-you", { hasText: "queued" }).count();

  await page.waitForFunction(
    () => document.querySelectorAll("#chatTurns .turn-agent:not(.working)").length >= 2,
    undefined,
    { timeout: 180_000 },
  );
  await watchPhases;
  check("the working bubble showed its phase and elapsed seconds", seen.has("waiting for the model…") && seen.clock === true, [...seen].join(" → "));
  const agentBodies = await page.locator("#chatTurns .turn-agent .tbody").allInnerTexts();
  check("the card's Ask-agent turn rendered a real reply", agentBodies[0]?.trim().length > 10 && !agentBodies[0].includes("⚠"), agentBodies[0]?.slice(0, 80));
  check("a message typed mid-turn was queued, then delivered as a reply", queuedShown === 1 && agentBodies[1]?.trim().length > 10 && !agentBodies[1].includes("⚠"), agentBodies[1]?.slice(0, 80));
  // Ask for markdown and check it is rendered, not shown as asterisks and dashes.
  await page.locator("#chatInput").fill("Reply with exactly a two-item bulleted markdown list, and make one word bold with **double asterisks**.");
  await page.locator("#chatSend").click();
  await page.waitForFunction(
    () => document.querySelectorAll("#chatTurns .turn-agent:not(.working)").length >= 3,
    undefined,
    { timeout: 180_000 },
  );
  const mdBody = page.locator("#chatTurns .turn-agent .tbody").nth(2);
  check(
    "an agent reply renders markdown (list + bold), not raw syntax",
    (await mdBody.locator("li").count()) >= 2 && (await mdBody.locator("strong").count()) >= 1 && !(await mdBody.innerText()).includes("**"),
    (await mdBody.innerText()).slice(0, 80).replace(/\n/g, " / "),
  );
  check("the footer's options row is closed by default", !(await page.locator("#chatMore").isVisible()));
  await page.locator("#chatMoreBtn").click();
  check("the options row holds stance, model, panel and Resolve", (await page.locator("#chatMore #chatResolve").isVisible()) && (await page.locator("#chatMore #chatModel").isVisible()));
  if (process.env.LIVE_UI_SHOT) await page.screenshot({ path: process.env.LIVE_UI_SHOT });
  await page.locator("#chatMoreBtn").click();
  check("the queued chip is gone once delivered", (await page.locator(".turn.turn-you", { hasText: "queued" }).count()) === 0);
  check("card shows the thread as responded", (await card.locator(".chip").innerText()) === "responded");
  check("conversation left the document untouched", (await readFile(docPath, "utf8")) === original);

  // --- Improve (Suggesting): review box → Apply → document changes on disk ---
  await page.locator("#chatImprove").click();
  const apply = page.locator("#chatTurns .proposal .papply:not([disabled])");
  await apply.waitFor({ state: "visible", timeout: 180_000 });
  check("Suggesting mode: nothing is written before approval", (await readFile(docPath, "utf8")) === original);
  await apply.click();
  await page.locator("#chatTurns .proposal").waitFor({ state: "detached", timeout: 30_000 });
  const afterApply = await readFile(docPath, "utf8");
  check("Apply wrote the rewrite to the document", afterApply !== original);
  check("the editor shows the applied text", (await page.locator("#editor").innerText()).length > 20);

  // Editing mode is not driven here: Settings opens only from the native menu, which a
  // plain browser doesn't have. It is covered live at the RPC level (tools/live/run.mjs,
  // "direct") and in the UI with a scripted sidecar (chat-behaviour.test.ts).
} finally {
  await browser.close();
  await srv.stop();
  await cleanupStaged();
}

console.log(failures ? `\n${failures} check(s) FAILED` : "\nLIVE UI OK");
process.exit(failures ? 1 : 0);
