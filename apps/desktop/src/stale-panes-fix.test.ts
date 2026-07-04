import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

// Tab-switch stale-pane fix — root-cause tests.
//
// Bug: switching tabs left the left pane (thread tree) and right pane (review form)
// showing the previous document's content. Two root causes:
//
// 1. refreshThreadTree() had no staleness guard: an in-flight listThreads call from
//    the previous tab could resolve AFTER the new tab's call started, overwriting
//    threadNodes and re-rendering the thread tree with stale data.
//
// 2. resetChat() (called on every tab switch) cleared #comments and chatTurns but
//    did NOT: (a) synchronously clear threadTreeEl before the async re-fetch, leaving
//    the old thread list visible during the fetch window; (b) reset reviewForm.hidden
//    or reviewStatusEl, leaving the previous document's review status in the right pane.
//
// Source-text pins per this package's convention (chat.ts's DOM wiring is not
// otherwise unit-testable in this vitest setup — no jsdom; see agents-panel.test.ts).
const chatSource = readFileSync(new URL("./chat.ts", import.meta.url), "utf8");

function sourceBetween(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return source.slice(startIndex, endIndex);
}

describe("refreshThreadTree staleness guard (root cause 1 — left-pane race condition)", () => {
  const refreshTreeSource = sourceBetween(
    chatSource,
    "async function refreshThreadTree(): Promise<void> {",
    "function renderThreadTree(): void {",
  );

  it("increments the generation counter on every call", () => {
    expect(refreshTreeSource).toContain("const gen = ++treeGen;");
  });

  it("discards stale listThreads results when a newer call has started (post-await guard)", () => {
    expect(refreshTreeSource).toContain("if (gen !== treeGen) return;");
  });

  it("also guards the error path so a stale failing call cannot corrupt state", () => {
    // Two separate `if (gen !== treeGen) return;` checks — one in the catch block,
    // one after the await resolves successfully.
    const guards = [...refreshTreeSource.matchAll(/if \(gen !== treeGen\) return;/g)];
    expect(guards.length).toBeGreaterThanOrEqual(2);
  });

  it("assigns threadNodes only from the winning (non-stale) resolution", () => {
    // Pattern: `threadNodes = nodes` (local var), NOT `threadNodes = await …` directly,
    // so the assignment is always after the staleness check.
    expect(refreshTreeSource).toContain("threadNodes = nodes;");
    expect(refreshTreeSource).not.toContain("threadNodes = await deps.api.listThreads");
  });
});

describe("treeGen module-level variable declared alongside threadNodes", () => {
  // Both should live in the same local scope block so the gen counter's
  // lifetime matches the thread-node cache it guards.
  it("declares treeGen as a let variable initialised to 0", () => {
    expect(chatSource).toContain("let treeGen = 0;");
  });
});

describe("resetChat synchronously clears stale pane content (root cause 2)", () => {
  const resetChatSource = sourceBetween(
    chatSource,
    "function resetChat(): void {",
    "async function refreshThreadModels(): Promise<void>",
  );

  it("clears threadTreeEl.innerHTML synchronously before the async re-fetch", () => {
    expect(resetChatSource).toContain('threadTreeEl.innerHTML = "";');
  });

  it("resets threadNodes to an empty array synchronously", () => {
    expect(resetChatSource).toContain("threadNodes = [];");
  });

  it("hides the review form so the previous document's review UI does not persist", () => {
    expect(resetChatSource).toContain("reviewForm.hidden = true;");
  });

  it("hides and empties the review status line", () => {
    expect(resetChatSource).toContain("reviewStatusEl.hidden = true;");
    expect(resetChatSource).toContain('reviewStatusEl.textContent = "";');
  });

  it("threadTreeEl clear precedes the refreshThreadSelect async kick-off", () => {
    const treeIdx = resetChatSource.indexOf('threadTreeEl.innerHTML = "";');
    const selectIdx = resetChatSource.indexOf("refreshThreadSelect();");
    expect(treeIdx).toBeGreaterThanOrEqual(0);
    expect(selectIdx).toBeGreaterThanOrEqual(0);
    expect(treeIdx).toBeLessThan(selectIdx);
  });
});
