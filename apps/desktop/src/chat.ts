// The chat pane: the conversation with an agent about one thread. This module owns the
// pane's own state and the flows that send messages; everything else in the "chat
// region" lives in a focused module that reaches the pane only through `deps`:
//
//   chat-transcript.ts      rendering turns + the live streaming bubble (pure DOM)
//   chat-comment-cards.ts   review-rail cards and the comment registry (`comments`)
//   chat-thread-tree.ts     thread <select>, branch tree, version pager, cached listing
//   chat-improve.ts         the Improve flow and its review box
//   chat-doc-passes.ts      document-wide passes: Review, Resolve [[ ]]
//   chat-agents-panel.ts    the Agents button + task dropdown
//   send-queue.ts           per-thread FIFO + the "one turn per thread" bit (pure)
//
// What stays here:
//   - pane state: `activeChatId`, `busyThread` (Stop), the footer pickers, the model cache;
//   - opening threads: activateChatPane / promoteToChat / openThreadById / jumpTo*;
//   - sending: commitSend → driveSend → dispatchQueuedTurn, the queued-message chips,
//     Panel fan-out, a card's first message (askAgentFromCard), and the exclusive-turn
//     claim every non-queue flow takes (beginExclusiveTurn / endExclusiveTurn);
//   - edit-to-fork (beginEditBranch) and its busy locks;
//   - resetChat on document switch.
//
// Rules shared with the other UI modules:
//   - no cross-imports between regions: main.ts composes them and passes `deps`;
//     late-bound deps are closures (shell.ts is wired after this module);
//   - no module-scope `document.querySelector`: elements are looked up inside init;
//   - anything derived from the document's on-disk state is re-fetched, never assumed.
//
// Tests: chat-behaviour.test.ts drives this region through the real DOM with a scripted
// sidecar. Several older tests assert on source text via module-source.test-support.ts.

import { excerpt } from "./excerpt.js";
import type { RpcEvent } from "./rpc.js";
import type { DocdApi } from "./session.js";
import type { HtmlSurface } from "./html-surface.js";
import type { HtmlSnippetPreviewContext } from "./html-snippet-preview.js";
import type { ThreadTurn, ThreadNode, ModelConfig } from "@ai-native-doc/docd/protocol";
import { initAgentsPanel } from "./chat-agents-panel.js";
import { initImprove } from "./chat-improve.js";
import { initCommentCards, type CardAsk, type CommentEntry } from "./chat-comment-cards.js";
import { initTranscript } from "./chat-transcript.js";
import { initThreadTree } from "./chat-thread-tree.js";
import { initDocPasses } from "./chat-doc-passes.js";
import { el, reportError, runStreamingTurn, lastAgentReply } from "./ui.js";
import { SendQueue, driveSend, type QueuedTurn, type SendOutcome, claimExclusive, releaseExclusive } from "./send-queue.js";

export interface ChatDeps {
  api: DocdApi;
  log: (line: string) => void;
  getDocPath: () => string | undefined;
  getFormat: () => "markdown" | "html";
  getHtmlSurface: () => HtmlSurface | null;
  /** Still main.ts-owned — see file header. */
  renderPreviewText: (into: HTMLElement, text: string, context?: HtmlSnippetPreviewContext | null) => void;
  rawPreviewText: (from: HTMLElement) => string;
  routeProposal: (e: RpcEvent) => boolean;
  reloadActiveDoc: () => Promise<void>;
  syncDocToDisk: () => Promise<void>;
  clearAnnotationUndo: () => void;
  /** editor.ts's directive-chip pulse, via main.ts's `let` (reassigned post-`initEditor`) — late-bound. */
  setDirectivesWorking: (on: boolean) => void;
  /** shell.ts's version-preview modal opener, for the thread-tree 📄 chip — late-bound (shell.ts is wired after this module). */
  openVersionPreview: (versionId: string) => Promise<void>;
  truncTitle: (s: string, max?: number) => string;
  /** Zeroes the still-main.ts-owned per-doc comment-number counter. */
  resetCommentSeq: () => void;
  /** Full annotation removal (backend delete + in-document decoration); still main.ts-owned. Called from a comment card's Delete button. */
  removeAnnotationById: (id: string) => Promise<void>;
  /** shell.ts's left-pane un-collapse (Phase 11 T1) — late-bound (shell.ts is wired after this module). Called wherever a conversation is opened (activateChatPane/openThreadById); see shell.ts's sidebar-toggle section for the exception's full rationale. */
  uncollapseLeftPane: () => void;
}

export interface ChatApi {
  activateChatPane: (id: string, quoted: string) => void;
  promoteToChat: (id: string) => Promise<void>;
  /** meta/ctrl+click jump target for an annotation id — editor.ts/surface.ts's onAnnotationJump. Phase-8 T4. */
  jumpToAnnotation: (id: string) => Promise<void>;
  /** meta/ctrl+click jump target for a `[[ … ]]` directive ordinal — editor.ts's onDirectiveJump. Phase-8 T4. */
  jumpToDirective: (n: number) => Promise<void>;
  chatTurn: (
    role: ThreadTurn["role"],
    text: string,
    meta?: string,
    thinking?: string,
    turnIndex?: number,
  ) => HTMLDivElement;
  chatTurnWithAction: (label: string, onClick: () => void) => void;
  streamingAgentTurn: (meta?: string) => {
    onEvent: (e: RpcEvent) => void;
    /**
     * `finalText`, when given and different from the accumulated stream text, re-renders
     * the bubble body from it — the source of truth for what got persisted (e.g. Codex's
     * trailing fenced-json edit block, stripped server-side into turn.proposal; see T1).
     */
    done: (finalText?: string) => void;
    fail: (msg: string) => void;
  };
  setChip: (id: string, status: "idle" | "running" | "responded" | "error") => void;
  setChatBusy: (threadId: string | null) => void;
  /** Claim/release a thread for a turn that bypasses the send queue (see chat.ts's beginExclusiveTurn). */
  beginExclusiveTurn: (threadId: string, label: string) => boolean;
  endExclusiveTurn: (threadId: string, drain: boolean) => void;
  /** Marks a comment thread as discussed without a full runCardAskAgent cycle (used by the Brainstorm quick action). */
  markDiscussed: (id: string) => void;
  focusCommentInput: (id: string) => void;
  hasComment: (id: string) => boolean;
  getCommentQuoted: (id: string) => string | undefined;
  addCommentCard: (
    id: string,
    quoted: string,
    body?: string,
    num?: number,
    author?: string,
    resolved?: boolean,
    reviewMeta?: { origin?: string; severity?: string; kind?: string },
  ) => void;
  registerBranchEntry: (branchId: string, quoted: string, parentId: string) => void;
  /** The comment-registry side of removing an annotation (Map/DOM/chat-pane cleanup); called by main.ts's removeAnnotationById. */
  removeCommentEntry: (id: string) => void;
  /** Clear the comment registry + chat pane (called on document switch). */
  resetChat: () => void;
  getThreadNodes: () => ThreadNode[];
  refreshThreadTree: () => Promise<void>;
  refreshThreadModels: () => Promise<void>;
  setDefaultModelKey: (key: string) => void;
  modelName: (key: string) => string;
  runReview: () => Promise<void>;
  runResolveDirectives: () => Promise<void>;
  runImprove: (id: string) => Promise<void>;
  refreshAgents: () => Promise<void>;
  /** Also wired directly onto the HTML iframe's own document (see onHtmlReady in main.ts) so ⌘⇧D works with focus inside it. */
  handleResolveShortcut: (e: KeyboardEvent) => void;
  /** The footer stance/model pickers' current values — replaces the raw `chatStanceEl`/`chatModelEl` exposure surface.ts's Brainstorm/Visualize quick actions used to read directly (see task-5-report.md). */
  getStance: () => string;
  getModelId: () => string | undefined;
  /** Append an arbitrary turn-like box (Visualize's diagram-preview card) to the turns list, clearing the empty state — replaces the raw `chatTurnsEl`/`chatEmptyEl` exposure. */
  appendCustomTurn: (box: HTMLElement) => void;
  /** Re-scroll the turns list to the bottom (Visualize's mid-stream token updates). */
  scrollTurnsToBottom: () => void;
}

