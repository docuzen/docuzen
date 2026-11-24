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
//   - pane state: `activeChatId`, the Stop button, the footer pickers, the model cache;
//   - opening threads: activateChatPane / promoteToChat / openThreadById / jumpTo*;
//   - sending: commitSend → driveSend → dispatchQueuedTurn, the queued/held message chips,
//     Panel fan-out, a card's first message (askAgentFromCard), and the exclusive-turn
//     claim every non-queue flow takes (beginExclusiveTurn → ExclusiveTurn.end);
//   - edit-to-fork (beginEditBranch) and its busy locks;
//   - resetChat on document switch.
//
// Two generations keep late results where they belong:
//   - the DOCUMENT generation (`scope`, a DocScope): resetChat — every tab switch, reload
//     and close — starts a new one with its own send queue, Stop bookkeeping and live
//     turns. Thread ids repeat across documents (c0001, directive-1, review) and the
//     sidecar finishes a turn after the user has switched away, so a turn captures the
//     scope and its docPath when it starts (TurnCtx), passes that docPath to every RPC,
//     and after each await touches the queue, a lock, the pane or the card registry only
//     while `isCurrent(turn)`. A stale turn's result is on disk: returning to the
//     document re-reads it (cards from listThreads, the thread from getThread, pending
//     proposals from listProposals). The old scope's queue is emptied, so a stale chain
//     stops after the turn in flight.
//   - the PANE generation (`paneGen`): bumped whenever the pane's subject changes
//     (setPaneSubject). A thread fetch renders only if the pane still shows what it
//     was fetched for.
//
// Rules shared with the other UI modules:
//   - no cross-imports between regions: main.ts composes them and passes `deps`;
//     late-bound deps are closures (shell.ts is wired after this module);
//   - no module-scope `document.querySelector`: elements are looked up inside init;
//   - anything derived from the document's on-disk state is re-fetched, never assumed.
//
// Tests: chat-behaviour.test.ts and chat-async-state.test.ts drive this region through
// the real DOM with a scripted sidecar. Several older tests assert on source text via
// module-source.test-support.ts.

import { excerpt } from "./excerpt.js";
import type { RpcEvent } from "./rpc.js";
import type { DocdApi } from "./session.js";
import type { HtmlSurface } from "./html-surface.js";
import type { HtmlSnippetPreviewContext } from "./html-snippet-preview.js";
import type { ThreadTurn, ThreadNode, ModelConfig, RpcResult } from "@ai-native-doc/docd/protocol";
import { initAgentsPanel } from "./chat-agents-panel.js";
import { initImprove } from "./chat-improve.js";
import { initCommentCards, type CardAsk, type CommentEntry } from "./chat-comment-cards.js";
import { initTranscript, type StreamingTurn } from "./chat-transcript.js";
import { initThreadTree } from "./chat-thread-tree.js";
import { initDocPasses } from "./chat-doc-passes.js";
import { el, reportError, runStreamingTurn, lastAgentReply } from "./ui.js";
import {
  SendQueue,
  driveSend,
  type ExclusiveTurn,
  type QueuedTurn,
  type SendOutcome,
  claimExclusive,
  releaseExclusive,
} from "./send-queue.js";
import { focusRangeBlocks } from "./long-range.js";

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
  /**
   * Claim a thread on the active document for a turn that bypasses the send queue (card
   * "Ask agent", Improve, Brainstorm, Visualize, Panel); null when it already has one. The
   * claim carries the document it started on — see send-queue.ts's ExclusiveTurn.
   */
  beginExclusiveTurn: (threadId: string, label: string) => ExclusiveTurn | null;
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
  setHarnessContext: (id: string | undefined, list: RpcResult<"listHarnesses">) => void;
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

/** One document generation's in-flight bookkeeping — see the file header. */
interface DocScope {
  readonly queue: SendQueue;
  /** threadIds whose in-flight turn was cancelled via Stop (see the Stop handler). */
  readonly stopped: Set<string>;
  /** threadIds with an in-flight turn that Stop can cancel. */
  readonly busy: Set<string>;
  /** The elements of each thread's in-flight turn, put back when the thread is re-opened. */
  readonly live: Map<string, Set<LiveElement>>;
}

interface LiveElement {
  el: HTMLElement;
  attach: () => void;
}

/** What a turn captures when it starts: the document generation, its document, its thread. */
interface TurnCtx {
  readonly scope: DocScope;
  readonly docPath: string;
  readonly threadId: string;
}

/** A thread as getThread returns it. */
type ThreadView = RpcResult<"getThread">;

