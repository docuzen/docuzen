import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

// Live testing found the Agents badge and panel disagreeing on the running-task count
// (badge computed from raw server rows, panel from a merged server+optimistic list),
// optimistic placeholder rows that could in principle outlive their RPC forever (a hung
// backend that never settles the promise), and `Orchestrator.reconcile` never being
// called anywhere so a killed sidecar's stuck "running" rows lived forever. This suite
// exercises the chat.ts source the same way the rest of this file's siblings do
// (agent-retry-ux.test.ts, popover-layout.test.ts): string assertions over the real
// TypeScript source, since chat.ts's DOM wiring isn't otherwise unit-testable in this
// package's vitest setup (no jsdom — see ui.test.ts's file header).
const chatSource = readFileSync(new URL("./chat.ts", import.meta.url), "utf8");

function sourceBetween(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return source.slice(startIndex, endIndex);
}

describe("Agents badge/panel single source of truth (item 5)", () => {
  const mergedTasksSource = sourceBetween(
    chatSource,
    "async function mergedTasks(",
    "async function refreshAgents(",
  );
  const refreshAgentsSource = sourceBetween(
    chatSource,
    "async function refreshAgents(",
    "/** Update just the Agents button",
  );
  const refreshAgentsBadgeSource = sourceBetween(
    chatSource,
    "async function refreshAgentsBadge(",
    "setInterval(() => void refreshAgentsBadge()",
  );

  it("refreshAgents (the panel) renders from mergedTasks, not a raw listTasks call", () => {
    expect(refreshAgentsSource).toContain("await mergedTasks()");
    expect(refreshAgentsSource).not.toContain("await deps.api.listTasks(");
  });

  it("refreshAgentsBadge (the 2s poll) renders from the SAME mergedTasks function as the panel", () => {
    expect(refreshAgentsBadgeSource).toContain("updateAgentsBadge(await mergedTasks())");
    expect(refreshAgentsBadgeSource).not.toContain("await deps.api.listTasks(");
  });

  it("mergedTasks is the one place that merges server rows with optimistic placeholders", () => {
    expect(mergedTasksSource).toContain("await deps.api.listTasks({})");
    expect(mergedTasksSource).toContain("optimisticTasks");
    // A real backend row wins over a same-id optimistic placeholder.
    expect(mergedTasksSource).toContain("if (!byId.has(id)) byId.set(id, t);");
  });
});

describe("Optimistic task lifecycle (item 6)", () => {
  const mergedTasksSource = sourceBetween(
    chatSource,
    "async function mergedTasks(",
    "async function refreshAgents(",
  );

  it("sweeps optimistic placeholders past a TTL even if their RPC never settled", () => {
    expect(mergedTasksSource).toContain("OPTIMISTIC_TASK_TTL_MS");
    expect(mergedTasksSource).toContain("optimisticTasks.delete(id)");
  });

  it("defines the TTL as roughly 5 minutes", () => {
    const decl = sourceBetween(
      chatSource,
      "const OPTIMISTIC_TASK_TTL_MS",
      ";",
    );
    expect(decl).toContain("5 * 60 * 1000");
  });

  it("clears the review optimistic task in a finally block (settles on success AND failure)", () => {
    const runReviewSource = sourceBetween(
      chatSource,
      "async function runReview(",
      "reviewRunEl.addEventListener",
    );
    expect(runReviewSource).toContain("setOptimisticTask(\"review\", \"running\")");
    const finallyBlock = sourceBetween(runReviewSource, "} finally {", "\n  }");
    expect(finallyBlock).toContain('clearOptimisticTask("review")');
  });

  it("clears the directives optimistic task via runStreamingTurn's onSettled (fires on rejection too)", () => {
    const runResolveSource = sourceBetween(
      chatSource,
      "async function runResolveDirectives(",
      "resolveDirectivesBtn.addEventListener",
    );
    expect(runResolveSource).toContain('setOptimisticTask("directives", "running")');
    const onSettled = sourceBetween(runResolveSource, "onSettled: () => {", "},");
    expect(onSettled).toContain('clearOptimisticTask("directives")');
  });
});