export function initChat(deps: ChatDeps): ChatApi {

  // chat-pane elements (left pane)
  const chatTurnsEl = document.querySelector<HTMLDivElement>("#chatTurns")!;
  const chatQuoteEl = document.querySelector<HTMLDivElement>("#chatQuote")!;
  const chatEmptyEl = document.querySelector<HTMLDivElement>("#chatEmpty")!;
  const chatFootEl = document.querySelector<HTMLDivElement>("#chatFoot")!;
  const chatInputEl = document.querySelector<HTMLTextAreaElement>("#chatInput")!;
  const chatSendEl = document.querySelector<HTMLButtonElement>("#chatSend")!;
  const chatPanelEl = document.querySelector<HTMLButtonElement>("#chatPanel")!;
  const chatStopEl = document.querySelector<HTMLButtonElement>("#chatStop")!;
  const chatStanceEl = document.querySelector<HTMLSelectElement>("#chatStance")!;
  const chatModelEl = document.querySelector<HTMLSelectElement>("#chatModel")!;
  const chatResolveEl = document.querySelector<HTMLButtonElement>("#chatResolve")!;
  const chatImproveEl = document.querySelector<HTMLButtonElement>("#chatImprove")!;

  let activeChatId: string | null = null;

  // The pane's own staleness counter (the thread tree has its own — chat-thread-tree.ts).
  // Same idea for the chat pane's transcript: promoteToChat/openThreadById clear the pane
  // synchronously, then await getThread. Clicking a second thread before the first fetch
  // lands used to render thread A's turns (and stance/model) into thread B's pane.
  let paneGen = 0;

  // --- review-rail comment cards + the comment registry (chat-comment-cards.ts) ---
  const cards = initCommentCards({
    api: deps.api,
    log: deps.log,
    getDocPath: deps.getDocPath,
    removeAnnotationById: (id) => deps.removeAnnotationById(id),
    fillModelPicker: (sel) => modelSelectOptions(sel, defaultModelKey),
    onRegistryChanged: () => tree.refreshThreadSelect(),
    onOpen: (id) => void promoteToChat(id),
    onAskAgent: (entry, ask) => askAgentFromCard(entry, ask),
    onResend: (entry) => resendFromCard(entry),
  });
  const { comments, setChip, setCommentActionState } = cards;

  // --- transcript rendering + the live streaming bubble (chat-transcript.ts) ---
  const { chatTurn, chatTurnWithAction, streamingAgentTurn } = initTranscript({
    renderPreviewText: deps.renderPreviewText,
    onEditTurn: (turnEl, original, turnIndex) => beginEditBranch(turnEl, original, turnIndex),
    modelName: (key) => modelName(key),
    getFooterModelId: () => chatModelEl.value,
  });

  // --- Improve: rewrite a highlighted passage (chat-improve.ts) ---
  const { runImprove } = initImprove({
    api: deps.api,
    log: deps.log,
    getDocPath: deps.getDocPath,
    getFormat: deps.getFormat,
    renderPreviewText: deps.renderPreviewText,
    rawPreviewText: deps.rawPreviewText,
    routeProposal: deps.routeProposal,
    reloadActiveDoc: deps.reloadActiveDoc,
    commentQuoted: (id) => comments.get(id)?.quoted,
    beginExclusiveTurn: (threadId, label) => beginExclusiveTurn(threadId, label),
    endExclusiveTurn: (threadId, drain) => endExclusiveTurn(threadId, drain),
    setChatBusy: (threadId) => setChatBusy(threadId),
    updateChatActions: () => updateChatActions(),
  });

  // --- thread navigator: select, branch tree, version pager (chat-thread-tree.ts) ---
  const tree = initThreadTree({
    api: deps.api,
    log: deps.log,
    getDocPath: deps.getDocPath,
    truncTitle: deps.truncTitle,
    openVersionPreview: (v) => deps.openVersionPreview(v),
    getActiveChatId: () => activeChatId,
    comments: () => comments.values(),
    promoteToChat: (id) => promoteToChat(id),
    appendToTurns: (el) => void chatTurnsEl.appendChild(el),
    onNodes: (nodes) => cards.applyThreadNodes(nodes),
  });

  // --- Agents button + dropdown (chat-agents-panel.ts) ---
  const agents = initAgentsPanel({
    api: deps.api,
    log: deps.log,
    getDocPath: deps.getDocPath,
    commentQuoted: (id) => comments.get(id)?.quoted,
    hasComment: (id) => comments.has(id),
    promoteToChat: (id) => promoteToChat(id),
    openThreadById: (id, title) => openThreadById(id, title),
  });

  // --- document-wide passes: Review + Resolve [[ ]] (chat-doc-passes.ts) ---
  const passes = initDocPasses({
    api: deps.api,
    log: deps.log,
    getDocPath: deps.getDocPath,
    syncDocToDisk: deps.syncDocToDisk,
    reloadActiveDoc: deps.reloadActiveDoc,
    routeProposal: deps.routeProposal,
    setDirectivesWorking: (on) => deps.setDirectivesWorking(on),
    fillModelPicker: (sel) => modelSelectOptions(sel, defaultModelKey),
    agents,
    showDirectiveResult: (headline, reply, threadId) => showDirectiveResult(headline, reply, threadId),
  });

  // --- per-thread model picker (Mode A) ---
  // A separate cache from the Settings modal's model manager (shell.ts) so the
  // comment-card / chat-footer pickers stay populated independently of the Settings
  // modal being open.
  let threadModels: ModelConfig[] = [];
  let defaultModelKey = ""; // per-doc default (getSettings().model); "" = sidecar default

  // --- Stop control: cancel the in-flight agent turn streaming in the chat pane ---
  // While a discuss/reply/improve turn streams, Stop targets the running thread
  // (Send stays visible alongside it — Phase 9 T1 — so a message typed during a
  // turn queues rather than being blocked; see the send-queue section below).
  // Clicking Stop calls cancelTurn, which aborts that thread's pi session; the
  // in-flight RPC call then resolves with whatever streamed, so the existing
  // bubble.done()/finally cleanup runs normally.
  // (Branch is intentionally NOT wired here — see runBranch — because the backend
  // cancelKey is docPath#<branchThreadId>, and the UI doesn't know that id until
  // the call resolves, so a Stop there would be a misleading no-op.)
  let busyThread: string | null = null;
  function setChatBusy(threadId: string | null): void {
    busyThread = threadId;
    // A turn that is only now starting cannot be the one Stop cancelled. Flows that
    // bypass dispatchQueuedTurn (card "Ask agent", Improve, Brainstorm, Panel) never
    // consume stoppedThreads, so without this a Stop on one of them would make the
    // NEXT queued send on the same thread read as "stopped" and halt draining.
    if (threadId) stoppedThreads.delete(threadId);
    chatStopEl.hidden = !threadId;
    chatPanelEl.disabled = !!threadId; // no concurrent panel run while a turn streams
    chatFootEl.classList.toggle("busy", !!threadId);
    refreshEditLocks(); // Phase 9 T2: busy state is one of forkLocked's two inputs
  }
  /** Only clears busy if `threadId` is still the one being shown as busy — a
   * background thread's turn settling must never stomp on whatever thread the
   * user has since switched Send/Stop to look at (see dispatchQueuedTurn). */
  function clearBusyIfCurrent(threadId: string): void {
    if (busyThread === threadId) setChatBusy(null);
  }
  // threadIds whose in-flight turn was cancelled via Stop. cancelTurn makes the
  // underlying discuss/reply RPC RESOLVE normally (see comment above) — without
  // this set, dispatchQueuedTurn would read that resolve as an ordinary success
  // and auto-drain the next queued message. BIND (task-1-brief.md): Stop also
  // halts draining — queued items stay queued. Consumed (deleted) by the one
  // dispatch it applies to, so it can never leak into a later unrelated send.
  const stoppedThreads = new Set<string>();
  chatStopEl.addEventListener("click", async () => {
    if (!busyThread || !deps.getDocPath()) return;
    const threadId = busyThread;
    stoppedThreads.add(threadId);
    chatStopEl.disabled = true;
    try {
      await deps.api.cancelTurn({ threadId });
      deps.log(`stopped ${threadId}`);
    } catch (e) {
      reportError("stop", e, deps.log);
    } finally {
      chatStopEl.disabled = false;
    }
  });

  // --- per-thread send queue ---
  // Messages typed while their thread already has a turn in flight are queued
  // (FIFO, one thread's queue never affects another's) instead of being
  // hard-blocked — see send-queue.ts for the pure enqueue/drain/halt logic this
  // wraps. `turnElByItemId` remembers each committed-but-not-yet-settled
  // message's own "you" bubble so a later queued-chip removal, chip strip (on
  // dispatch), or failure marking can find the right DOM node — entries are
  // deleted once a turn reaches a terminal state (sent, failed, or removed).
  const sendQueue = new SendQueue();
  const turnElByItemId = new Map<string, HTMLDivElement>();
  let queueSeq = 0;

  function lastUserTurn(turns: ThreadTurn[]): ThreadTurn | undefined {
    for (let i = turns.length - 1; i >= 0; i--) {
      if (turns[i].role === "you") return turns[i];
    }
    return undefined;
  }

  /** See ui.ts's lastAgentReply (shared with the other pane module). */
  const fetchLastAgentReply = (threadId: string) => lastAgentReply(deps.api, deps.getDocPath, threadId);

  /** A "queued" chip + ✕ remove button, wired to pull `item` back out of the queue. */
  function queuedChip(item: QueuedTurn): HTMLSpanElement {
    const chip = document.createElement("span");
    chip.className = "chip queued";
    chip.textContent = "queued ";
    const x = document.createElement("button");
    x.className = "queued-remove";
    x.title = "Remove from queue";
    x.textContent = "✕";
    x.addEventListener("click", (ev) => {
      ev.stopPropagation();
      sendQueue.remove(item.threadId, item.id);
      turnElByItemId.get(item.id)?.remove();
      turnElByItemId.delete(item.id);
      refreshEditLocks(); // Phase 9 T2: removing the last queued item can unlock fork edits
    });
    chip.appendChild(x);
    return chip;
  }

  /**
   * Render `item`'s own "you" turn into the transcript — used both for a
   * message committed straight to dispatch (`queued: false`) and one that has
   * to wait behind an in-flight turn (`queued: true`, gets a chip + ✕). A
   * no-op when `item.threadId` isn't the currently-displayed thread: another
   * thread's pane has nothing here to render into (see promoteToChat/
   * openThreadById, which replay any still-queued items for a thread once it
   * becomes active again — this is what makes switching away and back safe).
   */
  function renderYouTurn(item: QueuedTurn, opts: { queued: boolean }): void {
    if (item.threadId !== activeChatId) return;
    const body = chatTurn("you", item.text);
    const turnEl = body.closest<HTMLDivElement>(".turn");
    if (!turnEl) return;
    turnElByItemId.set(item.id, turnEl);
    if (opts.queued) turnEl.querySelector(".trole")?.appendChild(queuedChip(item));
  }

  /** Strip the "queued" chip once `item` actually starts dispatching (no-op if it never had one, or its thread isn't active). */
  function stripQueuedChip(item: QueuedTurn): void {
    turnElByItemId.get(item.id)?.querySelector(".chip.queued")?.remove();
  }

  /**
   * Mark `item`'s own "you" bubble as failed to send, with the error line —
   * the bit that's genuinely new for Phase 9 T1 (the AGENT bubble already
   * showed `bubble.fail()`'s "⚠ {msg}" on any discuss/reply failure; this adds
   * the same treatment to the user's own message so it's clear THAT text is
   * what didn't go through, not just that the agent didn't answer).
   */
  function markYouTurnFailed(item: QueuedTurn, msg: string): void {
    const turnEl = turnElByItemId.get(item.id);
    turnElByItemId.delete(item.id);
    if (!turnEl || item.threadId !== activeChatId) return;
    turnEl.classList.add("turn-failed");
    const errLine = document.createElement("div");
    errLine.className = "tbody-error";
    errLine.textContent = `⚠ ${msg}`;
    turnEl.appendChild(errLine);
  }
  /**
   * True while `threadId` has a turn actually in flight OR still-queued messages
   * behind it (disabled while that thread's turn is in flight or queues have items
   * for it). Forking mid-drain would
   * leave the fork target's `atTurnIndex` ambiguous — a queued message could land
   * between the edited turn and "now" while the branch RPC is still resolving the
   * turns array — so edit-to-fork simply refuses for the duration rather than
   * trying to reconcile that race.
   */
  function forkLocked(threadId: string): boolean {
    return sendQueue.isInFlight(threadId) || sendQueue.list(threadId).length > 0;
  }

  /**
   * Keep every rendered you-turn's fork affordance (the ✎ button AND the
   * double-click-to-fork bubble itself, both marked `.turn-editable`) visually in
   * sync with `forkLocked(activeChatId)` — disabled + an explanatory tooltip while
   * locked, per task-2-brief.md's "simplest: disabled when isInFlight(threadId) or
   * queue non-empty". `beginEditBranch` re-checks `forkLocked` itself at click
   * time as the actual guard; this only keeps the affordance from lying about it
   * beforehand. Called at every point that can flip lock state for the active
   * thread: `setChatBusy`, `commitSend`, the queued-chip ✕ removal, and once after
   * a thread's turns finish rendering (`promoteToChat`/`openThreadById`) so a
   * freshly-reopened busy/queued thread starts locked too.
   */
  function refreshEditLocks(): void {
    if (!activeChatId) return;
    const locked = forkLocked(activeChatId);
    const title = locked ? "Can't edit while this thread is busy" : "Edit & branch from here";
    chatTurnsEl.querySelectorAll<HTMLDivElement>(".turn-editable").forEach((turnEl) => {
      turnEl.classList.toggle("turn-locked", locked);
      const btn = turnEl.querySelector<HTMLButtonElement>(".turnedit");
      if (btn) {
        btn.disabled = locked;
        btn.title = title;
      }
    });
  }

  /**
   * Replace a "you" turn's body with an inline editor that forks a new branch
   * thread from this turn — seeded with the edited message — choosing the doc as
   * it is now ("latest") or as it was at this turn ("at-turn"). Both the ✎ button
   * and the double-click-on-the-bubble trigger (renderTurn) call this same
   * function — it's the single source of truth for edit-to-fork, including the
   * busy-thread refusal below.
   */
  function beginEditBranch(turnEl: HTMLDivElement, original: string, turnIndex: number): void {
    const parentId = activeChatId;
    if (!parentId || !deps.getDocPath()) return;
    // Busy or queued (see forkLocked) — refuse; refreshEditLocks already reflects
    // this on the affordance itself (disabled + tooltip) so this is a defense-in-
    // depth silent no-op, not the user's only signal.
    if (forkLocked(parentId)) return;
    const body = turnEl.querySelector<HTMLDivElement>(".tbody");
    if (!body) return;
    // Already editing this turn? Don't stack a second editor.
    if (turnEl.querySelector(".turnedit-box")) return;
    const prevDisplay = body.style.display;
    body.style.display = "none";

    const box = document.createElement("div");
    box.className = "turnedit-box";
    box.innerHTML = `
      <textarea class="turnedit-ta" rows="3"></textarea>
      <div class="turnedit-acts">
        <button class="tb-latest">⎇ Branch · latest doc</button>
        <button class="tb-atturn">⎇ Branch · doc at this turn</button>
        <button class="tb-cancel">Cancel</button>
      </div>`;
    const ta = box.querySelector<HTMLTextAreaElement>(".turnedit-ta")!;
    ta.value = original;
    const latestBtn = box.querySelector<HTMLButtonElement>(".tb-latest")!;
    const atTurnBtn = box.querySelector<HTMLButtonElement>(".tb-atturn")!;
    const cancelBtn = box.querySelector<HTMLButtonElement>(".tb-cancel")!;

    const restore = (): void => {
      box.remove();
      body.style.display = prevDisplay;
    };
    cancelBtn.addEventListener("click", () => restore());

    const runBranch = async (doc: "latest" | "at-turn"): Promise<void> => {
      const message = ta.value.trim();
      if (!message || !deps.getDocPath()) return;
      latestBtn.disabled = true;
      atTurnBtn.disabled = true;
      cancelBtn.disabled = true;
      const quoted = comments.get(parentId)?.quoted ?? "";
      const modelId = chatModelEl.value || undefined;
      const bubble = streamingAgentTurn(chatStanceEl.value, modelId);
      try {
        const res = await deps.api.branchThread(
          { threadId: parentId, atTurnIndex: turnIndex, message, doc, ...(modelId ? { modelId } : {}) },
          (e: RpcEvent) => {
            if (deps.routeProposal(e)) return;
            bubble.onEvent(e);
          },
        );
        bubble.done();
        cards.registerBranchEntry(res.branchThreadId, quoted, parentId);
        tree.refreshThreadSelect();
        await promoteToChat(res.branchThreadId);
        deps.log(`branched ${parentId} → ${res.branchThreadId} (doc=${doc})`);
      } catch (e) {
        bubble.fail(String(e));
        latestBtn.disabled = false;
        atTurnBtn.disabled = false;
        cancelBtn.disabled = false;
        reportError("branch", e, deps.log);
      }
    };
    latestBtn.addEventListener("click", () => void runBranch("latest"));
    atTurnBtn.addEventListener("click", () => void runBranch("at-turn"));

    turnEl.appendChild(box);
    ta.focus();
  }

  /** Light up the anchored text in the document for the selected comment. */
  function focusAnnotation(id: string): void {
    // HTML surface: marks live inside the iframe document.
    const htmlDoc = deps.getFormat() === "html" ? deps.getHtmlSurface()?.doc : null;
    if (htmlDoc) {
      let firstHtml: Element | null = null;
      htmlDoc.querySelectorAll(".had-mark").forEach((m) => {
        const on = m.getAttribute("data-anno") === id;
        m.classList.toggle("focus", on);
        if (on && !firstHtml) firstHtml = m;
      });
      (firstHtml as Element | null)?.scrollIntoView({ block: "center", behavior: "smooth" });
      return;
    }
    let first: Element | null = null;
    document.querySelectorAll(".had-mark").forEach((m) => {
      const on = m.getAttribute("data-anno") === id;
      m.classList.toggle("focus", on);
      if (on && !first) first = m;
    });
    (first as Element | null)?.scrollIntoView({ block: "center", behavior: "smooth" });
  }

  /** Reflect the active thread's resolved state in the chat action buttons. */
  function updateChatActions(): void {
    const e = activeChatId ? comments.get(activeChatId) : null;
    const resolved = e?.resolved ?? false;
    chatResolveEl.textContent = resolved ? "Reopen thread" : "Resolve thread";
    chatImproveEl.textContent = resolved ? "Incorporate into doc" : "Improve passage";
    chatImproveEl.classList.toggle("incorporate", resolved);
  }

  chatResolveEl.addEventListener("click", async () => {
    const id = activeChatId;
    if (!id || !deps.getDocPath()) return;
    const e = comments.get(id);
    if (!e) return;
    const next = !e.resolved;
    try {
      await deps.api.resolveComment({ id, resolved: next });
    } catch (err) {
      return void reportError("resolve", err, deps.log);
    }
    e.resolved = next;
    e.card.classList.toggle("resolved", next);
    if (next) chatTurn("system", "Marked resolved.");
    else chatTurn("system", "Reopened.");
    updateChatActions();
    deps.log(`${next ? "resolved" : "reopened"} ${id}`);
  });

  /** Make `id` the live chat thread and reset the pane chrome (no turns rendered). */
  function activateChatPane(id: string, quoted: string): void {
    deps.uncollapseLeftPane(); // opening a conversation always shows the left pane (Phase 11 T1 exception)
    deps.clearAnnotationUndo(); // engaging a discussion ends the "undo my last highlight" window
    setChatBusy(null); // switching threads hides any stale Stop from a prior turn
    activeChatId = id;
    comments.forEach((e) => e.card.classList.toggle("active", e.id === id));
    focusAnnotation(id);
    updateChatActions();
    tree.select(id);
    tree.renderThreadTree(); // re-scope the tree to the newly-focused thread's family
    chatQuoteEl.hidden = false;
    chatQuoteEl.textContent = `“${excerpt(quoted)}”`;
    chatTurnsEl.innerHTML = "";
    // Populate the footer model picker (default for now; promoteToChat refines it
    // to the thread's persisted model once the thread is fetched).
    modelSelectOptions(chatModelEl, defaultModelKey);
    chatFootEl.hidden = false;
    chatEmptyEl.hidden = true;
  }

  async function promoteToChat(id: string): Promise<void> {
    const entry = comments.get(id);
    if (!entry || !deps.getDocPath()) return;
    activateChatPane(id, entry.quoted);
    const gen = ++paneGen;
    try {
      const thread = await deps.api.getThread({ threadId: id });
      if (gen !== paneGen) return; // the user opened another thread meanwhile — don't render into its pane
      if (thread.frontmatter?.stance) chatStanceEl.value = thread.frontmatter.stance;
      // Picker defaults to the thread's persisted model, else the per-doc default.
      const threadModel = thread.frontmatter?.model ?? defaultModelKey;
      modelSelectOptions(chatModelEl, threadModel);
      let lastUser: ThreadTurn | undefined;
      thread.turns.forEach((tn, i) => {
        // Persisted agent turns get a subtle "· {model}" tag when the thread has a model.
        const meta =
          tn.role === "agent" && thread.frontmatter?.model
            ? `${tn.meta ?? "agent"} · ${modelName(thread.frontmatter.model)}`
            : tn.meta;
        chatTurn(tn.role, tn.body, meta, tn.thinking, i);
        if (tn.role === "you") {
          lastUser = tn;
          const sibs = tree.siblingsAt(id, i);
          if (sibs.length >= 2) tree.renderVersionPager(sibs, id);
        }
      });
      if (thread.frontmatter?.status === "error" && lastUser && !chatInputEl.value.trim()) {
        chatInputEl.value = lastUser.body;
      }
      if (!thread.turns.length) {
        chatTurn("you", entry.commentInput.value || "(write a comment, then Discuss)");
      }
    } catch {
      if (gen !== paneGen) return;
      chatTurn("you", entry.commentInput.value || "(write a comment, then Discuss)");
    }
    // Phase 9 T1: replay this thread's still-queued (not yet dispatched) messages —
    // they're client-only, so the getThread() above never includes them. This is
    // what makes switching away from a busy thread and back show them again,
    // instead of a queued message silently vanishing until it's actually sent.
    for (const item of sendQueue.list(id)) renderYouTurn(item, { queued: true });
    refreshEditLocks(); // Phase 9 T2: a reopened busy/queued thread starts fork-locked too
  }

  chatImproveEl.addEventListener("click", () => {
    const id = activeChatId;
    if (!id || !deps.getDocPath()) return;
    // Improve rewrites the anchored highlighted passage of a real CommentEntry — a
    // directive-N/review pseudo-thread (opened via openThreadById, no CommentEntry)
    // has no such passage, and the server's improve() still requires the annotation
    // that only reply()/resumeFromTranscript() were made to tolerate missing
    // (Phase-8 T2b), so this would just be a guaranteed RPC error. Only Send is wired
    // for those threads.
    if (!comments.has(id)) return;
    void runImprove(id);
  });

  /**
   * Actually dispatch one queued/committed turn's RPC — the `send` callback
   * `driveSend` (send-queue.ts) drives sequentially. Always resolves threadId
   * from `threadId`/`item.threadId` (the queue key), NEVER from `activeChatId`
   * — this may be running for a thread the user has since switched away from
   * (see renderYouTurn's header comment), so every DOM touch below is gated on
   * `isActive`; the RPC call itself, the margin card's chip
   * (`setChip`/`setCommentActionState` — always visible regardless of which
   * thread's pane is open) is not.
   *
   * `wasQueued` is false only for a message that went straight to dispatch
   * (the thread was free) — that's the one case task-1-brief.md's "outright
   * delivery failure" input-restore applies to; a queued item that fails
   * already has its own failed "you" bubble as feedback, so its text isn't
   * also stuffed back into the (possibly by-then-different) input.
   */
  async function dispatchQueuedTurn(threadId: string, item: QueuedTurn, wasQueued: boolean): Promise<SendOutcome> {
    const entry = comments.get(threadId);
    const isActive = threadId === activeChatId;
    if (isActive) stripQueuedChip(item);
    const bubble = isActive ? streamingAgentTurn(item.stance, item.modelId) : null;
    const onEvent = (e: RpcEvent) => {
      if (deps.routeProposal(e)) return;
      bubble?.onEvent(e);
    };
    setChip(threadId, "running");
    if (isActive) setChatBusy(threadId); // show Stop; cancelKey for discuss/reply is docPath#<threadId>
    // onSuccess runs INSIDE runStreamingTurn's try, before its finally clears busy, so the
    // Stop button stays up until the final reply has been fetched and rendered.
    const outcome = await runStreamingTurn({
      run: async () => {
        if (entry && !entry.discussed) {
          setCommentActionState(entry, "running");
          const r = await deps.api.discuss(
            { threadId, annotationId: threadId, stance: item.stance, comment: item.text, ...(item.modelId ? { modelId: item.modelId } : {}) },
            onEvent,
          );
          entry.discussed = true;
          return r;
        }
        return deps.api.reply(
          { threadId, message: item.text, stance: item.stance, ...(item.modelId ? { modelId: item.modelId } : {}) },
          onEvent,
        );
      },
      onSuccess: async () => {
        turnElByItemId.delete(item.id); // reached a terminal (sent) state — no more failure/removal to wire up
        if (isActive) bubble?.done(await fetchLastAgentReply(threadId));
        if (entry) setCommentActionState(entry, "responded");
      },
      onError: (e) => {
        const msg = String(e);
        if (isActive) bubble?.fail(msg);
        if (entry) setCommentActionState(entry, "error");
        markYouTurnFailed(item, msg);
        // Outright delivery failure (task-1-brief.md): give the typed text back
        // instead of making the user retype it — only if they haven't already
        // started a new draft in the meantime, and only for the direct-send case
        // (a queued item's failed text stays visible on its own failed bubble).
        if (!wasQueued && isActive && !chatInputEl.value.trim()) chatInputEl.value = item.text;
      },
      onSettled: () => clearBusyIfCurrent(threadId),
    });
    // cancelTurn makes the RPC above resolve normally (see the Stop handler's
    // comment) — stoppedThreads is what turns that resolve into "stopped" so
    // driveSend halts instead of reading a user-cancelled turn as a plain success.
    // Consumed on EVERY settle: a Stop that surfaces as an error must not leave
    // the id poisoned for a later, unrelated send on the same threadId.
    const wasStopped = stoppedThreads.delete(threadId);
    if (!outcome.ok) return "failed";
    return wasStopped ? "stopped" : "sent";
  }

  /**
   * Claim `threadId` for a turn that is NOT a queued chat message — card "Ask agent",
   * Improve, Brainstorm, Visualize, Panel. These used to call their RPC directly without
   * touching the send queue, so a footer Send during one of them dispatched a SECOND
   * concurrent turn on the same thread (and, before the first discuss() finished, a second
   * discuss() that re-initialised the thread file under it). Holding the same in-flight
   * bit `driveSend` uses makes `commitSend` queue behind them instead.
   *
   * Returns false — and the caller must not start — when the thread already has a turn in
   * flight. Every successful begin MUST be paired with `endExclusiveTurn` in a `finally`.
   */
  function beginExclusiveTurn(threadId: string, label: string): boolean {
    if (!claimExclusive(sendQueue, threadId)) {
      deps.log(`${label}: ${threadId} already has an agent turn running — wait for it or press Stop`);
      return false;
    }
    refreshEditLocks();
    return true;
  }

  /**
   * Release a thread claimed by `beginExclusiveTurn`. `drain` says whether to deliver the
   * messages that queued up behind it: true after a turn that succeeded, false after a
   * failure or Stop — the same halt-on-failure rule `driveSend` applies to itself, so
   * queued messages stay queued for the user to resend or ✕.
   */
  function endExclusiveTurn(threadId: string, drain: boolean): void {
    const stopped = stoppedThreads.delete(threadId);
    void releaseExclusive(sendQueue, threadId, drain && !stopped, (i) => dispatchQueuedTurn(threadId, i, true));
    refreshEditLocks();
  }

  /**
   * Commit `text` for `threadId`: append its "you" turn to the transcript and
   * either dispatch it immediately (thread free) or queue it behind whatever's
   * already in flight (thread busy) — BIND: the caller clears the input right
   * after this returns, regardless of which branch ran, so the textarea is
   * empty the instant the message is committed rather than on turn success.
   */
  function commitSend(threadId: string, text: string): void {
    const item: QueuedTurn = {
      id: `q${++queueSeq}`,
      threadId,
      text,
      stance: chatStanceEl.value,
      modelId: chatModelEl.value || undefined,
    };
    if (sendQueue.isInFlight(threadId)) {
      sendQueue.enqueue(item);
      renderYouTurn(item, { queued: true });
      refreshEditLocks(); // Phase 9 T2: a newly-queued item can flip forkLocked(threadId)
      return;
    }
    renderYouTurn(item, { queued: false });
    const firstId = item.id; // only THIS call's own item skips the queued-failure input-restore carve-out
    void driveSend(sendQueue, threadId, item, (i) => dispatchQueuedTurn(threadId, i, i.id !== firstId));
    // driveSend's markInFlight(threadId) already ran synchronously above (it's the
    // very first line of driveSend, before its one `await`) — refresh now, not
    // before, so this reflects the just-started in-flight state (Phase 9 T2).
    refreshEditLocks();
  }

  chatSendEl.addEventListener("click", () => {
    const id = activeChatId;
    const msg = chatInputEl.value.trim();
    if (!id || !msg || !deps.getDocPath()) return;
    // A directive-N/review pseudo-thread (opened via openThreadById, never
    // promoteToChat) has no margin CommentEntry — `entry` is undefined for those.
    // They always already exist server-side by the time they're selectable here, so
    // they always reply (never discuss(), which is only for a brand-new comment
    // thread's first message); entry-only bookkeeping (chip/discussBtn state) is
    // skipped when there's no entry to update (Phase-8 T2b) — see dispatchQueuedTurn.
    commitSend(id, msg); // appends the "you" turn (queued or live) synchronously —
    chatInputEl.value = ""; // — THEN clear: instant, not on turn success (Phase 9 T1).
  });

  // Enter-to-send / Shift+Enter-newline (no Enter handler existed on #chatInput
  // before this addition). keydown is the only DOM
  // event that fires BEFORE the textarea's own default newline insertion, so it's
  // the sole point that can preventDefault() a plain Enter while leaving Shift+Enter
  // completely untouched (its default — inserting "\n" — is exactly what we want).
  // e.isComposing is checked FIRST: an IME candidate-confirmation Enter (e.g. typing
  // Japanese/Chinese) must never send, composing or not shifted. Goes through the
  // exact same guard + commitSend + instant-clear as the Send click handler above —
  // not a forked send path (task-2-brief.md: "integrate, don't fork the send logic").
  chatInputEl.addEventListener("keydown", (e) => {
    if (e.isComposing || e.key !== "Enter" || e.shiftKey) return;
    e.preventDefault();
    const id = activeChatId;
    const msg = chatInputEl.value.trim();
    if (!id || !msg || !deps.getDocPath()) return;
    commitSend(id, msg); // same instant-clear commit path as the Send click handler
    chatInputEl.value = "";
  });

  // --- Panel (Mode B): fan one message out to ALL configured models at once ---
  // Each model's tokens stream into its own labeled bubble (keyed by e.model), so
  // you can compare their takes side by side. The backend persists one agent turn
  // per model, so on reload promoteToChat renders them (meta carries the model).
  chatPanelEl.addEventListener("click", async () => {
    const id = activeChatId;
    if (!id || !deps.getDocPath()) return;
    const entry = comments.get(id);
    // Panel fans out through Orchestrator.panel(), which — unlike reply()/
    // resumeFromTranscript() (Phase-8 T2b) — still hard-requires a persisted
    // annotation; a directive-N/review pseudo-thread never has one, so this would be
    // a guaranteed RPC error. Only Send is wired for those threads.
    if (!entry) return;
    const msg =
      chatInputEl.value.trim() ||
      entry?.commentInput.value.trim() ||
      "Compare your takes on this.";
    const models = threadModels.map((m) => m.key);
    if (!models.length && chatModelEl.value) models.push(chatModelEl.value);
    if (!models.length) {
      deps.log("panel: no models configured — add one in File ▸ Settings");
      return;
    }
    if (!beginExclusiveTurn(id, "panel")) return;
    let panelOk = false;
    chatTurn("you", msg);
    // Each model gets a streaming bubble, created lazily on its first event so the
    // label is the producing model rather than a generic "agent".
    const bubbles = new Map<string, ReturnType<typeof streamingAgentTurn>>();
    setChip(id, "running");
    if (entry) setCommentActionState(entry, "running");
    setChatBusy(id); // Stop cancels the panel run (cancelKey docPath#<id>)
    const outcome = await runStreamingTurn({
      run: () =>
        deps.api.panel(
          {
            threadId: id,
            annotationId: id,
            stance: chatStanceEl.value,
            comment: msg,
            models,
          },
          (e) => {
            if (deps.routeProposal(e)) return;
            const model = e.model ?? "agent";
            let b = bubbles.get(model);
            if (!b) {
              b = streamingAgentTurn(modelName(model) || model, model);
              bubbles.set(model, b);
            }
            b.onEvent(e);
          },
        ),
      onError: (e) => {
        if (bubbles.size) bubbles.forEach((b) => b.fail(String(e)));
        else streamingAgentTurn().fail(String(e));
        if (entry) setCommentActionState(entry, "error");
        else setChip(id, "error");
        reportError("panel", e, deps.log);
      },
      onSuccess: () => {
        panelOk = true;
      },
      onSettled: () => {
        setChatBusy(null);
        endExclusiveTurn(id, panelOk);
      },
    });
    if (outcome.ok) {
      // Each model's persisted turn is `meta === model` on the thread (see
      // Orchestrator.panel's agentMeta) — one getThread covers every bubble instead of
      // one round-trip per model. Best-effort: a fetch failure just leaves every bubble
      // showing its streamed text unchanged (same as calling b.done() with no argument).
      const finalTurns = await deps.api.getThread({ threadId: id }).catch(() => null);
      const lastReplyFor = (model: string): string | undefined => {
        if (!finalTurns) return undefined;
        for (let i = finalTurns.turns.length - 1; i >= 0; i--) {
          const tn = finalTurns.turns[i];
          if (tn.role === "agent" && tn.meta === model) return tn.body;
        }
        return undefined;
      };
      bubbles.forEach((b, model) => b.done(lastReplyFor(model)));
      chatInputEl.value = "";
      if (entry) {
        entry.discussed = true;
        setCommentActionState(entry, "responded");
      } else {
        setChip(id, "responded");
      }
    }
  });

  /**
   * Open any thread (incl. the directives/review pseudo-threads) in the chat pane.
   * Phase-8 T2b: the server now tolerates a missing annotation on reply()/
   * resumeFromTranscript() for a thread that already exists (directive-N threads and
   * the "review" umbrella never get a persisted annotation — see
   * `Orchestrator.resolveDirectives`/`review`), so these are genuinely repliable now,
   * not read-only — the footer shows and `activeChatId` tracks this thread like any
   * comment thread opened via `promoteToChat`, just without a margin `CommentEntry`
   * (so `chatSendEl` always replies here — see its own comment — and Improve/Resolve,
   * which need an anchored `CommentEntry`, stay harmless no-ops).
   * Phase 9 T2b: `branch()` got the identical server-side tolerance, so this thread's
   * "you" turns now carry a `turnIndex` too (see the `forEach` below) — the ✎ button/
   * double-click fork affordance (`renderTurn`'s `role === "you" && turnIndex != null`
   * gate) now renders here exactly as it does for `promoteToChat`'s real comment
   * threads. Any turns here that aren't "you" (or a transcript with no "you" turn at
   * all, e.g. an agent/system-only pseudo-thread) simply render no affordance — no
   * special-casing needed, the same gate already handles it.
   */
  async function openThreadById(id: string, title: string): Promise<void> {
    if (!deps.getDocPath()) return;
    deps.uncollapseLeftPane(); // opening a conversation always shows the left pane (Phase 11 T1 exception)
    activeChatId = id;
    comments.forEach((e) => e.card.classList.remove("active"));
    chatQuoteEl.hidden = false;
    chatQuoteEl.textContent = title;
    chatFootEl.hidden = false;
    chatEmptyEl.hidden = true;
    chatTurnsEl.replaceChildren();
    modelSelectOptions(chatModelEl, defaultModelKey);
    const gen = ++paneGen;
    try {
      const thread = await deps.api.getThread({ threadId: id });
      if (gen !== paneGen) return; // superseded by a newer thread open (see paneGen)
      if (thread.frontmatter?.stance) chatStanceEl.value = thread.frontmatter.stance;
      modelSelectOptions(chatModelEl, thread.frontmatter?.model ?? defaultModelKey);
      if (!thread.turns.length) chatTurn("system", "No transcript for this agent task yet.");
      thread.turns.forEach((tn, i) => chatTurn(tn.role, tn.body, tn.meta, tn.thinking, i));
    } catch (e) {
      if (gen !== paneGen) return;
      const msg = String(e);
      if (/ENOENT|no such file/.test(msg)) {
        chatTurn(
          "system",
          "No saved transcript for this agent task — it predates transcript saving or ended before responding. Re-run it (Resolve [[ ]] / Review) to capture the conversation.",
        );
      } else {
        chatTurn("system", `Could not open this agent: ${msg}`);
      }
    }
    // Phase 9 T1: replay this thread's still-queued (not yet dispatched) messages — see promoteToChat's identical comment.
    for (const item of sendQueue.list(id)) renderYouTurn(item, { queued: true });
    // Phase 9 T2 / T2b: keeps the ✎ affordance's busy/queued disabled state in sync —
    // see its own doc comment. Now does real work here (not a no-op) since the turns
    // above render with a turnIndex and can carry `.turn-editable`.
    refreshEditLocks();
  }

  /**
   * meta/ctrl+click jump target for an annotation id (comment, review finding, or a
   * highlight that was never discussed) — Phase-8 T4. Mirrors the Agents panel's own
   * click routing (see refreshAgents' row click handler below): promoteToChat when a
   * margin CommentEntry exists, else the read-only openThreadById pseudo-thread view
   * — which already degrades gracefully (see its own doc comment) when `id` has no
   * thread at all, so no extra existence check is needed here (contrast
   * jumpToDirective, which does need one).
   */
  async function jumpToAnnotation(id: string): Promise<void> {
    if (comments.has(id)) await promoteToChat(id);
    else await openThreadById(id, agents.taskTitle(id));
  }

  /**
   * meta/ctrl+click jump target for a `[[ … ]]` directive decoration — Phase-8 T4.
   * `n` is the click site's 1-based document-order ordinal (editor.ts's job to
   * compute from its own decoration state). Directives never get a margin
   * CommentEntry, so this always goes through openThreadById — but only once a
   * thread actually exists: a directive that was never resolved has no thread at
   * all, and switching the chat pane just to show openThreadById's generic "could
   * not open" message is worse than leaving the pane alone and logging an
   * actionable hint instead.
   */
  async function jumpToDirective(n: number): Promise<void> {
    const id = `directive-${n}`;
    if (!deps.getDocPath()) return;
    try {
      await deps.api.getThread({ threadId: id });
    } catch {
      deps.log(`directive ${n}: run Resolve [[ ]] to start this agent`);
      return;
    }
    await openThreadById(id, agents.taskTitle(id));
  }

  /**
   * Show a directive-pass outcome in the chat pane (used when there's no inline
   * proposal). This is a result BANNER, not a thread view — it can summarize
   * multiple directives' outcomes in one blob (`res.reply` joins every directive's
   * reply), so unlike `openThreadById` there's often no single thread for the
   * footer to target. When the caller knows exactly one directive is being
   * summarized, it passes that thread's id and Send replies into it like any other
   * thread (Phase-8 T2b); otherwise `threadId` is omitted and `activeChatId` stays
   * null, same as before — reply from the Agents panel's per-directive row instead
   * (fully repliable via `openThreadById`).
   */
  function showDirectiveResult(headline: string, reply: string, threadId?: string): void {
    activeChatId = threadId ?? null;
    comments.forEach((e) => e.card.classList.remove("active"));
    chatQuoteEl.hidden = true;
    // Footer only when there is a single addressable thread — the N≠1 summary
    // banner has no reply target (each directive is repliable from its own row).
    chatFootEl.hidden = threadId === undefined;
    chatEmptyEl.hidden = true;
    chatTurnsEl.replaceChildren();
    chatTurn("system", headline);
    if (reply.trim()) chatTurn("agent", reply, "Resolve [[ ]]");
  }
  /**
   * A card's "Ask agent" for a thread's FIRST message: promote the thread into the chat
   * pane and stream the agent's reasoning + reply there live, so you always see the
   * response (not just a chip). Holds the thread's in-flight bit for the duration, so a
   * footer Send typed meanwhile queues behind it (see beginExclusiveTurn).
   */
  async function askAgentFromCard(entry: CommentEntry, ask: CardAsk): Promise<void> {
    const { id, quoted } = entry;
    if (!beginExclusiveTurn(id, "ask agent")) return;
    let askOk = false;
    chatStanceEl.value = ask.stance;
    activateChatPane(id, quoted);
    chatModelEl.value = ask.modelId ?? ""; // keep the footer picker in sync
    setCommentActionState(entry, "running");
    setChatBusy(id); // show Stop; cancelKey for discuss is docPath#<id>
    chatTurn("you", ask.comment);
    const bubble = streamingAgentTurn(ask.stance, ask.modelId);
    try {
      await deps.api.discuss(
        {
          threadId: id,
          annotationId: id,
          stance: ask.stance,
          comment: ask.comment,
          ...(ask.modelId ? { modelId: ask.modelId } : {}),
        },
        (e: RpcEvent) => {
          if (deps.routeProposal(e)) return;
          bubble.onEvent(e);
        },
      );
      bubble.done(await fetchLastAgentReply(id));
      entry.discussed = true;
      setCommentActionState(entry, "responded");
      askOk = true;
    } catch (e) {
      bubble.fail(String(e));
      entry.discussed = false;
      setCommentActionState(entry, "error");
      reportError("discuss", e, deps.log);
    } finally {
      setChatBusy(null);
      endExclusiveTurn(id, askOk);
    }
  }

  /**
   * A card's "Ask agent"/"Retry" for a thread that already has a conversation: open it
   * and put the last message back in the footer (unless a draft is there) to resend.
   */
  async function resendFromCard(entry: CommentEntry): Promise<void> {
    await promoteToChat(entry.id);
    if (deps.getDocPath() && !chatInputEl.value.trim()) {
      try {
        const thread = await deps.api.getThread({ threadId: entry.id });
        const last = lastUserTurn(thread.turns);
        if (last) chatInputEl.value = last.body;
      } catch {
        /* best effort; the user can still type a resend */
      }
    }
    chatInputEl.focus();
  }

  /**
   * The chat-pane side of fully removing an annotation: backend delete + in-document
   * decoration removal happen in main.ts's removeAnnotationById, which calls this for
   * the margin-card/branch-children/queue/chat-pane cleanup.
   */
  function removeCommentEntry(id: string): void {
    if (!cards.removeEntry(id)) return;
    // Any still-queued (not-yet-dispatched) messages for this thread are moot now —
    // drop them and their DOM bookkeeping so they don't dangle forever.
    for (const item of sendQueue.list(id)) turnElByItemId.delete(item.id);
    sendQueue.clearThread(id);
    // If the deleted thread was open in the chat pane, reset the pane.
    if (activeChatId === id) {
      activeChatId = null;
      chatTurnsEl.innerHTML = "";
      chatQuoteEl.hidden = true;
      chatFootEl.hidden = true;
      chatEmptyEl.hidden = false;
    }
  }

  /** Clear the comment registry + chat pane (called on document switch). */
  function resetChat(): void {
    cards.clear();
    activeChatId = null;
    deps.resetCommentSeq();
    chatTurnsEl.innerHTML = "";
    chatQuoteEl.hidden = true;
    chatFootEl.hidden = true;
    chatEmptyEl.hidden = false;
    // Synchronously clear the thread tree before the async re-fetch so the previous
    // document's threads are never visible in the newly-active tab's left pane. The
    // re-fetch (refreshThreadTree via refreshThreadSelect below) will repopulate it;
    // the treeGen staleness guard ensures only the newest fetch's result lands here.
    tree.clear();
    // Reset the review form: dismiss the form and its status line so the previous
    // document's review result ("N findings added to the rail") does not persist in
    // the right pane after switching to a different document.
    passes.reset();
    tree.refreshThreadSelect();
    // Queued (not-yet-dispatched) turns are scoped to THIS document's threads —
    // thread ids like "directive-1" aren't globally unique across documents, so
    // carrying a queue entry over to the next-opened doc could misfire a send at
    // an unrelated same-named thread there. In-flight turns started before the
    // switch keep running server-side; there's just no pane left to report into.
    turnElByItemId.clear();
    sendQueue.resetAll();
    stoppedThreads.clear(); // same cross-document id-reuse hazard as the queue
  }

  async function refreshThreadModels(): Promise<void> {
    try {
      threadModels = await deps.api.listModels({});
    } catch {
      threadModels = [];
    }
  }

  /** Resolve a model key to its display name (falls back to the raw key). */
  function modelName(key: string): string {
    return threadModels.find((m) => m.key === key)?.name ?? key;
  }

  /**
   * Fill a <select> with a "default" option plus one option per configured model
   * (value = key, text = name), then select `selected` (or "" for default).
   * Built with createElement + textContent so model names can't inject markup.
   * Empty model list → only the "default" option, so behavior is unchanged.
   */
  function modelSelectOptions(sel: HTMLSelectElement, selected?: string): void {
    sel.innerHTML = "";
    sel.appendChild(el("option", { value: "", textContent: "🧠 default" }));
    for (const m of threadModels) {
      sel.appendChild(el("option", { value: m.key, textContent: m.name }));
    }
    sel.value = selected ?? "";
  }

  return {
    activateChatPane,
    promoteToChat,
    jumpToAnnotation,
    jumpToDirective,
    chatTurn,
    chatTurnWithAction,
    streamingAgentTurn,
    setChip,
    setChatBusy,
    beginExclusiveTurn,
    endExclusiveTurn,
    markDiscussed: (id) => {
      const e = comments.get(id);
      if (e) e.discussed = true;
    },
    focusCommentInput: (id) => comments.get(id)?.commentInput.focus(),
    hasComment: (id) => comments.has(id),
    getCommentQuoted: (id) => comments.get(id)?.quoted,
    addCommentCard: cards.addCommentCard,
    registerBranchEntry: cards.registerBranchEntry,
    removeCommentEntry,
    resetChat,
    getThreadNodes: tree.getThreadNodes,
    refreshThreadTree: tree.refreshThreadTree,
    refreshThreadModels,
    setDefaultModelKey: (key) => {
      defaultModelKey = key;
    },
    modelName,
    runReview: passes.runReview,
    runResolveDirectives: passes.runResolveDirectives,
    runImprove,
    refreshAgents: agents.refreshAgents,
    handleResolveShortcut: passes.handleResolveShortcut,
    getStance: () => chatStanceEl.value,
    getModelId: () => chatModelEl.value || undefined,
    appendCustomTurn: (box) => {
      chatEmptyEl.hidden = true;
      chatTurnsEl.appendChild(box);
      chatTurnsEl.scrollTop = chatTurnsEl.scrollHeight;
    },
    scrollTurnsToBottom: () => {
      chatTurnsEl.scrollTop = chatTurnsEl.scrollHeight;
    },
  };
}
