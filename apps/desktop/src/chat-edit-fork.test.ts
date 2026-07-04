import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

// Cursor-style edit-to-fork + Enter-to-send. Source-text pins, per this package's
// convention (chat.ts's DOM wiring isn't otherwise unit-testable in this vitest
// setup — no jsdom; see agents-panel.test.ts's header and chat-send-queue.test.ts/
// chat-jump.test.ts for the same convention applied to other chat.ts behavior).
//
// IMPORTANT CONTEXT for anyone reading this file: the inline-editor-with-Fork/
// Cancel-buttons flow ALREADY EXISTED before this work, wired to a per-turn "✎"
// button (see `beginEditBranch`/`runBranch`). The new work added: (1) wiring
// double-click on the turn bubble itself as a second trigger for that same flow,
// (2) disabling both triggers (with a tooltip) while the thread is busy/queued,
// and (3) Enter-to-send + Shift+Enter-newline on #chatInput (no prior Enter
// handler existed at all).
const chatSource = readFileSync(new URL("./chat.ts", import.meta.url), "utf8");

function sourceBetween(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return source.slice(startIndex, endIndex);
}

describe("double-click a YOU turn bubble to edit-and-fork", () => {
  const renderTurnSource = sourceBetween(chatSource, "function renderTurn(", "function chatTurn(");
  const editableBranch = sourceBetween(
    renderTurnSource,
    'if (role === "you" && turnIndex != null) {',
    "// Persisted reasoning: collapsible, collapsed by default.",
  );

  it("only persisted you-turns (a real turnIndex) get the edit-to-fork affordance — live/streaming turns and agent/system turns get none", () => {
    expect(renderTurnSource).toContain('if (role === "you" && turnIndex != null) {');
  });

  it("marks the bubble .turn-editable so refreshEditLocks can find it later", () => {
    expect(editableBranch).toContain('t.classList.add("turn-editable");');
  });

  it("wires a dblclick listener on the turn bubble itself, calling the SAME beginEditBranch as the pre-existing ✎ button (not a forked flow)", () => {
    expect(editableBranch).toContain('t.addEventListener("dblclick"');
    const dblclickHandler = sourceBetween(editableBranch, 't.addEventListener("dblclick"', "});");
    expect(dblclickHandler).toContain("beginEditBranch(t, text, turnIndex);");
  });

  it("the ✎ button's click handler also calls beginEditBranch(t, text, turnIndex) — same entry point, two triggers", () => {
    const editBtnHandler = sourceBetween(
      editableBranch,
      'editBtn.addEventListener("click"',
      "head.appendChild(editBtn);",
    );
    expect(editBtnHandler).toContain("beginEditBranch(t, text, turnIndex);");
  });
});

describe("beginEditBranch: the pre-existing inline editor + Fork flow (now reachable via double-click too)", () => {
  const fnSource = sourceBetween(
    chatSource,
    "function beginEditBranch(turnEl: HTMLDivElement, original: string, turnIndex: number): void {",
    "function refreshThreadSelect(",
  );

  it("resolves the fork's parent thread from activeChatId (the pane currently open when the editor was triggered)", () => {
    expect(fnSource).toContain("const parentId = activeChatId;");
  });

  it("refuses (no editor opens) while the thread is fork-locked — checked before anything else so a locked turn's button/dblclick truly no-ops", () => {
    const guardIdx = fnSource.indexOf("if (forkLocked(parentId)) return;");
    const bodyQueryIdx = fnSource.indexOf('turnEl.querySelector<HTMLDivElement>(".tbody")');
    expect(guardIdx).toBeGreaterThanOrEqual(0);
    expect(bodyQueryIdx).toBeGreaterThan(guardIdx);
  });

  it("is idempotent against a second trigger on an already-open editor (double-click bubbling into the open textarea must not stack a second one)", () => {
    expect(fnSource).toContain('if (turnEl.querySelector(".turnedit-box")) return;');
  });

  it("Fork calls the existing branchThread RPC with the turn's own persisted turns-array index — the pre-existing plumbing this task exposes, unchanged", () => {
    expect(fnSource).toContain(
      "{ threadId: parentId, atTurnIndex: turnIndex, message, doc, ...(modelId ? { modelId } : {}) }",
    );
  });

  it("applies the existing branch-lineage affordance (registerBranchEntry) and opens the new thread in the pane, streaming — pre-existing, unchanged by this task", () => {
    expect(fnSource).toContain("registerBranchEntry(res.branchThreadId, quoted, parentId);");
    expect(fnSource).toContain("await promoteToChat(res.branchThreadId);");
  });

  it('offers "Branch · latest doc" and "Branch · doc at this turn" plus Cancel — the pre-existing UI (task-2-brief.md\'s generic "Fork"/"Cancel" description maps onto these two Fork variants, not a rename)', () => {
    expect(fnSource).toContain('box.querySelector<HTMLButtonElement>(".tb-latest")');
    expect(fnSource).toContain('box.querySelector<HTMLButtonElement>(".tb-atturn")');
    expect(fnSource).toContain('box.querySelector<HTMLButtonElement>(".tb-cancel")');
    expect(fnSource).toContain('cancelBtn.addEventListener("click", () => restore());');
  });
});