/** A queued message's pending state, shown as a chip on its own "you" bubble. */
type PendingState = "live" | "queued" | "held";

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
  const chatMoreBtnEl = document.querySelector<HTMLButtonElement>("#chatMoreBtn")!;
  const chatMoreEl = document.querySelector<HTMLDivElement>("#chatMore")!;

  // The routing summary stays visible when the optional stance and model controls are closed.
  const MORE_OPEN_KEY = "docuzen.chatMoreOpen";
  const harnessLabel = document.querySelector<HTMLElement>("#chatHarnessLabel")!;
  const routingDetail = document.querySelector<HTMLElement>("#chatRoutingDetail")!;
  let documentHarness: string | undefined;
  let threadHarness: string | undefined;
  let harnessList: RpcResult<"listHarnesses"> = [];

  function refreshMoreLabel(): void {
    const id = threadHarness ?? documentHarness;
    const harness = harnessList.find(h => h.id === id);
    const managed = !!id && id !== "pi" && id !== "codex";
    const unavailable = !!id && harnessList.length > 0 && !harness?.available;
    harnessLabel.textContent = "Harness: " + (harness?.label ?? id ?? "Unknown") + (unavailable ? " (unavailable)" : "");
    harnessLabel.title = threadHarness ? "This thread uses its saved harness." : "New discussions use the document harness.";
    const model = managed ? "Harness default" :
      (chatModelEl.selectedOptions[0]?.textContent ?? "").replace(/^[^\p{L}\p{N}]+/u, "").trim() || "Default";
    const stance = chatStanceEl.value;
    routingDetail.textContent = "Model: " + model + (stance && stance !== "none" ? " · " + stance : "");
    chatModelEl.hidden = chatModelEl.disabled = managed;
    chatPanelEl.hidden = !!harness && !harness.capabilities.multiModelPanel;
    chatMoreBtnEl.setAttribute("aria-expanded", String(!chatMoreEl.hidden));
  }

  function footerModel(): string {
    return chatModelEl.disabled ? "" : chatModelEl.value;
  }

  function setMoreOpen(open: boolean): void {
    chatMoreEl.hidden = !open;
    refreshMoreLabel();
  }
  chatMoreBtnEl.addEventListener("click", () => {
    setMoreOpen(chatMoreEl.hidden);
    try {
      localStorage.setItem(MORE_OPEN_KEY, chatMoreEl.hidden ? "0" : "1");
    } catch {
      /* a per-viewer convenience only */
    }
  });
  chatStanceEl.addEventListener("change", refreshMoreLabel);
  chatModelEl.addEventListener("change", refreshMoreLabel);
  let moreOpen = false;
  try {
    moreOpen = localStorage.getItem(MORE_OPEN_KEY) === "1";
  } catch {
    /* storage unavailable: start closed */
  }
  setMoreOpen(moreOpen);
  const chatImproveEl = document.querySelector<HTMLButtonElement>("#chatImprove")!;

  let activeChatId: string | null = null;

  // --- the two generations (see the file header) ---
  function newScope(): DocScope {
    return { queue: new SendQueue(), stopped: new Set(), busy: new Set(), live: new Map() };
  }
  let scope = newScope();
  let paneGen = 0;

  /** Capture the active document for a turn on `threadId`; null with no document open. */
  function turnCtx(threadId: string): TurnCtx | null {
    const docPath = deps.getDocPath();
    return docPath ? { scope, docPath, threadId } : null;
  }
  /** The turn's document is still on screen, in the same activation. */
  function isCurrent(t: TurnCtx): boolean {
    return t.scope === scope && deps.getDocPath() === t.docPath;
  }
  /** isCurrent, and the pane shows the turn's thread. */
  function isShown(t: TurnCtx): boolean {
    return isCurrent(t) && activeChatId === t.threadId;
  }

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
    getFooterModelId: footerModel,
  });

  // --- Improve: rewrite a highlighted passage (chat-improve.ts) ---
  const improve = initImprove({
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
    updateChatActions: () => updateChatActions(),
  });
  const { runImprove } = improve;

  // --- thread navigator: select, branch tree, version pager (chat-thread-tree.ts) ---
  const tree = initThreadTree({
    api: deps.api,
    log: deps.log,
    getDocPath: deps.getDocPath,
    truncTitle: deps.truncTitle,
    openVersionPreview: (v) => deps.openVersionPreview(v),
    getActiveChatId: () => activeChatId,
    comments: () => comments.values(),
    openThread: (id) => jumpToAnnotation(id),
    appendToTurns: (el) => void chatTurnsEl.appendChild(el),
    onNodes: (nodes) => {
      cards.applyThreadNodes(nodes);
      const node = nodes.find(n => n.id === activeChatId);
      if (node) {
        threadHarness = node.harness;
        refreshMoreLabel();
      }
    },
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

  // --- Stop control: cancel the in-flight agent turn of the thread in the pane ---
  // Stop is DERIVED: it shows exactly when the pane's thread has a cancellable turn in
  // flight in this document generation (`scope.busy`), so switching threads or documents
  // and coming back can never leave it pointing at the wrong turn, or hidden while the
  // thread is still running. Send stays visible alongside it (Phase 9 T1) so a message
  // typed during a turn queues rather than being blocked.
  // Clicking Stop calls cancelTurn, which aborts that thread's pi session; the
  // in-flight RPC call then resolves with whatever streamed, so the turn's normal
  // done()/cleanup runs.
  // (Branch takes the thread but is not cancellable — see runBranch — because the backend
  // cancelKey is docPath#<branchThreadId>, and the UI doesn't know that id until the call
  // resolves, so a Stop there would be a misleading no-op.)
  let busyThread: string | null = null;
  function refreshBusy(): void {
    busyThread = activeChatId && scope.busy.has(activeChatId) ? activeChatId : null;
    chatStopEl.hidden = !busyThread;
    chatSendEl.textContent = busyThread ? "Queue" : "Send";
    chatSendEl.title = busyThread ? "Send after the current turn" : "Send";
    chatPanelEl.disabled = !!busyThread; // no concurrent panel run while a turn streams
    chatFootEl.classList.toggle("busy", !!busyThread);
    refreshEditLocks(); // Phase 9 T2: busy state is one of forkLocked's two inputs
  }
  // scope.stopped: threadIds whose in-flight turn was cancelled via Stop. cancelTurn
  // makes the underlying RPC RESOLVE normally (see above) — without this set, a stopped
  // turn would read as an ordinary success and auto-drain the next queued message. BIND
  // (task-1-brief.md): Stop also halts draining. Consumed (deleted) by the turn it
  // applies to when it settles, and cleared when a new turn starts on the thread, so it
  // can never leak into a later unrelated send.
  chatStopEl.addEventListener("click", async () => {
    const t = busyThread ? turnCtx(busyThread) : null;
    if (!t) return;
    t.scope.stopped.add(t.threadId);
    chatStopEl.disabled = true;
    try {
      await deps.api.cancelTurn({ docPath: t.docPath, threadId: t.threadId });
      deps.log(`stopped ${t.threadId}`);
    } catch (e) {
      reportError("stop", e, deps.log);
    } finally {
      chatStopEl.disabled = false;
    }
  });

  // --- live turns: what an in-flight turn shows in its thread's pane ---
  /** Keep `item` with the turn's thread until the turn ends, so re-opening the thread puts it back. */
  function trackLive(t: TurnCtx, item: LiveElement): void {
    let set = t.scope.live.get(t.threadId);
    if (!set) t.scope.live.set(t.threadId, (set = new Set()));
    set.add(item);
  }
  /** The live agent bubble for a turn: in the pane when its thread is shown, otherwise kept aside. */
  function turnBubble(t: TurnCtx, meta?: string, modelId?: string): StreamingTurn {
    const bubble = streamingAgentTurn(meta, modelId, { detached: !isShown(t) });
    trackLive(t, { el: bubble.el, attach: bubble.attach });
    return bubble;
  }
  function appendCustomTurn(box: HTMLElement): void {
    chatEmptyEl.hidden = true;
    chatTurnsEl.appendChild(box);
    chatTurnsEl.scrollTop = chatTurnsEl.scrollHeight;
  }

  // --- per-thread send queue ---
  // Messages typed while their thread already has a turn in flight are queued
  // (FIFO, one thread's queue never affects another's) instead of being
  // hard-blocked — see send-queue.ts for the pure enqueue/drain/halt logic this
  // wraps. `turnElByItemId` remembers each committed-but-not-yet-settled
  // message's own "you" bubble so a later chip removal, chip strip (on
  // dispatch), or failure marking can find the right DOM node — entries are
  // deleted once a turn reaches a terminal state (sent, failed, or removed).
  const turnElByItemId = new Map<string, HTMLDivElement>();
  let queueSeq = 0;

  function lastUserTurn(turns: ThreadTurn[]): ThreadTurn | undefined {
    for (let i = turns.length - 1; i >= 0; i--) {
      if (turns[i].role === "you") return turns[i];
    }
    return undefined;
  }

  /** See ui.ts's lastAgentReply — read from the turn's own document, whatever is active now. */
  const fetchLastAgentReply = (docPath: string, threadId: string) =>
    lastAgentReply({ getThread: (p) => deps.api.getThread({ ...p, docPath }) }, () => docPath, threadId);

  /** Drop a not-yet-sent message: out of the queue and off the screen. */
  function removePending(s: DocScope, item: QueuedTurn): boolean {
    if (!s.queue.remove(item.threadId, item.id)) return false;
    turnElByItemId.get(item.id)?.remove();
    turnElByItemId.delete(item.id);
    refreshEditLocks(); // Phase 9 T2: removing the last queued item can unlock fork edits
    return true;
  }

  /**
   * The chip on a not-yet-sent message's bubble: "queued" (waits behind the turn in
   * flight, ✕ removes it) or "not sent" (held after a failed or stopped turn: Send it on
   * its own, or ✕). Both act on the queue of the document generation they were drawn in.
   */
  function pendingChip(item: QueuedTurn, state: "queued" | "held"): HTMLSpanElement {
    const s = scope;
    const chip = document.createElement("span");
    chip.className = `chip ${state}`;
    chip.textContent = state === "queued" ? "queued " : "not sent ";
    if (state === "held") {
      const send = document.createElement("button");
      send.className = "held-send";
      send.title = "Send this message now";
      send.textContent = "Send";
      send.addEventListener("click", (ev) => {
        ev.stopPropagation();
        if (s !== scope || !removePending(s, item)) return;
        commitSend(item.threadId, item.text, { stance: item.stance, modelId: item.modelId });
      });
      chip.appendChild(send);
    }
    const x = document.createElement("button");
    x.className = "queued-remove";
    x.title = state === "queued" ? "Remove from queue" : "Remove";
    x.textContent = "✕";
    x.addEventListener("click", (ev) => {
      ev.stopPropagation();
      removePending(s, item);
    });
    chip.appendChild(x);
    return chip;
  }

  function setPendingChip(turnEl: HTMLDivElement, item: QueuedTurn, state: PendingState): void {
    turnEl.querySelector(".chip.queued, .chip.held")?.remove();
    if (state !== "live") turnEl.querySelector(".trole")?.appendChild(pendingChip(item, state));
  }

  /**
   * Render `item`'s own "you" turn into the transcript — `live` for a message going
   * straight out, `queued` for one waiting behind an in-flight turn, `held` for one left
   * behind by a failed/stopped turn. A no-op when `item.threadId` isn't the displayed
   * thread (promoteToChat/openThreadById replay a thread's pending items when it is
   * opened). An item already on screen just gets its chip updated — never a second bubble.
   */
  function renderYouTurn(item: QueuedTurn, state: PendingState): void {
    if (item.threadId !== activeChatId) return;
    const existing = turnElByItemId.get(item.id);
    if (existing?.isConnected) return setPendingChip(existing, item, state);
    const body = chatTurn("you", item.text);
    const turnEl = body.closest<HTMLDivElement>(".turn");
    if (!turnEl) return;
    turnElByItemId.set(item.id, turnEl);
    setPendingChip(turnEl, item, state);
  }

  /** After a chain halted: show the thread's held messages as held. */
  function refreshPendingChips(t: TurnCtx): void {
    if (!isShown(t)) return;
    for (const item of t.scope.queue.held(t.threadId)) renderYouTurn(item, "held");
    refreshEditLocks();
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
   * behind it. Forking mid-drain would leave the fork target's `atTurnIndex`
   * ambiguous — a queued message could land between the edited turn and "now" while
   * the branch RPC is still resolving the turns array — so edit-to-fork simply refuses
   * for the duration rather than trying to reconcile that race. Held messages don't
   * count: nothing sends them unless the user does.
   */
  function forkLocked(threadId: string): boolean {
    return scope.queue.isInFlight(threadId) || scope.queue.list(threadId).length > 0;
  }

  /**
   * Keep every rendered you-turn's fork affordance (the ✎ button AND the
   * double-click-to-fork bubble itself, both marked `.turn-editable`) visually in
   * sync with `forkLocked(activeChatId)` — disabled + an explanatory tooltip while
   * locked. `runBranch` re-checks `forkLocked` itself at click time as the actual
   * guard; this only keeps the affordance from lying about it beforehand. Called at
   * every point that can flip lock state for the active thread: `refreshBusy`,
   * `commitSend`, the queued-chip ✕ removal, a turn claim, and once after a thread's
   * turns finish rendering (`renderOpenedThread`) so a freshly-reopened busy/queued
   * thread starts locked too.
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
    const setButtons = (disabled: boolean): void => {
      latestBtn.disabled = disabled;
      atTurnBtn.disabled = disabled;
      cancelBtn.disabled = disabled;
    };

    const runBranch = async (doc: "latest" | "at-turn"): Promise<void> => {
      const message = ta.value.trim();
      if (!message) return;
      // The editor may have been open for a while: a turn can have started on the thread since.
      if (forkLocked(parentId)) {
        deps.log("branch: this thread has an agent turn running or messages queued — wait for them, then branch");
        return;
      }
      // Hold the parent thread like any other turn, so a footer Send meanwhile queues
      // instead of racing the fork. Not cancellable: see the Stop section.
      const turn = claimTurn(parentId, "branch", false);
      if (!turn) return;
      setButtons(true);
      const quoted = comments.get(parentId)?.quoted ?? "";
      const modelId = footerModel() || undefined;
      const bubble = turn.bubble(chatStanceEl.value, modelId);
      try {
        const res = await deps.api.branchThread(
          { docPath: turn.docPath, threadId: parentId, atTurnIndex: turnIndex, message, doc, ...(modelId ? { modelId } : {}) },
          (e: RpcEvent) => {
            if (!turn.isCurrent()) return;
            if (deps.routeProposal(e)) return;
            bubble.onEvent(e);
          },
        );
        if (!turn.isCurrent()) return; // the branch is on disk; its document lists it when reopened
        bubble.done();
        cards.registerBranchEntry(res.branchThreadId, quoted, parentId);
        deps.log(`branched ${parentId} → ${res.branchThreadId} (doc=${doc})`);
        // The pager under the forked turn is computed from the thread listing: refresh it
        // before opening the branch, or the new branch isn't in it yet.
        await tree.refreshThreadTree();
        if (!turn.isCurrent()) return;
        turn.end(true); // release the parent before the pane moves to the branch
        await promoteToChat(res.branchThreadId);
      } catch (e) {
        reportError("branch", e, deps.log);
        if (!turn.isCurrent()) return;
        bubble.fail(String(e));
        setButtons(false);
      } finally {
        // A branch adds no turn to the parent: messages queued on it go out either way.
        turn.end(true);
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
      focusRangeBlocks(htmlDoc, id);
      (firstHtml as Element | null)?.scrollIntoView({ block: "center", behavior: "smooth" });
      return;
    }
    let first: Element | null = null;
    document.querySelectorAll(".had-mark").forEach((m) => {
      const on = m.getAttribute("data-anno") === id;
      m.classList.toggle("focus", on);
      if (on && !first) first = m;
    });
    focusRangeBlocks(document, id);
    (first as Element | null)?.scrollIntoView({ block: "center", behavior: "smooth" });
  }

  /** Reflect the active thread's state (resolved, an Improve running) in the footer action buttons. */
  function updateChatActions(): void {
    const e = activeChatId ? comments.get(activeChatId) : null;
    const resolved = e?.resolved ?? false;
    const improving = !!activeChatId && improve.isImproving(activeChatId);
    chatResolveEl.textContent = resolved ? "Reopen thread" : "Resolve thread";
    chatImproveEl.textContent = improving ? "Improving..." : resolved ? "Incorporate into doc" : "Improve passage";
    chatImproveEl.disabled = improving;
    chatImproveEl.classList.toggle("incorporate", resolved);
  }

  chatResolveEl.addEventListener("click", async () => {
    const id = activeChatId;
    const t = id ? turnCtx(id) : null;
    if (!id || !t) return;
    const e = comments.get(id);
    if (!e) return;
    const gen = paneGen;
    const next = !e.resolved;
    try {
      await deps.api.resolveComment({ docPath: t.docPath, id, resolved: next });
    } catch (err) {
      return void reportError("resolve", err, deps.log);
    }
    deps.log(`${next ? "resolved" : "reopened"} ${id}`);
    if (!isCurrent(t)) return; // its document re-reads the resolved state when reopened
    e.resolved = next;
    e.card.classList.toggle("resolved", next);
    if (gen !== paneGen) return; // the pane moved on: the card says it
    if (next) chatTurn("system", "Marked resolved.");
    else chatTurn("system", "Reopened.");
    updateChatActions();
  });

  /**
   * Point the pane at a new subject — a thread, a banner (`id` null or a directive), or
   * nothing — and re-derive everything that depends on which thread is shown: a new
   * pane generation (so an older fetch can't render here), the active card, the branch
   * tree, the footer labels and Stop. A turn still running on the thread puts its live
   * elements back, so its stream and its final reply or error show here again.
   * Callers set the quote/footer/empty-state chrome.
   */
  function setPaneSubject(id: string | null): number {
    activeChatId = id;
    threadHarness = tree.getThreadNodes().find(n => n.id === id)?.harness;
    refreshMoreLabel();
    paneGen++;
    comments.forEach((e) => e.card.classList.toggle("active", e.id === id));
    chatTurnsEl.replaceChildren();
    if (id) for (const l of scope.live.get(id) ?? []) l.attach();
    tree.select(id ?? "");
    tree.renderThreadTree(); // re-scope the tree to the newly-focused thread's family
    updateChatActions();
    refreshBusy();
    return paneGen;
  }

  /** Make `id` the live chat thread and reset the pane chrome (no turns rendered). */
  function activateChatPane(id: string, quoted: string): void {
    deps.uncollapseLeftPane(); // opening a conversation always shows the left pane (Phase 11 T1 exception)
    deps.clearAnnotationUndo(); // engaging a discussion ends the "undo my last highlight" window
    setPaneSubject(id);
    focusAnnotation(id);
    chatQuoteEl.hidden = false;
    chatQuoteEl.textContent = `“${excerpt(quoted)}”`;
    // Populate the footer model picker (default for now; promoteToChat refines it
    // to the thread's persisted model once the thread is fetched).
    modelSelectOptions(chatModelEl, defaultModelKey);
    refreshMoreLabel();
    chatFootEl.hidden = false;
    chatEmptyEl.hidden = true;
  }

  /** A thread's persisted turns, with the ‹ k / n › pager under each forked "you" turn. */
  function renderThreadTurns(id: string, thread: ThreadView, agentMeta: (tn: ThreadTurn) => string | undefined): void {
    threadHarness = thread.frontmatter?.harness;
    refreshMoreLabel();
    thread.turns.forEach((tn, i) => {
      chatTurn(tn.role, tn.body, agentMeta(tn), tn.thinking, i);
      if (tn.role === "you") {
        const sibs = tree.siblingsAt(id, i);
        if (sibs.length >= 2) tree.renderVersionPager(sibs, id);
      }
    });
  }

  /**
   * Render a just-fetched transcript of `id` above what the pane already shows — the live
   * elements of a turn still running on the thread (put back by setPaneSubject) and
   * anything sent while the transcript was loading (Send is live as soon as the pane
   * opens) — then the thread's still-pending messages that aren't on screen yet.
   */
  function renderOpenedThread(id: string, render: () => void): void {
    const notOnDiskYet = [...chatTurnsEl.children];
    chatTurnsEl.replaceChildren();
    render();
    chatTurnsEl.append(...notOnDiskYet);
    // Phase 9 T1: still-pending messages are client-only, so getThread() never includes
    // them. This is what makes switching away from a busy thread and back show them again.
    for (const item of scope.queue.held(id)) renderYouTurn(item, "held");
    for (const item of scope.queue.list(id)) renderYouTurn(item, "queued");
    refreshEditLocks(); // Phase 9 T2: a reopened busy/queued thread starts fork-locked too
    chatTurnsEl.scrollTop = chatTurnsEl.scrollHeight;
  }

  async function promoteToChat(id: string): Promise<void> {
    const entry = comments.get(id);
    const docPath = deps.getDocPath();
    if (!entry || !docPath) return;
    activateChatPane(id, entry.quoted);
    const gen = paneGen;
    let thread: ThreadView | null = null;
    try {
      thread = await deps.api.getThread({ docPath, threadId: id });
    } catch {
      thread = null;
    }
    if (gen !== paneGen) return; // the pane moved on meanwhile — don't render into it
    const placeholder = () => chatTurn("you", entry.commentInput.value || "(write a comment, then Discuss)");
    renderOpenedThread(id, () => {
      if (!thread) return void placeholder();
      if (thread.frontmatter?.stance) chatStanceEl.value = thread.frontmatter.stance;
      // Picker defaults to the thread's persisted model, else the per-doc default.
      const threadModel = thread.frontmatter?.model;
      modelSelectOptions(chatModelEl, threadModel ?? defaultModelKey);
      refreshMoreLabel();
      // Persisted agent turns get a subtle "· {model}" tag when the thread has a model.
      renderThreadTurns(id, thread, (tn) =>
        tn.role === "agent" && threadModel ? `${tn.meta ?? "agent"} · ${modelName(threadModel)}` : tn.meta,
      );
      const lastUser = lastUserTurn(thread.turns);
      if (thread.frontmatter?.status === "error" && lastUser && !chatInputEl.value.trim()) {
        chatInputEl.value = lastUser.body;
      }
      if (!thread.turns.length) placeholder();
    });
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
   * `driveSend` (send-queue.ts) drives sequentially. `t` names the thread (the
   * queue key, NEVER `activeChatId`) and the document generation the chain belongs
   * to. The user may have opened another thread since (the bubble is then kept aside
   * and re-attached when this thread is opened again) or another document (the turn
   * then touches nothing: see the file header).
   *
   * `wasQueued` is false only for a message that went straight to dispatch
   * (the thread was free) — that's the one case task-1-brief.md's "outright
   * delivery failure" input-restore applies to; a queued item that fails
   * already has its own failed "you" bubble as feedback, so its text isn't
   * also stuffed back into the (possibly by-then-different) input.
   */
  async function dispatchQueuedTurn(t: TurnCtx, item: QueuedTurn, wasQueued: boolean): Promise<SendOutcome> {
    if (!isCurrent(t)) return "stopped"; // its document's queue went with it
    const { threadId, docPath } = t;
    const entry = comments.get(threadId);
    t.scope.stopped.delete(threadId); // a turn only now starting cannot be the one Stop cancelled
    const stripChip = turnElByItemId.get(item.id);
    if (stripChip) setPendingChip(stripChip, item, "live");
    const bubble = turnBubble(t, item.stance, item.modelId);
    const onEvent = (e: RpcEvent) => {
      if (!isCurrent(t)) return;
      if (deps.routeProposal(e)) return;
      bubble.onEvent(e);
    };
    setChip(threadId, "running");
    if (entry && !entry.discussed) setCommentActionState(entry, "running");
    t.scope.busy.add(threadId); // Stop; cancelKey for discuss/reply is docPath#<threadId>
    refreshBusy();
    const outcome = await runStreamingTurn({
      run: () => {
        if (entry && !entry.discussed) {
          return deps.api.discuss(
            { docPath, threadId, annotationId: threadId, stance: item.stance, comment: item.text, ...(item.modelId ? { modelId: item.modelId } : {}) },
            onEvent,
          );
        }
        return deps.api.reply(
          { docPath, threadId, message: item.text, stance: item.stance, ...(item.modelId ? { modelId: item.modelId } : {}) },
          onEvent,
        );
      },
      // Runs before driveSend releases the thread, so a message queued behind this one
      // sees the thread discussed and goes out as a reply.
      onSuccess: async () => {
        const finalText = await fetchLastAgentReply(docPath, threadId);
        if (!isCurrent(t)) return; // the reply is on disk; the document re-reads it when reopened
        turnElByItemId.delete(item.id); // reached a terminal (sent) state — no more failure/removal to wire up
        bubble.done(finalText);
        if (entry) {
          entry.discussed = true;
          setCommentActionState(entry, "responded");
        }
      },
      onError: (e) => {
        if (!isCurrent(t)) return;
        const msg = String(e);
        bubble.fail(msg);
        if (entry) setCommentActionState(entry, "error");
        markYouTurnFailed(item, msg);
        // Outright delivery failure (task-1-brief.md): give the typed text back
        // instead of making the user retype it — only if they haven't already
        // started a new draft in the meantime, only for the direct-send case
        // (a queued item's failed text stays visible on its own failed bubble), and
        // only into this thread's own footer.
        if (!wasQueued && isShown(t) && !chatInputEl.value.trim()) chatInputEl.value = item.text;
      },
      onSettled: () => {
        t.scope.busy.delete(threadId);
        t.scope.live.delete(threadId);
        if (isCurrent(t)) refreshBusy();
      },
    });
    // cancelTurn makes the RPC above resolve normally (see the Stop section) —
    // scope.stopped is what turns that resolve into "stopped" so driveSend halts
    // instead of reading a user-cancelled turn as a plain success.
    // Consumed on EVERY settle: a Stop that surfaces as an error must not leave
    // the id poisoned for a later, unrelated send on the same threadId.
    const wasStopped = t.scope.stopped.delete(threadId);
    if (!outcome.ok) return "failed";
    return wasStopped ? "stopped" : "sent";
  }

  /**
   * Claim `threadId` for a turn that is NOT a queued chat message — card "Ask agent",
   * Improve, Brainstorm, Visualize, Panel, Branch. These used to call their RPC directly
   * without touching the send queue, so a footer Send during one of them dispatched a
   * SECOND concurrent turn on the same thread (and, before the first discuss() finished,
   * a second discuss() that re-initialised the thread file under it). Holding the same
   * in-flight bit `driveSend` uses makes `commitSend` queue behind them instead.
   *
   * Returns null — and the caller must not start — when the thread already has a turn in
   * flight or no document is open. Every claim MUST be paired with `end()` in a `finally`.
   */
  function claimTurn(threadId: string, label: string, cancellable: boolean): ExclusiveTurn | null {
    const t = turnCtx(threadId);
    if (!t) return null;
    if (!claimExclusive(t.scope.queue, threadId)) {
      deps.log(`${label}: ${threadId} already has an agent turn running — wait for it or press Stop`);
      return null;
    }
    t.scope.stopped.delete(threadId); // a turn only now starting cannot be the one Stop cancelled
    if (cancellable) t.scope.busy.add(threadId);
    refreshBusy();
    let ended = false;
    return {
      threadId,
      docPath: t.docPath,
      isCurrent: () => isCurrent(t),
      isShown: () => isShown(t),
      bubble: (meta, modelId) => turnBubble(t, meta, modelId),
      track: (box) => trackLive(t, { el: box, attach: () => appendCustomTurn(box) }),
      end: (drain) => {
        if (ended) return;
        ended = true;
        // The same halt-on-failure rule driveSend applies to itself: after a failure or a
        // Stop, the messages queued behind this turn are held for the user.
        const stopped = t.scope.stopped.delete(threadId);
        t.scope.busy.delete(threadId);
        t.scope.live.delete(threadId);
        if (!isCurrent(t)) return; // the queue and the claim went with the document's scope
        void releaseExclusive(t.scope.queue, threadId, drain && !stopped, (i) => dispatchQueuedTurn(t, i, true)).then(() =>
          refreshPendingChips(t),
        );
        refreshBusy();
      },
    };
  }
  function beginExclusiveTurn(threadId: string, label: string): ExclusiveTurn | null {
    return claimTurn(threadId, label, true);
  }

  /**
   * Commit `text` for `threadId`: append its "you" turn to the transcript and
   * either dispatch it immediately (thread free) or queue it behind whatever's
   * already in flight (thread busy) — BIND: the caller clears the input right
   * after this returns, regardless of which branch ran, so the textarea is
   * empty the instant the message is committed rather than on turn success.
   */
  function commitSend(threadId: string, text: string, picked?: { stance: string; modelId?: string }): void {
    const t = turnCtx(threadId);
    if (!t) return;
    const item: QueuedTurn = {
      id: `q${++queueSeq}`,
      threadId,
      text,
      stance: picked?.stance ?? chatStanceEl.value,
      modelId: picked ? picked.modelId : footerModel() || undefined,
    };
    if (t.scope.queue.isInFlight(threadId)) {
      t.scope.queue.enqueue(item);
      renderYouTurn(item, "queued");
      refreshEditLocks(); // Phase 9 T2: a newly-queued item can flip forkLocked(threadId)
      return;
    }
    renderYouTurn(item, "live");
    const firstId = item.id; // only THIS call's own item skips the queued-failure input-restore carve-out
    void driveSend(t.scope.queue, threadId, item, (i) => dispatchQueuedTurn(t, i, i.id !== firstId)).then(() =>
      refreshPendingChips(t),
    );
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
    const typed = chatInputEl.value.trim();
    const msg = typed || entry.commentInput.value.trim() || "Compare your takes on this.";
    const models = threadModels.map((m) => m.key);
    if (!models.length && chatModelEl.value) models.push(chatModelEl.value);
    if (!models.length) {
      deps.log("panel: no models configured — add one in File ▸ Settings");
      return;
    }
    const turn = beginExclusiveTurn(id, "panel"); // also shows Stop: cancelKey docPath#<id>
    if (!turn) return;
    if (typed) chatInputEl.value = ""; // committed — cleared now, like Send, never when the run ends
    let panelOk = false;
    chatTurn("you", msg);
    // Each model gets a streaming bubble, created lazily on its first event so the
    // label is the producing model rather than a generic "agent".
    const bubbles = new Map<string, ReturnType<ExclusiveTurn["bubble"]>>();
    setCommentActionState(entry, "running");
    await runStreamingTurn({
      run: () =>
        deps.api.panel(
          {
            docPath: turn.docPath,
            threadId: id,
            annotationId: id,
            stance: chatStanceEl.value,
            comment: msg,
            models,
          },
          (e) => {
            if (!turn.isCurrent()) return;
            if (deps.routeProposal(e)) return;
            const model = e.model ?? "agent";
            let b = bubbles.get(model);
            if (!b) {
              b = turn.bubble(modelName(model) || model, model);
              bubbles.set(model, b);
            }
            b.onEvent(e);
          },
        ),
      // Everything that depends on the run having succeeded happens HERE, before
      // onSettled releases the thread: a message queued behind the panel must find the
      // thread discussed (a reply), or it would go out as a fresh discuss() that
      // re-initialises the thread file and wipes every model's reply.
      onSuccess: async () => {
        // Each model's persisted turn is `meta === model` on the thread (see
        // Orchestrator.panel's agentMeta) — one getThread covers every bubble instead of
        // one round-trip per model. Best-effort: a fetch failure just leaves every bubble
        // showing its streamed text unchanged (same as calling b.done() with no argument).
        const finalTurns = await deps.api.getThread({ docPath: turn.docPath, threadId: id }).catch(() => null);
        if (!turn.isCurrent()) return; // persisted; the document re-reads it when reopened
        const lastReplyFor = (model: string): string | undefined => {
          if (!finalTurns) return undefined;
          for (let i = finalTurns.turns.length - 1; i >= 0; i--) {
            const tn = finalTurns.turns[i];
            if (tn.role === "agent" && tn.meta === model) return tn.body;
          }
          return undefined;
        };
        bubbles.forEach((b, model) => b.done(lastReplyFor(model)));
        entry.discussed = true;
        setCommentActionState(entry, "responded");
        panelOk = true;
      },
      onError: (e) => {
        reportError("panel", e, deps.log);
        if (!turn.isCurrent()) return;
        if (bubbles.size) bubbles.forEach((b) => b.fail(String(e)));
        else turn.bubble().fail(String(e));
        setCommentActionState(entry, "error");
        // Like a failed direct send: give the typed text back unless a new draft is there.
        if (typed && turn.isShown() && !chatInputEl.value.trim()) chatInputEl.value = typed;
      },
      onSettled: () => turn.end(panelOk),
    });
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
   * "you" turns carry a `turnIndex` too — the ✎ button/double-click fork affordance
   * renders here exactly as it does for `promoteToChat`'s real comment threads, and so
   * does the branch pager.
   */
  async function openThreadById(id: string, title: string): Promise<void> {
    const docPath = deps.getDocPath();
    if (!docPath) return;
    deps.uncollapseLeftPane(); // opening a conversation always shows the left pane (Phase 11 T1 exception)
    const gen = setPaneSubject(id);
    chatQuoteEl.hidden = false;
    chatQuoteEl.textContent = title;
    chatFootEl.hidden = false;
    chatEmptyEl.hidden = true;
    modelSelectOptions(chatModelEl, defaultModelKey);
    refreshMoreLabel();
    let thread: ThreadView | null = null;
    let failure = "";
    try {
      thread = await deps.api.getThread({ docPath, threadId: id });
    } catch (e) {
      failure = String(e);
    }
    if (gen !== paneGen) return; // superseded by a newer subject (see setPaneSubject)
    renderOpenedThread(id, () => {
      if (thread) {
        if (thread.frontmatter?.stance) chatStanceEl.value = thread.frontmatter.stance;
        modelSelectOptions(chatModelEl, thread.frontmatter?.model ?? defaultModelKey);
        refreshMoreLabel();
        if (!thread.turns.length) chatTurn("system", "No transcript for this agent task yet.");
        renderThreadTurns(id, thread, (tn) => tn.meta);
      } else if (/ENOENT|no such file/.test(failure)) {
        chatTurn(
          "system",
          "No saved transcript for this agent task — it predates transcript saving or ended before responding. Re-run it (Resolve [[ ]] / Review) to capture the conversation.",
        );
      } else {
        chatTurn("system", `Could not open this agent: ${failure}`);
      }
    });
  }

  /**
   * meta/ctrl+click jump target for an annotation id (comment, review finding, or a
   * highlight that was never discussed) — Phase-8 T4. Also how the branch tree and the
   * version pager open a thread. Mirrors the Agents panel's own click routing:
   * promoteToChat when a margin CommentEntry exists, else the openThreadById
   * pseudo-thread view — which already degrades gracefully (see its own doc comment)
   * when `id` has no thread at all, so no extra existence check is needed here
   * (contrast jumpToDirective, which does need one).
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
    const docPath = deps.getDocPath();
    if (!docPath) return;
    try {
      await deps.api.getThread({ docPath, threadId: id });
    } catch {
      deps.log(`directive ${n}: run Resolve [[ ]] to start this agent`);
      return;
    }
    if (deps.getDocPath() !== docPath) return;
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
    setPaneSubject(threadId ?? null);
    chatQuoteEl.hidden = true;
    // Footer only when there is a single addressable thread — the N≠1 summary
    // banner has no reply target (each directive is repliable from its own row).
    chatFootEl.hidden = threadId === undefined;
    chatEmptyEl.hidden = true;
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
    const turn = beginExclusiveTurn(id, "ask agent"); // also shows Stop: cancelKey docPath#<id>
    if (!turn) return;
    let askOk = false;
    chatStanceEl.value = ask.stance;
    activateChatPane(id, quoted);
    chatModelEl.value = ask.modelId ?? ""; // keep the footer picker in sync
    refreshMoreLabel();
    setCommentActionState(entry, "running");
    chatTurn("you", ask.comment);
    const bubble = turn.bubble(ask.stance, ask.modelId);
    try {
      await deps.api.discuss(
        {
          docPath: turn.docPath,
          threadId: id,
          annotationId: id,
          stance: ask.stance,
          comment: ask.comment,
          ...(ask.modelId ? { modelId: ask.modelId } : {}),
        },
        (e: RpcEvent) => {
          if (!turn.isCurrent()) return;
          if (deps.routeProposal(e)) return;
          bubble.onEvent(e);
        },
      );
      const finalText = await fetchLastAgentReply(turn.docPath, id);
      if (!turn.isCurrent()) return; // persisted; the document re-reads it when reopened
      bubble.done(finalText);
      entry.discussed = true;
      setCommentActionState(entry, "responded");
      askOk = true;
    } catch (e) {
      reportError("discuss", e, deps.log);
      if (!turn.isCurrent()) return;
      bubble.fail(String(e));
      entry.discussed = false;
      setCommentActionState(entry, "error");
    } finally {
      turn.end(askOk);
    }
  }

  /**
   * A card's "Ask agent"/"Retry" for a thread that already has a conversation: open it
   * and put the last message back in the footer (unless a draft is there) to resend.
   */
  async function resendFromCard(entry: CommentEntry): Promise<void> {
    await promoteToChat(entry.id);
    const docPath = deps.getDocPath();
    const gen = paneGen;
    if (!docPath || activeChatId !== entry.id) return; // the pane moved on while it opened
    if (!chatInputEl.value.trim()) {
      try {
        const thread = await deps.api.getThread({ docPath, threadId: entry.id });
        if (gen !== paneGen) return;
        const last = lastUserTurn(thread.turns);
        if (last && !chatInputEl.value.trim()) chatInputEl.value = last.body;
      } catch {
        /* best effort; the user can still type a resend */
      }
    }
    if (gen === paneGen) chatInputEl.focus();
  }

  /**
   * The chat-pane side of fully removing an annotation: backend delete + in-document
   * decoration removal happen in main.ts's removeAnnotationById, which calls this for
   * the margin-card/branch-descendants/queue/chat-pane cleanup.
   */
  function removeCommentEntry(id: string): void {
    const removed = cards.removeEntry(id);
    if (!removed.length) return;
    for (const rid of removed) {
      // Any still-pending messages for these threads are moot now — drop them and their
      // DOM bookkeeping so they don't dangle forever; nothing of theirs shows Stop.
      for (const item of [...scope.queue.list(rid), ...scope.queue.held(rid)]) turnElByItemId.delete(item.id);
      scope.queue.clearThread(rid);
      scope.busy.delete(rid);
      scope.live.delete(rid);
    }
    // If a deleted thread was open in the chat pane, reset the pane.
    if (activeChatId && removed.includes(activeChatId)) {
      setPaneSubject(null);
      chatQuoteEl.hidden = true;
      chatFootEl.hidden = true;
      chatEmptyEl.hidden = false;
    } else {
      refreshBusy();
    }
  }

  /** Clear the comment registry + chat pane (called on every document switch, reload and close). */
  function resetChat(): void {
    cards.clear();
    deps.resetCommentSeq();
    // A new document generation. Turns still in flight keep running on the sidecar and
    // land on disk; nothing of theirs reaches this document (see the file header).
    // Emptying the old queue stops their chains after the turn in flight — queued ids
    // like "directive-1" aren't unique across documents, so they must not carry over.
    scope.queue.resetAll();
    scope = newScope();
    turnElByItemId.clear();
    // Synchronously clear the thread tree before the async re-fetch so the previous
    // document's threads are never visible in the newly-active tab's left pane. The
    // re-fetch (refreshThreadTree via refreshThreadSelect below) will repopulate it;
    // the treeGen staleness guard ensures only the newest fetch's result lands here.
    tree.clear();
    setPaneSubject(null);
    chatQuoteEl.hidden = true;
    chatFootEl.hidden = true;
    chatEmptyEl.hidden = false;
    // The document-wide passes and the Agents panel re-derive their state for the newly
    // active document (a pass still running elsewhere keeps its own lock).
    passes.reset();
    agents.reset();
    tree.refreshThreadSelect();
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
    streamingAgentTurn: (meta) => streamingAgentTurn(meta),
    setChip,
    beginExclusiveTurn,
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
    setHarnessContext: (id, list) => {
      documentHarness = id;
      harnessList = list;
      refreshMoreLabel();
    },
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
    getModelId: () => footerModel() || undefined,
    appendCustomTurn,
    scrollTurnsToBottom: () => {
      chatTurnsEl.scrollTop = chatTurnsEl.scrollHeight;
    },
  };
}
