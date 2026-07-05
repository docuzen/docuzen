// Drives docuzen's review flow for the README hero recording, against a live
// sidecar+Vite tree whose default harness is the real Codex CLI. Every wait is
// on a real DOM signal; pause() adds human-readable dwell time for the video.
const pause = (page, ms) => page.waitForTimeout(ms);

export async function driveDemo(page, url) {
  // 1) Boot the doc (same readiness waits as tools/visual/states.mjs).
  await page.goto(url);
  await page.locator("#log").filter({ hasText: "editor mounted" }).waitFor({ state: "attached", timeout: 20_000 });
  await page.waitForFunction(() => (document.querySelector("#editor")?.textContent ?? "").length > 80);
  await pause(page, 1400);

  // 2) Highlight the wordy first sentence — the selection popover appears.
  await page.locator("#editor p").first().click({ clickCount: 3 });
  await page.locator("#popover").waitFor({ state: "visible", timeout: 5_000 });
  await pause(page, 900);

  // 3) Click the "Improve" quick action. improveMode always persists the agent's
  //    rewrite as a proposal, so an approvable edit appears regardless of the
  //    agent's reply format (unlike a freeform discuss turn).
  await page.locator("#popover .popaction", { hasText: "Improve" }).click();

  // Collapse the selection by clicking a lower line — the popover only shows while a
  // non-collapsed selection is live (surface.ts updatePopover), so this dismisses it
  // so it doesn't linger over the document. Target a line BELOW the popover (which is
  // anchored over the highlighted first paragraph) so the click isn't intercepted.
  await page.locator("#editor li").last().click();
  await pause(page, 500);

  // 4) The real Codex agent rewrites the sentence; wait for the proposal's approve
  //    control to enable (chat-pane "Apply and version", or the inline doc card).
  const approve = page.locator(".proposal .papply:not([disabled]), .proposal-inline .approve").first();
  await approve.waitFor({ state: "visible", timeout: 120_000 });
  await pause(page, 2400); // let the viewer read the proposed rewrite (old vs new)

  // 5) Apply and version — writes the edit and snapshots a restorable version.
  await approve.click();
  await pause(page, 2600);
}