describe("fork disabled while the thread is busy or has queued messages (task-2-brief.md)", () => {
  it("forkLocked checks BOTH isInFlight and a non-empty queue for the thread", () => {
    const forkLockedSource = sourceBetween(
      chatSource,
      "function forkLocked(threadId: string): boolean {",
      "function refreshEditLocks(",
    );
    expect(forkLockedSource).toContain(
      "return sendQueue.isInFlight(threadId) || sendQueue.list(threadId).length > 0;",
    );
  });

  it("refreshEditLocks disables the ✎ button and sets an explanatory tooltip on every .turn-editable bubble when locked", () => {
    const refreshSource = sourceBetween(
      chatSource,
      "function refreshEditLocks(): void {",
      "function beginEditBranch(",
    );
    expect(refreshSource).toContain('querySelectorAll<HTMLDivElement>(".turn-editable")');
    expect(refreshSource).toContain('turnEl.classList.toggle("turn-locked", locked);');
    expect(refreshSource).toContain("btn.disabled = locked;");
    expect(refreshSource).toContain("btn.title = title;");
  });

  it("is a no-op with no active thread (nothing to lock/unlock)", () => {
    const refreshSource = sourceBetween(
      chatSource,
      "function refreshEditLocks(): void {",
      "function beginEditBranch(",
    );
    expect(refreshSource).toContain("if (!activeChatId) return;");
  });

  it("is recomputed at every point that can flip busy/queue state for the active thread: setChatBusy, commitSend (both branches), the queued-chip ✕ removal, and after a thread's turns render", () => {
    const setChatBusySource = sourceBetween(
      chatSource,
      "function setChatBusy(threadId: string | null): void {",
      "function clearBusyIfCurrent(",
    );
    expect(setChatBusySource).toContain("refreshEditLocks();");

    const commitSendSource = sourceBetween(
      chatSource,
      "function commitSend(threadId: string, text: string): void {",
      'chatSendEl.addEventListener("click"',
    );
    // both the busy (enqueue) branch and the free (dispatch) branch refresh locks
    expect(commitSendSource.match(/refreshEditLocks\(\);/g)?.length).toBe(2);

    const queuedChipSource = sourceBetween(
      chatSource,
      "function queuedChip(item: QueuedTurn): HTMLSpanElement {",
      "function renderYouTurn(",
    );
    expect(queuedChipSource).toContain("refreshEditLocks();");

    const promoteToChatSource = sourceBetween(
      chatSource,
      "async function promoteToChat(id: string): Promise<void> {",
      "chatThreadSelectEl.addEventListener",
    );
    expect(promoteToChatSource).toContain("refreshEditLocks();");

    const openThreadByIdSource = sourceBetween(
      chatSource,
      "async function openThreadById(id: string, title: string): Promise<void> {",
      "async function jumpToAnnotation(",
    );
    expect(openThreadByIdSource).toContain("refreshEditLocks();");
  });
});

