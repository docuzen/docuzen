import { describe, expect, it } from "vitest";

// task-0: the desktop chat pane's DOM wiring isn't unit-testable in this package's
// vitest setup (no jsdom — see ui.test.ts's file header), so this pins the real chat.ts
// source the same way its siblings do (agent-retry-ux.test.ts, agents-panel.test.ts).
//
// Bug trace: a bubble whose turn resolved with no streamed text used to read
// "No response from ${meta}" where `meta` is `streamingAgentTurn`'s header label —
// STANCE for discuss/reply/branch calls (e.g. "none"), not a model — producing the
// user-visible "No response from none" bubble under header "AGENT · NONE". Separately,
// any REAL error (a genuine thrown detail, once pi-runner.ts stopped swallowing it) was
// rendered as a single flat line with no distinction between the actual detail and the
// generic "check your model settings" hint. These tests pin both fixes: `who` is derived
// only from a model id/name, never `meta`, and both the fail() and empty-reply paths
// render the real headline prominently with the generic hint demoted to a secondary line.
import { chatSource } from "./module-source.test-support.js";

function sourceBetween(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return source.slice(startIndex, endIndex);
}

const streamingAgentTurnSource = sourceBetween(
  chatSource,
  "function streamingAgentTurn(meta?: string, modelId?: string): {",
  "\n  /**\n   * True while `threadId` has a turn actually in flight",
);

describe("streamingAgentTurn's empty-reply/fail text never blames the stance", () => {
  it("computes `who` from modelId/the footer model — never from `meta` (the stance label)", () => {
    expect(streamingAgentTurnSource).toContain(
      'const who = deps.modelName(modelId || deps.getFooterModelId()) || "the agent";',
    );
    // The historical bug: `meta || modelName(...)` — meta is the STANCE for discuss/
    // reply/branch bubbles, so this must never reappear in the who computation.
    expect(streamingAgentTurnSource).not.toContain("meta || modelName(chatModelEl.value)");
  });

  it("still uses `meta` for the header label — stance IS the right label there", () => {
    expect(streamingAgentTurnSource).toContain(
      "textContent = `Agent · ${meta ?? \"default\"}`;",
    );
  });
});

describe("streamingAgentTurn's fail()/empty-reply bubbles: real detail prominent, hints demoted", () => {
  it("renders a shared headline (the actual detail) plus a smaller secondary hint line", () => {
    expect(streamingAgentTurnSource).toContain("const renderFailBody = (headline: string): void => {");
    expect(streamingAgentTurnSource).toContain('head.className = "tbody-fail-headline";');
    expect(streamingAgentTurnSource).toContain('hint.className = "tbody-fail-hint";');
    expect(streamingAgentTurnSource).toContain("head.textContent = `⚠ ${headline}`;");
  });

  it("fail() passes the REAL thrown message as the headline, not a canned placeholder", () => {
    const failSource = sourceBetween(streamingAgentTurnSource, "fail: (msg) => {", "\n      },\n    };");
    expect(failSource).toContain("renderFailBody(msg);");
  });

  it("the empty-reply path still demotes the generic model/gateway/rate-limit hint under a 'No response' headline", () => {
    const doneSource = sourceBetween(streamingAgentTurnSource, "done: (finalText) => {", "fail: (msg) => {");
    expect(doneSource).toContain('renderFailBody(`No response from ${who} — it returned no content.`);');
    // AGENT_FAIL_HINT (the demoted line renderFailBody appends to every bubble) is declared
    // just above streamingAgentTurn, so check the whole file rather than the sliced source.
    expect(chatSource).toContain(
      "Check the model in File ▸ Settings: a wrong/forbidden model id, an unreachable",
    );
  });
});

describe("streamingAgentTurn call sites pass the actual model driving each bubble", () => {
  it("dispatchQueuedTurn (discuss/reply) passes item.modelId alongside item.stance", () => {
    expect(chatSource).toContain(
      "const bubble = isActive ? streamingAgentTurn(item.stance, item.modelId) : null;",
    );
  });

  it("runBranch passes its resolved modelId alongside the stance", () => {
    const runBranchSource = sourceBetween(
      chatSource,
      'const runBranch = async (doc: "latest" | "at-turn"): Promise<void> => {',
      "latestBtn.addEventListener",
    );
    expect(runBranchSource).toContain("const modelId = chatModelEl.value || undefined;");
    expect(runBranchSource).toContain("const bubble = streamingAgentTurn(chatStanceEl.value, modelId);");
  });

  it("runCardAskAgent passes its resolved modelId alongside the stance", () => {
    // The card resolves its own model picker and hands it over with the stance...
    const cardSource = sourceBetween(
      chatSource,
      "const runCardAskAgent = async (): Promise<void> => {",
      "discussBtn.addEventListener",
    );
    expect(cardSource).toContain("modelId: modelSel.value || undefined");
    // ...and the pane-side flow labels the bubble with that stance + model.
    const flowSource = sourceBetween(chatSource, "async function askAgentFromCard(", "async function resendFromCard(");
    expect(flowSource).toContain("const bubble = streamingAgentTurn(ask.stance, ask.modelId);");
  });

  it("the panel fan-out passes the same per-bubble model id it already uses as meta", () => {
    expect(chatSource).toContain("b = streamingAgentTurn(modelName(model) || model, model);");
  });
});
