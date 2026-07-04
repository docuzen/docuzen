import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

// Instant input clear on commit + per-thread send queue. The pure FIFO/drain/halt
// mechanics live in
// send-queue.ts and are unit-tested directly there (send-queue.test.ts); this
// file pins how chat.ts WIRES that pure queue into the real Send button,
// transcript rendering, and RPC dispatch — string assertions over the real
// TypeScript source, since chat.ts's DOM wiring isn't otherwise unit-testable
// in this package's vitest setup (no jsdom — see ui.test.ts's header, and
// agents-panel.test.ts/agent-retry-ux.test.ts/chat-jump.test.ts for the same
// convention applied to other chat.ts behavior).
const chatSource = readFileSync(new URL("./chat.ts", import.meta.url), "utf8");

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

  it("setChatBusy no longer hides the Send button — Stop and Send coexist while a thread is busy", () => {
    const setChatBusySource = sourceBetween(
      chatSource,
      "function setChatBusy(threadId: string | null): void {",
      "function clearBusyIfCurrent(",
    );
    expect(setChatBusySource).not.toContain("chatSendEl.hidden");
    expect(setChatBusySource).toContain("chatStopEl.hidden = !threadId;");
  });
});

describe("commitSend: dispatch immediately when free, queue (with a chip) when busy", () => {
  const commitSendSource = sourceBetween(
    chatSource,
    "function commitSend(threadId: string, text: string): void {",
    'chatSendEl.addEventListener("click"',
  );

  it("checks the thread's in-flight state via the pure SendQueue, not the single busyThread/activeChatId globals", () => {
    expect(commitSendSource).toContain("sendQueue.isInFlight(threadId)");
  });

  it("a busy thread enqueues the item and renders it with a queued chip, without dispatching", () => {
    const busyBranch = sourceBetween(
      commitSendSource,
      "if (sendQueue.isInFlight(threadId)) {",
      "renderYouTurn(item, { queued: false });",
    );
    expect(busyBranch).toContain("sendQueue.enqueue(item);");
    expect(busyBranch).toContain("renderYouTurn(item, { queued: true });");
    expect(busyBranch).toContain("return;");
    expect(busyBranch).not.toContain("driveSend(");
  });

  it("a free thread renders the turn live (no chip) and starts draining via the pure driveSend helper", () => {
    expect(commitSendSource).toContain("renderYouTurn(item, { queued: false });");
    expect(commitSendSource).toContain("void driveSend(sendQueue, threadId, item,");
  });

  it("captures stance/model at commit time onto the QueuedTurn, not re-read later from the (possibly since-changed) footer pickers", () => {
    expect(commitSendSource).toContain("stance: chatStanceEl.value,");
    expect(commitSendSource).toContain("modelId: chatModelEl.value || undefined,");
  });
});

