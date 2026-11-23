import { describe, expect, it } from "vitest";

// Instant input clear on commit + per-thread send queue. The pure FIFO/drain/halt
// mechanics live in
// send-queue.ts and are unit-tested directly there (send-queue.test.ts); this
// file pins how chat.ts WIRES that pure queue into the real Send button,
// transcript rendering, and RPC dispatch — string assertions over the real
// TypeScript source, since chat.ts's DOM wiring isn't otherwise unit-testable
// in this package's vitest setup (no jsdom — see ui.test.ts's header, and
// agents-panel.test.ts/agent-retry-ux.test.ts/chat-jump.test.ts for the same
// convention applied to other chat.ts behavior).
import { chatSource } from "./module-source.test-support.js";

function sourceBetween(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return source.slice(startIndex, endIndex);
}

describe("instant input clear on commit", () => {
  const clickSource = sourceBetween(chatSource, 'chatSendEl.addEventListener("click"', "});");

  it("commits the you-turn (queued or live) BEFORE clearing the input — not on turn success", () => {
    const commitIdx = clickSource.indexOf("commitSend(id, msg);");
    const clearIdx = clickSource.indexOf('chatInputEl.value = "";');
    expect(commitIdx).toBeGreaterThanOrEqual(0);
    expect(clearIdx).toBeGreaterThan(commitIdx);
  });

  it("no longer clears the input inside runStreamingTurn's onSuccess (the pre-fix bug: text lingered until turn success)", () => {
    const dispatchSource = sourceBetween(
      chatSource,
      "async function dispatchQueuedTurn(",
      "function commitSend(",
    );
    const onSuccessSource = sourceBetween(dispatchSource, "onSuccess: async () => {", "onError: (e) => {");
    expect(onSuccessSource).not.toContain("chatInputEl.value");
  });

  it("the Send click handler no longer disables itself while a turn is in flight — Send must stay usable to queue more messages", () => {
    expect(clickSource).not.toContain("chatSendEl.disabled");
  });

  it("showing Stop never hides the Send button — Stop and Send coexist while a thread is busy", () => {
    const refreshBusySource = sourceBetween(chatSource, "function refreshBusy(): void {", "// scope.stopped:");
    expect(refreshBusySource).not.toContain("chatSendEl.hidden");
    expect(refreshBusySource).toContain("chatStopEl.hidden = !busyThread;");
  });
});

describe("commitSend: dispatch immediately when free, queue (with a chip) when busy", () => {
  const commitSendSource = sourceBetween(
    chatSource,
    "function commitSend(threadId: string, text: string",
    'chatSendEl.addEventListener("click"',
  );

  it("checks the thread's in-flight state via the document generation's pure SendQueue, not the single busyThread/activeChatId globals", () => {
    expect(commitSendSource).toContain("t.scope.queue.isInFlight(threadId)");
  });

  it("a busy thread enqueues the item and renders it with a queued chip, without dispatching", () => {
    const busyBranch = sourceBetween(
      commitSendSource,
      "if (t.scope.queue.isInFlight(threadId)) {",
      'renderYouTurn(item, "live");',
    );
    expect(busyBranch).toContain("t.scope.queue.enqueue(item);");
    expect(busyBranch).toContain('renderYouTurn(item, "queued");');
    expect(busyBranch).toContain("return;");
    expect(busyBranch).not.toContain("driveSend(");
  });

  it("a free thread renders the turn live (no chip) and starts draining via the pure driveSend helper", () => {
    expect(commitSendSource).toContain('renderYouTurn(item, "live");');
    expect(commitSendSource).toContain("void driveSend(t.scope.queue, threadId, item,");
  });

  it("captures stance/model at commit time onto the QueuedTurn, not re-read later from the (possibly since-changed) footer pickers", () => {
    // (A held message sent again keeps the stance/model it was committed with.)
    expect(commitSendSource).toContain("stance: picked?.stance ?? chatStanceEl.value,");
    expect(commitSendSource).toContain("modelId: picked ? picked.modelId : chatModelEl.value || undefined,");
  });
});