describe("Errored agent rows surface errorText (part of the original brief)", () => {
  const renderGroupSource = sourceBetween(
    chatSource,
    "const renderGroup = (label: string, rows: TaskRow[], cap?: number): void => {",
    "if (tasks.length === 0) {",
  );

  it("shows the first line of errorText inline and the full text as a tooltip", () => {
    expect(renderGroupSource).toContain('t.status === "error" && t.errorText');
    expect(renderGroupSource).toContain('t.errorText.split("\\n")[0]');
    expect(renderGroupSource).toContain("row.title = tooltip");
  });

  it("also sets the tooltip on the status chip (the Attention popover's error indicator)", () => {
    expect(renderGroupSource).toContain("chip.title = tooltip");
  });
});

describe("Live review progress (part of the original brief)", () => {
  const runReviewSource = sourceBetween(
    chatSource,
    "async function runReview(",
    "reviewRunEl.addEventListener",
  );

  it('counts incoming {event:"finding"} frames into a live "N findings so far" status', () => {
    expect(runReviewSource).toContain('e.event === "finding"');
    expect(runReviewSource).toContain("count++");
    expect(runReviewSource).toContain("so far");
  });
});

// "All the work given to agents should be chattable" — every real agent thread
// should be openable from the Agents panel; only rows with no real thread yet
// (optimistic placeholders) stay inert.
describe("Agents panel row click respects optimistic vs real rows", () => {
  const renderGroupSource = sourceBetween(
    chatSource,
    "const renderGroup = (label: string, rows: TaskRow[], cap?: number): void => {",
    "if (tasks.length === 0) {",
  );

  it("gates clickability on referential identity against the live optimisticTasks entry", () => {
    // A real backend TaskRow always wins the mergedTasks() merge over a same-id
    // optimistic placeholder, so `optimisticTasks.get(t.threadId) === t` is true ONLY
    // while `t` is still the un-reconciled placeholder object itself.
    expect(renderGroupSource).toContain("optimisticTasks.get(t.threadId) === t");
  });

  it("does not add the clickable class or a click listener to an optimistic-only row", () => {
    const optimisticBranch = sourceBetween(
      renderGroupSource,
      "if (optimisticTasks.get(t.threadId) === t) {",
      "} else {",
    );
    expect(optimisticBranch).not.toContain("clickable");
    expect(optimisticBranch).not.toContain("addEventListener");
  });

  it("still opens real rows (comment threads via promoteToChat, others via openThreadById)", () => {
    const realBranch = sourceBetween(renderGroupSource, "} else {", "agentsPanel.appendChild(row);");
    expect(realBranch).toContain('row.classList.add("clickable")');
    expect(realBranch).toContain("if (comments.has(t.threadId)) void promoteToChat(t.threadId);");
    expect(realBranch).toContain("else void openThreadById(t.threadId, taskTitle(t.threadId));");
  });
});