describe("dispatchQueuedTurn: resolves the thread from the queue key, never from activeChatId", () => {
  const dispatchSource = sourceBetween(
    chatSource,
    "async function dispatchQueuedTurn(threadId: string, item: QueuedTurn, wasQueued: boolean): Promise<SendOutcome> {",
    "function commitSend(",
  );

  it("takes threadId as its own parameter rather than closing over activeChatId for the RPC calls", () => {
    expect(dispatchSource).toContain(
      "{ threadId, annotationId: threadId, stance: item.stance, comment: item.text,",
    );
    expect(dispatchSource).toContain("{ threadId, message: item.text, stance: item.stance,");
  });

  it("only touches the visible chat pane (bubble/setChatBusy) when the dispatching thread is still the active one", () => {
    expect(dispatchSource).toContain("const isActive = threadId === activeChatId;");
    expect(dispatchSource).toContain('const bubble = isActive ? streamingAgentTurn(item.stance, item.modelId) : null;');
    expect(dispatchSource).toContain("if (isActive) setChatBusy(threadId);");
  });

  it("the margin card's chip/state updates run unconditionally — the right-margin card is visible regardless of the active pane", () => {
    expect(dispatchSource).toContain('setChip(threadId, "running");');
    expect(dispatchSource).not.toContain('if (isActive) setChip(');
  });

  it("clears busy only if this thread is still the one being shown as busy (a background settle can't stomp on a newer active thread)", () => {
    expect(dispatchSource).toContain("onSettled: () => clearBusyIfCurrent(threadId),");
  });

  it("failure marks the you-turn failed and, for a DIRECT (non-queued) send only, restores the text into an empty input", () => {
    const onErrorSource = sourceBetween(dispatchSource, "onError: (e) => {", "onSettled:");
    expect(onErrorSource).toContain("markYouTurnFailed(item, msg);");
    expect(onErrorSource).toContain("if (!wasQueued && isActive && !chatInputEl.value.trim()) chatInputEl.value = item.text;");
  });

  it('a failed dispatch resolves "failed" (driveSend halts the rest of that thread\'s queue)', () => {
    expect(dispatchSource).toContain('if (!outcome.ok) return "failed";');
  });

  it('a Stop-cancelled turn resolves "stopped" even though the underlying RPC resolves normally — also halts draining', () => {
    // The flag is consumed on EVERY settle — before the failure return — so a
    // Stop that surfaces as an error cannot poison a later send on the same id.
    const consume = dispatchSource.indexOf("const wasStopped = stoppedThreads.delete(threadId);");
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
    const addIdx = stopSource.indexOf("stoppedThreads.add(threadId);");
    const cancelIdx = stopSource.indexOf("await deps.api.cancelTurn(");
    expect(addIdx).toBeGreaterThanOrEqual(0);
    expect(cancelIdx).toBeGreaterThan(addIdx);
  });
});

describe("queued chip ✕ removal", () => {
  const queuedChipSource = sourceBetween(
    chatSource,
    "function queuedChip(item: QueuedTurn): HTMLSpanElement {",
    "function renderYouTurn(",
  );

  it("removes the item from the pure queue AND its own transcript bubble, then forgets it", () => {
    expect(queuedChipSource).toContain("sendQueue.remove(item.threadId, item.id);");
    expect(queuedChipSource).toContain("turnElByItemId.get(item.id)?.remove();");
    expect(queuedChipSource).toContain("turnElByItemId.delete(item.id);");
  });
});

describe("wrong-thread isolation: rendering only ever touches the currently-displayed thread's pane", () => {
  it("renderYouTurn no-ops for any item whose threadId isn't the active pane", () => {
    const renderYouTurnSource = sourceBetween(
      chatSource,
      "function renderYouTurn(item: QueuedTurn, opts: { queued: boolean }): void {",
      "function stripQueuedChip(",
    );
    expect(renderYouTurnSource).toContain("if (item.threadId !== activeChatId) return;");
  });

  it("promoteToChat and openThreadById replay a thread's still-queued items once it becomes active again", () => {
    const promoteToChatSource = sourceBetween(
      chatSource,
      "async function promoteToChat(id: string): Promise<void> {",
      "chatThreadSelectEl.addEventListener",
    );
    expect(promoteToChatSource).toContain("for (const item of sendQueue.list(id)) renderYouTurn(item, { queued: true });");

    const openThreadByIdSource = sourceBetween(
      chatSource,
      "async function openThreadById(id: string, title: string): Promise<void> {",
      "async function jumpToAnnotation(",
    );
    expect(openThreadByIdSource).toContain("for (const item of sendQueue.list(id)) renderYouTurn(item, { queued: true });");
  });

  it("deleting a comment/thread also drops its queue — no orphaned queued turns for a thread that no longer exists", () => {
    const removeCommentEntrySource = sourceBetween(
      chatSource,
      "function removeCommentEntry(id: string): void {",
      "/** Clear the comment registry",
    );
    expect(removeCommentEntrySource).toContain("sendQueue.clearThread(id);");
  });

  it("switching documents resets the whole send queue — thread ids aren't unique across documents", () => {
    const resetChatSource = sourceBetween(
      chatSource,
      "function resetChat(): void {",
      "async function refreshThreadModels(",
    );
    expect(resetChatSource).toContain("sendQueue.resetAll();");
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