describe("fork affordance reaches directive-N/review pseudo-threads too (Phase 9 T2b)", () => {
  // task-2-report.md (Phase 9 T2) flagged this exact gap: openThreadById rendered
  // its turns with NO turnIndex argument, so renderTurn's `role === "you" &&
  // turnIndex != null` gate never fired for a directive-N/review pseudo-thread's
  // "you" turns — no ✎ button, no dblclick fork, even though branch() itself was
  // the only remaining blocker (fixed server-side in Orchestrator.branch). This
  // pins the one-line fix: openThreadById now passes the loop index through,
  // exactly like promoteToChat already does for real comment threads.
  it("openThreadById renders its turns WITH a turnIndex, unlike its pre-T2b no-op", () => {
    const openThreadByIdSource = sourceBetween(
      chatSource,
      "async function openThreadById(id: string, title: string): Promise<void> {",
      "async function jumpToAnnotation(",
    );
    expect(openThreadByIdSource).toContain(
      "thread.turns.forEach((tn, i) => chatTurn(tn.role, tn.body, tn.meta, tn.thinking, i));",
    );
    // Would break in lockstep if the shared gate ever changed shape.
    const renderTurnSource = sourceBetween(chatSource, "function renderTurn(", "function chatTurn(");
    expect(renderTurnSource).toContain('if (role === "you" && turnIndex != null) {');
  });
});

describe("Enter-to-send / Shift+Enter-newline on #chatInput", () => {
  const keydownSource = sourceBetween(
    chatSource,
    'chatInputEl.addEventListener("keydown"',
    "// --- Panel (Mode B)",
  );

  it("is wired at all — no Enter handler on #chatInput existed before this task", () => {
    expect(chatSource).toContain('chatInputEl.addEventListener("keydown", (e) => {');
  });

  it("ignores the keydown outright while an IME composition is in progress, checked before shiftKey/anything else", () => {
    const guardIdx = keydownSource.indexOf("if (e.isComposing");
    const preventIdx = keydownSource.indexOf("e.preventDefault();");
    expect(guardIdx).toBe(keydownSource.indexOf("if ("));
    expect(guardIdx).toBeGreaterThanOrEqual(0);
    expect(preventIdx).toBeGreaterThan(guardIdx);
    expect(keydownSource).toContain("if (e.isComposing || e.key !== \"Enter\" || e.shiftKey) return;");
  });

  it("Shift+Enter is left completely alone (no preventDefault) so the textarea's own newline insertion still runs", () => {
    // shiftKey is part of the SAME early-return guard as isComposing — a
    // Shift+Enter keydown returns before reaching preventDefault at all.
    const guardLine = "if (e.isComposing || e.key !== \"Enter\" || e.shiftKey) return;";
    const guardIdx = keydownSource.indexOf(guardLine);
    const preventIdx = keydownSource.indexOf("e.preventDefault();");
    expect(guardIdx).toBeGreaterThanOrEqual(0);
    expect(preventIdx).toBeGreaterThan(guardIdx + guardLine.length);
  });

  it("a plain Enter goes through the exact same guard + commitSend + instant-clear as the Send click handler — not a forked send path", () => {
    expect(keydownSource).toContain("const id = activeChatId;");
    expect(keydownSource).toContain("const msg = chatInputEl.value.trim();");
    expect(keydownSource).toContain("if (!id || !msg || !deps.getDocPath()) return;");
    expect(keydownSource).toContain("commitSend(id, msg);");
    expect(keydownSource).toContain('chatInputEl.value = "";');
  });

  it("preventDefault runs before commitSend — the browser's default newline never gets a chance to land for a sent Enter", () => {
    const preventIdx = keydownSource.indexOf("e.preventDefault();");
    const commitIdx = keydownSource.indexOf("commitSend(id, msg);");
    expect(preventIdx).toBeGreaterThanOrEqual(0);
    expect(commitIdx).toBeGreaterThan(preventIdx);
  });

  it("the pre-existing Send click handler is untouched by this addition (still its own listener, not replaced by keydown)", () => {
    expect(chatSource).toContain('chatSendEl.addEventListener("click", () => {');
  });
});