// The server-side gap that forced the two hides below is fixed. discuss()/reply()/
// resumeFromTranscript() used to all hard-require
// `readAnnotations(docPath).find(a => a.id === threadId)` (orchestrator.ts) and throw
// "annotation not found" — reproduced directly against the real Orchestrator in the
// report's trace — because neither a directive-N thread nor the "review" umbrella
// thread ever gets a persisted annotation (only comment/branch threads do; see
// Orchestrator.resolveDirectives/review). reply()/resumeFromTranscript() now tolerate a
// missing annotation for a thread that already exists (the thread FILE existing is
// still the identity check — a nonexistent thread still errors); discuss() is
// unchanged (it only ever creates NEW threads from an annotation). So directive/review
// threads are chattable: both pseudo-thread hides are gone, `openThreadById` tracks the
// opened thread as `activeChatId` so Send actually targets it, and `showDirectiveResult`
// (a multi-directive result banner, not a single thread) does the same only when it's
// summarizing exactly one directive — otherwise there's no single thread to reply into
// and `activeChatId` stays null, same as before. `panel()`/`improve()` were NOT touched
// server-side (still hard-require an annotation), so Improve/Panel explicitly refuse a
// pseudo-thread (no CommentEntry) rather than trade the old hidden-footer for a
// guaranteed RPC error on click.
describe("Directive/review pseudo-thread footer is repliable", () => {
  const openThreadByIdSource = sourceBetween(
    chatSource,
    "async function openThreadById(",
    "function showDirectiveResult(",
  );
  const showDirectiveResultSource = sourceBetween(
    chatSource,
    "function showDirectiveResult(",
    "async function runResolveDirectives(",
  );

  it("openThreadById shows the footer and tracks the opened thread as activeChatId", () => {
    expect(openThreadByIdSource).not.toContain("chatFootEl.hidden = true");
    expect(openThreadByIdSource).toContain("chatFootEl.hidden = false");
    expect(openThreadByIdSource).toContain("activeChatId = id;");
  });

  it("showDirectiveResult shows the footer only when a single directive thread is addressable", () => {
    expect(showDirectiveResultSource).not.toContain("chatFootEl.hidden = true");
    // Conditional: visible for the 1-directive case (real reply target), hidden for
    // the N≠1 summary banner where Send would have no thread to address.
    expect(showDirectiveResultSource).toContain("chatFootEl.hidden = threadId === undefined;");
    expect(showDirectiveResultSource).toContain("activeChatId = threadId ?? null;");
  });

  it("the single-directive no-proposal outcome passes that directive's threadId through", () => {
    const runResolveSource = sourceBetween(
      chatSource,
      "async function runResolveDirectives(",
      "resolveDirectivesBtn.addEventListener",
    );
    expect(runResolveSource).toContain('res.count === 1 ? "directive-1" : undefined');
  });

  it("dispatchQueuedTurn replies (never discusses) into a thread with no CommentEntry", () => {
    // Phase 9 T1 moved the actual discuss/reply dispatch out of chatSendEl's click
    // handler (now just commitSend(id, msg) + the instant input clear) and into
    // dispatchQueuedTurn, shared by the direct-send and queued-drain paths — see
    // task-1-report.md.
    const dispatchSource = sourceBetween(
      chatSource,
      "async function dispatchQueuedTurn(",
      "function commitSend(",
    );
    // Old gate (`if (!entry) return;`) would have made Send a silent no-op for a
    // pseudo-thread; it's gone, and discuss() only fires for a real, undiscussed entry.
    expect(dispatchSource).not.toContain("if (!entry) return;");
    expect(dispatchSource).toContain("if (entry && !entry.discussed) {");
    expect(dispatchSource).toContain("if (entry) setCommentActionState(entry, \"responded\");");
  });

  it("Improve and Panel refuse a thread with no CommentEntry — their server calls still require an annotation", () => {
    const chatImproveSource = sourceBetween(
      chatSource,
      'chatImproveEl.addEventListener("click"',
      "chatSendEl.addEventListener",
    );
    expect(chatImproveSource).toContain("if (!comments.has(id)) return;");

    const chatPanelSource = sourceBetween(
      chatSource,
      'chatPanelEl.addEventListener("click"',
      "// --- document-wide Agent Review Pass",
    );
    expect(chatPanelSource).toContain("if (!entry) return;");
  });
});