describe("dispatchQueuedTurn: resolves the thread from the queue key, never from activeChatId", () => {
  const dispatchSource = sourceBetween(
    chatSource,
    "async function dispatchQueuedTurn(t: TurnCtx, item: QueuedTurn, wasQueued: boolean): Promise<SendOutcome> {",
    "function commitSend(",
  );

  it("takes threadId (and its document) as its own parameter rather than closing over activeChatId for the RPC calls", () => {
    expect(dispatchSource).toContain("const { threadId, docPath } = t;");
    expect(dispatchSource).toContain(
      "{ docPath, threadId, annotationId: threadId, stance: item.stance, comment: item.text,",
    );
    expect(dispatchSource).toContain("{ docPath, threadId, message: item.text, stance: item.stance,");
  });

  it("only puts its bubble in the pane while its thread is shown, and touches nothing once its document is gone", () => {
    // Checked when it matters, not snapshotted at dispatch start (H27): the bubble is
    // kept aside while another thread is shown and re-attached when this one reopens.
    expect(dispatchSource).not.toContain("const isActive = ");
    expect(dispatchSource).toContain("const bubble = turnBubble(t, item.stance, item.modelId);");
    expect(chatSource).toContain("const bubble = streamingAgentTurn(meta, modelId, { detached: !isShown(t) });");
    const onSuccessSource = sourceBetween(dispatchSource, "onSuccess: async () => {", "onError: (e) => {");
    expect(onSuccessSource).toContain("if (!isCurrent(t)) return;");
  });

  it("the margin card's chip/state updates run unconditionally — the right-margin card is visible regardless of the active pane", () => {
    expect(dispatchSource).toContain('setChip(threadId, "running");');
    expect(dispatchSource).not.toContain('if (isActive) setChip(');
  });

  it("clears only its own thread's busy bit; Stop is re-derived from the shown thread (a background settle can't stomp on a newer active thread)", () => {
    const onSettledSource = sourceBetween(dispatchSource, "onSettled: () => {", "});");
    expect(onSettledSource).toContain("t.scope.busy.delete(threadId);");
    expect(onSettledSource).toContain("if (isCurrent(t)) refreshBusy();");
  });

  it("failure marks the you-turn failed and, for a DIRECT (non-queued) send only, restores the text into an empty input", () => {
    const onErrorSource = sourceBetween(dispatchSource, "onError: (e) => {", "onSettled:");
    expect(onErrorSource).toContain("markYouTurnFailed(item, msg);");
    expect(onErrorSource).toContain("if (!wasQueued && isShown(t) && !chatInputEl.value.trim()) chatInputEl.value = item.text;");
  });

  it('a failed dispatch resolves "failed" (driveSend halts the rest of that thread\'s queue)', () => {
    expect(dispatchSource).toContain('if (!outcome.ok) return "failed";');
  });

  it('a Stop-cancelled turn resolves "stopped" even though the underlying RPC resolves normally — also halts draining', () => {
    // The flag is consumed on EVERY settle — before the failure return — so a
    // Stop that surfaces as an error cannot poison a later send on the same id.
    const consume = dispatchSource.indexOf("const wasStopped = t.scope.stopped.delete(threadId);");
    const failReturn = dispatchSource.indexOf('if (!outcome.ok) return "failed";');
    expect(consume).toBeGreaterThanOrEqual(0);
    expect(failReturn).toBeGreaterThan(consume);
    expect(dispatchSource).toContain('return wasStopped ? "stopped" : "sent";');
  });
});

