import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

// runImprove moved to chat.ts in the frontend split. Assertion semantics are
// unchanged; only the source file (and the routeProposal/api calls now going
// through `deps`) moved.
const mainSource = readFileSync(new URL("./main.ts", import.meta.url), "utf8");
const chatSource = readFileSync(new URL("./chat.ts", import.meta.url), "utf8");

function sourceBetween(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return source.slice(startIndex, endIndex);
}

describe("Improve proposal flow", () => {
  const runImproveSource = sourceBetween(
    chatSource,
    "async function runImprove",
    "chatImproveEl.addEventListener",
  );

  it("routes streamed proposal events instead of dumping proposal JSON or HTML into chat", () => {
    expect(runImproveSource).toContain("routeProposal(e)");
  });

  it("approves every Improve proposal — markdown legacy or HTML structured — through the single approveProposal path", () => {
    expect(runImproveSource).toContain("result.proposalId");
    expect(runImproveSource).toContain("api.approveProposal(");
    expect(runImproveSource).toMatch(/approveProposal\(\{\s*threadId: id, proposalId\s*\}\)/);
    // The applyProposal RPC is gone end-to-end — Apply never falls back to it.
    expect(runImproveSource).not.toContain("api.applyProposal(");
    expect(mainSource).not.toContain("api.applyProposal(");
  });

  it("Apply's already-resolved retry cleans up like a success instead of re-enabling the button", () => {
    // The stuck-card bug's markdown-side hole:
    // this handler calls api.approveProposal DIRECTLY (not via ui.ts's proposalActions),
    // so it needs its own already-resolved handling. Pin that its catch consults
    // alreadyResolvedStatus and, when it matches, removes the box + reloads (approved
    // only) + returns BEFORE the ordinary re-enable/reportError failure path — the
    // button must stay disabled while the stale box is torn down.
    const applyHandler = sourceBetween(
      runImproveSource,
      "applyBtn.addEventListener(\"click\"",
      "chatImproveEl.disabled = false;",
    );
    const catchBlock = sourceBetween(applyHandler, "} catch (e) {", "});");
    expect(catchBlock).toContain("alreadyResolvedStatus(e)");
    expect(catchBlock).toContain("box.remove();");
    expect(catchBlock).toMatch(/if \(resolved === "approved"\) await deps\.reloadActiveDoc\(\);/);
    // cleanup returns before the failure path — the button is NOT re-enabled
    const returnAt = catchBlock.indexOf("return;");
    const reEnableAt = catchBlock.indexOf("applyBtn.disabled = false;");
    expect(returnAt).toBeGreaterThanOrEqual(0);
    expect(reEnableAt).toBeGreaterThan(returnAt);
  });
});