describe("Directive-pass proposal events reach routeProposal unfiltered (Phase-8 T2)", () => {
  it("resolveDirectives' onEvent forwards every event to routeProposal, gated on nothing", () => {
    const runResolveSource = sourceBetween(
      chatSource,
      "async function runResolveDirectives(",
      "resolveDirectivesBtn.addEventListener",
    );
    // Traced against Orchestrator.resolveDirectives (persistProposal emits {type:
    // "proposal"} from the turn's own in-memory `ann`, never re-read from disk — the
    // one call site among discuss/reply/resolveDirectives that doesn't need a persisted
    // annotation) and proposals.ts's routeProposal/renderProposal (which already special-
    // cases `/^directive-\d+$/` thread ids for fallback placement). No filter drops
    // proposal events here; this pins that so a future refactor can't silently add one.
    expect(runResolveSource).toContain("(e) => void deps.routeProposal(e)");
  });
});

describe("Streamed bubbles re-render to the persisted reply on done() (Phase-8 T2)", () => {
  const streamingAgentTurnSource = sourceBetween(
    chatSource,
    "function streamingAgentTurn(meta?: string, modelId?: string): {",
    "  /**\n   * Replace a \"you\" turn's body with an inline editor",
  );

  it("done() accepts an optional finalText and re-renders when it differs from the stream", () => {
    expect(streamingAgentTurnSource).toContain("done: (finalText) => {");
    expect(streamingAgentTurnSource).toContain("finalText !== undefined && finalText !== replyText");
    expect(streamingAgentTurnSource).toContain('renderTurnText(body, "agent", finalText)');
  });

  it("defines fetchLastAgentReply as the best-effort getThread round-trip for {ok}-only RPCs", () => {
    expect(chatSource).toContain("async function fetchLastAgentReply(threadId: string): Promise<string | undefined> {");
    expect(chatSource).toContain('const last = thread.turns[thread.turns.length - 1];');
    expect(chatSource).toContain('return last?.role === "agent" ? last.body : undefined;');
  });

  it("dispatchQueuedTurn wires fetchLastAgentReply into bubble.done() on success", () => {
    // See the identical Phase 9 T1 relocation note above (chatSend's own dispatch
    // logic moved into dispatchQueuedTurn).
    const dispatchSource = sourceBetween(
      chatSource,
      "async function dispatchQueuedTurn(",
      "function commitSend(",
    );
    expect(dispatchSource).toContain("bubble?.done(await fetchLastAgentReply(threadId));");
  });

  it("the comment card's Ask-agent flow wires fetchLastAgentReply into bubble.done() too", () => {
    const runCardAskAgentSource = sourceBetween(
      chatSource,
      "const runCardAskAgent = async (): Promise<void> => {",
      "discussBtn.addEventListener",
    );
    expect(runCardAskAgentSource).toContain("bubble.done(await fetchLastAgentReply(id));");
  });

  it("the panel fan-out resolves each model's final text from ONE getThread, keyed by turn.meta", () => {
    const panelSource = sourceBetween(
      chatSource,
      'chatPanelEl.addEventListener("click"',
      "// --- document-wide Agent Review Pass",
    );
    expect(panelSource).toContain('const finalTurns = await deps.api.getThread({ threadId: id }).catch(() => null);');
    expect(panelSource).toContain('tn.role === "agent" && tn.meta === model');
    expect(panelSource).toContain("bubbles.forEach((b, model) => b.done(lastReplyFor(model)));");
  });

  it("branch's bubble.done() takes no argument — promoteToChat re-renders the new thread fresh right after", () => {
    // beginEditBranch's runBranch calls bubble.done() with no argument: unlike
    // chatSend/panel/card-discuss, its very next lines call promoteToChat(branchThreadId),
    // which clears chatTurnsEl and re-renders every turn from getThread — so any stale
    // streamed text in the bubble is already superseded before the user could act on it.
    const runBranchSource = sourceBetween(
      chatSource,
      'const runBranch = async (doc: "latest" | "at-turn"): Promise<void> => {',
      "latestBtn.addEventListener",
    );
    expect(runBranchSource).toContain("bubble.done();");
    expect(runBranchSource).toContain("await promoteToChat(res.branchThreadId);");
  });
});