describe("Stop halts draining, not just the in-flight turn (BIND)", () => {
  const stopSource = sourceBetween(
    chatSource,
    'chatStopEl.addEventListener("click"',
    "// --- per-thread send queue",
  );

  it("marks the thread stopped BEFORE cancelling, so the settling dispatch can tell a user-cancel apart from a plain success", () => {
    const addIdx = stopSource.indexOf("t.scope.stopped.add(t.threadId);");
    const cancelIdx = stopSource.indexOf("await deps.api.cancelTurn(");
    expect(addIdx).toBeGreaterThanOrEqual(0);
    expect(cancelIdx).toBeGreaterThan(addIdx);
  });
});

describe("queued chip ✕ removal", () => {
  const removePendingSource = sourceBetween(chatSource, "function removePending(", "function pendingChip(");

  it("removes the item from the pure queue AND its own transcript bubble, then forgets it", () => {
    expect(removePendingSource).toContain("s.queue.remove(item.threadId, item.id)");
    expect(removePendingSource).toContain("turnElByItemId.get(item.id)?.remove();");
    expect(removePendingSource).toContain("turnElByItemId.delete(item.id);");
    expect(sourceBetween(chatSource, "function pendingChip(", "function setPendingChip(")).toContain("removePending(s, item);");
  });
});

describe("wrong-thread isolation: rendering only ever touches the currently-displayed thread's pane", () => {
  it("renderYouTurn no-ops for any item whose threadId isn't the active pane", () => {
    const renderYouTurnSource = sourceBetween(
      chatSource,
      "function renderYouTurn(item: QueuedTurn, state: PendingState): void {",
      "function refreshPendingChips(",
    );
    expect(renderYouTurnSource).toContain("if (item.threadId !== activeChatId) return;");
  });

  it("promoteToChat and openThreadById replay a thread's still-pending items once it becomes active again", () => {
    const renderOpenedSource = sourceBetween(chatSource, "function renderOpenedThread(", "async function promoteToChat(");
    expect(renderOpenedSource).toContain('for (const item of scope.queue.held(id)) renderYouTurn(item, "held");');
    expect(renderOpenedSource).toContain('for (const item of scope.queue.list(id)) renderYouTurn(item, "queued");');

    const promoteToChatSource = sourceBetween(
      chatSource,
      "async function promoteToChat(id: string): Promise<void> {",
      'chatImproveEl.addEventListener("click"',
    );
    expect(promoteToChatSource).toContain("renderOpenedThread(id, () => {");

    const openThreadByIdSource = sourceBetween(
      chatSource,
      "async function openThreadById(id: string, title: string): Promise<void> {",
      "async function jumpToAnnotation(",
    );
    expect(openThreadByIdSource).toContain("renderOpenedThread(id, () => {");
  });

  it("deleting a comment/thread also drops its queue — no orphaned queued turns for a thread that no longer exists", () => {
    const removeCommentEntrySource = sourceBetween(
      chatSource,
      "function removeCommentEntry(id: string): void {",
      "/** Clear the comment registry",
    );
    expect(removeCommentEntrySource).toContain("scope.queue.clearThread(rid);");
  });

  it("switching documents empties the old queue and starts a new document generation — thread ids aren't unique across documents", () => {
    const resetChatSource = sourceBetween(
      chatSource,
      "function resetChat(): void {",
      "async function refreshThreadModels(",
    );
    expect(resetChatSource).toContain("scope.queue.resetAll();");
    expect(resetChatSource).toContain("scope = newScope();");
  });
});

describe("queued turns never count toward the Agents badge/panel running count", () => {
  it("mergedTasks/refreshAgents (the badge's only sources of truth) never reference the send queue", () => {
    const mergedTasksSource = sourceBetween(chatSource, "async function mergedTasks(", "async function refreshAgents(");
    const refreshAgentsSource = sourceBetween(chatSource, "async function refreshAgents(", "/** Update just the Agents button");
    expect(mergedTasksSource).not.toContain("sendQueue");
    expect(refreshAgentsSource).not.toContain("sendQueue");
  });
});
