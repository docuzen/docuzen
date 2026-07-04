// The agent-conversation region: the chat pane (streaming turns, branch/thread
// tree, stance/model pickers, Stop control), the document-wide Review pass and
// inline-directives actions, the Agents panel, and margin comment cards.
// Frontend split from main.ts.
//
// Region-local state: the `comments` registry, `activeChatId`, `threadNodes`,
// `busyThread`, `optimisticTasks`, and the per-thread model cache
// (`threadModels`/`defaultModelKey`) all move in here — verified via grep to have
// no remaining main.ts readers outside this module's returned `ChatApi`.
//
// Judgment calls (grep-derived rationale):
// - `renderPreviewText`/`rawPreviewText`/`activeHtmlPreviewContext` STAY in
//   main.ts (not moved here) even though they're textually part of the old
//   chat-pane span: they're called MORE by the proposal-widget builders that
//   stay in main.ts until Task 5's proposals.ts than by this module — moving
//   them here now would just mean proposals.ts reaching back into chat.ts for
//   them later, the same "shared state stays with its heavier owner" call this
//   plan's Task 2 made for `threadModels` (before the audit reassigned
//   `threadModels` to this module for Task 4). Reached via `deps.renderPreviewText`/
//   `deps.rawPreviewText`.
// - `truncTitle`/`stripFrontmatter` also stay in main.ts: both are pure string
//   helpers with zero closures over chat state; `stripFrontmatter` has no
//   caller in this module at all (only shell.ts uses it), and `truncTitle` is
//   used by both this module (via `deps.truncTitle`) and shell.ts, so leaving
//   it in main.ts avoids inventing an export path back out of this module for
//   shell's sole benefit.
// - `reloadActiveDoc`/`syncDocToDisk`/`clearAnnotationUndo`/`removeAnnotationById`
//   are textually inside the old chat-pane line span but are tabs/surface-domain
//   (they close over `activeIdx`/`tabs`/`editorRef`/`htmlSurface`/`currentFormat`,
//   none of which are chat state) — they stay in main.ts, reached via deps.
//   `removeAnnotationById` in particular is still CALLED from this module's
//   `addCommentCard` (its Delete button) even though it's defined in main.ts —
//   the two modules call back into each other by design (main.ts's
//   `removeAnnotationById` calls this module's `removeCommentEntry` to do the
//   comment-registry side of the cleanup).
// - `commentSeq` (the per-doc comment numbering counter) is NOT region-local
//   per the brief's own state list — it's shared with `annotate`/`annotateHtml`/
//   `renderLoadedHtml`, which stay in main.ts through Task 5. `resetChat()`
//   still needs to zero it, so it's reached via `deps.resetCommentSeq()`.
// - `#comments` (the margin comment-card list) is queried inside this module
//   (its cards are built and appended here) — the two adjacent
//   `commentsEl.innerHTML = ""` call sites in main.ts's `activateTab`/
//   `showEmptyState` folded into `resetChat()` (which already runs right after
//   them) rather than staying as a separate main.ts-owned element passed
//   through deps; order between the two clears never mattered (nothing reads
//   one in between), so this is a no-op behaviorally.
// - A handful of ChatApi members (`activateChatPane`, `chatTurn`,
//   `chatTurnWithAction`, `setChip`, `setChatBusy`, `streamingAgentTurn`,
//   `markDiscussed`, `focusCommentInput`) aren't in the brief's candidate list but
//   are required by grep: main.ts's selection-popover quick actions (Brainstorm,
//   Visualize — still main.ts until Task 5 wave-2) reach directly into the
//   chat pane's DOM/state today, so they need the same access through this
//   module's returned API.
// - Task 4 originally exposed 4 raw DOM elements (`chatTurnsEl`/`chatEmptyEl`/
//   `chatStanceEl`/`chatModelEl`) for those same quick actions, mirroring the
//   `shell.versionModal` precedent. Task 5 (moving Brainstorm/Visualize into
//   surface.ts) retired all four in favor of proper methods instead:
//   `getStance`/`getModelId` (read the footer pickers' values) and
//   `appendCustomTurn`/`scrollTurnsToBottom` (Visualize's custom diagram-preview
//   box no longer needs direct access to the turns list or empty-state element).
//
// Wiring: `shell.openVersionPreview` (thread-tree 📄 chip) and the still-in-
// main.ts `setDirectivesWorking` (a `let` reassigned inside `init()`) are only
// resolved by main.ts AFTER this module is constructed, so both deps are
// late-bound closures (`(v) => shell.openVersionPreview(v)`) — same
// forward-reference-safe-until-called pattern as `sessionStore`'s
// `currentFormat` closures from Task 2.
//
// DOM-query timing: like editor.ts/shell.ts/surface.ts, this module does no
// module-scope `document.querySelector` — everything is queried once inside
// `initChat()`'s body.

import type { RpcEvent } from "./rpc.js";
import type { DocdApi } from "./session.js";
import type { HtmlSurface } from "./html-surface.js";
import type { HtmlSnippetPreviewContext } from "./html-snippet-preview.js";
import type { ThreadTurn, ThreadNode, ModelConfig, TaskRow } from "@ai-native-doc/docd/protocol";
import { el, reportError, runStreamingTurn, escapeHtml, alreadyResolvedStatus } from "./ui.js";
import { SendQueue, driveSend, type QueuedTurn, type SendOutcome } from "./send-queue.js";

// --- comment registry: each margin comment can be promoted into the chat pane ---
interface CommentEntry {
  id: string;
  quoted: string;
  card: HTMLDivElement;
  chip: HTMLSpanElement;
  discussBtn: HTMLButtonElement;
  stanceSel: HTMLSelectElement;
  commentInput: HTMLTextAreaElement;
  discussed: boolean;
  resolved: boolean;
  parent?: string; // set for branch threads forked from another thread
}

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
  const commentsEl = document.querySelector<HTMLDivElement>("#comments")!;

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
  const chatThreadSelectEl = document.querySelector<HTMLSelectElement>("#chatThreadSelect")!;
  const threadTreeEl = document.querySelector<HTMLDivElement>("#threadTree")!;
  const chatResolveEl = document.querySelector<HTMLButtonElement>("#chatResolve")!;
  const chatImproveEl = document.querySelector<HTMLButtonElement>("#chatImprove")!;

  // review pass elements
  const reviewDocBtn = document.querySelector<HTMLButtonElement>("#reviewDocBtn")!;
  const reviewForm = document.querySelector<HTMLDivElement>("#reviewForm")!;
  const reviewStanceEl = document.querySelector<HTMLSelectElement>("#reviewStance")!;
  const reviewModelEl = document.querySelector<HTMLSelectElement>("#reviewModel")!;
  const reviewRubricEl = document.querySelector<HTMLTextAreaElement>("#reviewRubric")!;
  const reviewRunEl = document.querySelector<HTMLButtonElement>("#reviewRun")!;
  const reviewCancelEl = document.querySelector<HTMLButtonElement>("#reviewCancel")!;
  const reviewStatusEl = document.querySelector<HTMLDivElement>("#reviewStatus")!;

  // inline-directives element
  const resolveDirectivesBtn = document.querySelector<HTMLButtonElement>("#resolveDirectivesBtn")!;

  // agents panel elements
  const agentsBtn = document.querySelector<HTMLButtonElement>("#agentsBtn")!;
  const agentsPanel = document.querySelector<HTMLDivElement>("#agentsPanel")!;
  let agentsPoll: number | null = null;

  const comments = new Map<string, CommentEntry>();
  let activeChatId: string | null = null;

  // --- branch-tree navigator (chat pane) ---
  // One discussion thread's lineage + display metadata, flat (no nesting). Mirrors
  // the docd `listThreads` RPC shape; the UI joins id/parent to build the tree.
  // Cached server tree; also consumed by the version pager.
  let threadNodes: ThreadNode[] = [];
  // Monotonically-increasing generation counter for refreshThreadTree(): every call
  // captures the current value and checks it after the async listThreads RPC; if a
  // newer call has since started (treeGen > gen), the stale result is discarded. This
  // prevents a prior tab's in-flight listThreads from overwriting the newly-active
  // tab's thread tree (the root cause of the left-pane stale-content bug on tab switch).
  let treeGen = 0;

  // Tasks started from the UI before the backend's TaskDB poll catches up. This keeps the
  // dropdown honest during autosave/model-start latency instead of showing only old rows.
  const optimisticTasks = new Map<string, TaskRow>();

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

  function chipText(s: string): string {
    return s === "running" ? "running" : s === "responded" ? "responded" : s === "error" ? "error" : "";
  }
  function setChip(id: string, status: "idle" | "running" | "responded" | "error"): void {
    const e = comments.get(id);
    if (!e) return;
    e.chip.className = `chip ${status}`;
    e.chip.textContent = chipText(status);
  }
  function setCommentActionState(
    e: CommentEntry,
    status: "idle" | "running" | "responded" | "error",
  ): void {
    setChip(e.id, status);
    const discussBtn = e.discussBtn;
    if (status === "running") {
      discussBtn.textContent = "Asking...";
      discussBtn.disabled = true;
    } else if (status === "error") {
      discussBtn.textContent = "Retry";
      discussBtn.disabled = false;
    } else {
      discussBtn.textContent = "Ask agent";
      discussBtn.disabled = status === "responded";
    }
  }
  function lastUserTurn(turns: ThreadTurn[]): ThreadTurn | undefined {
    for (let i = turns.length - 1; i >= 0; i--) {
      if (turns[i].role === "you") return turns[i];
    }
    return undefined;
  }

  /**
   * The persisted body of the most recently appended agent turn in `threadId` — used to
   * re-render a just-completed streaming bubble from the source of truth. discuss/reply/
   * panel's RPCs resolve with only `{ ok: boolean }` (no reply text — see protocol/rpc.ts),
   * so this is the one round-trip that gets it; called only after the RPC that appended the
   * turn has already resolved, so the transcript is guaranteed to hold it. Best-effort:
   * returns undefined (not throw) on any failure, so a caller wiring it into
   * `bubble.done(finalText)` degrades to the pre-existing behavior (keep the streamed text).
   */
  async function fetchLastAgentReply(threadId: string): Promise<string | undefined> {
    if (!deps.getDocPath()) return undefined;
    try {
      const thread = await deps.api.getThread({ threadId });
      const last = thread.turns[thread.turns.length - 1];
      return last?.role === "agent" ? last.body : undefined;
    } catch {
      return undefined;
    }
  }

  function renderTurnText(into: HTMLElement, role: ThreadTurn["role"], text: string): void {
    if (role === "agent") deps.renderPreviewText(into, text);
    else {
      delete into.dataset.rawText;
      into.classList.remove("html-snippet-host");
      into.textContent = text;
    }
  }

  function renderTurn(
    into: HTMLElement,
    role: ThreadTurn["role"],
    text: string,
    meta?: string,
    thinking?: string,
    turnIndex?: number,
  ): HTMLDivElement {
    const t = document.createElement("div");
    t.className = `turn turn-${role}`;
    const head = document.createElement("div");
    head.className = "trole";
    head.textContent =
      role === "agent" ? `Agent · ${meta ?? "default"}` : role === "you" ? `You${meta ? ` · ${meta}` : ""}` : "System";
    t.appendChild(head);
    // Persisted "you" turns can be edited to fork a new branch from that point.
    // Live/streaming turns (no index) and agent/system turns get no ✎.
    if (role === "you" && turnIndex != null) {
      // Marks this bubble as the double-click-to-fork
      // target (Cursor-style) — refreshEditLocks() below queries this exact class to
      // keep the ✎ button + bubble's disabled/tooltip state in sync with busy state.
      t.classList.add("turn-editable");
      const editBtn = document.createElement("button");
      editBtn.className = "turnedit";
      editBtn.title = "Edit & branch from here";
      editBtn.textContent = "✎";
      editBtn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        beginEditBranch(t, text, turnIndex);
      });
      head.appendChild(editBtn);
      // Double-click anywhere on the bubble opens the same inline editor as ✎ —
      // beginEditBranch is the single source of truth for both triggers (including
      // its own busy-thread refusal), so this is a thin alias, not a forked flow.
      // Bubbling into an already-open .turnedit-box (e.g. double-clicking to select
      // a word while editing) re-enters beginEditBranch, which no-ops harmlessly
      // (see its own "already editing this turn?" guard) without touching the
      // browser's native double-click-to-select-word behavior in the textarea.
      t.addEventListener("dblclick", (ev) => {
        ev.stopPropagation();
        beginEditBranch(t, text, turnIndex);
      });
    }
    // Persisted reasoning: collapsible, collapsed by default.
    if (thinking) {
      const d = document.createElement("details");
      d.className = "think saved";
      const sm = document.createElement("summary");
      sm.textContent = "💭 reasoning";
      d.appendChild(sm);
      const tb = document.createElement("div");
      tb.className = "thinkbody";
      tb.textContent = thinking;
      d.appendChild(tb);
      t.appendChild(d);
    }
    const b = document.createElement("div");
    b.className = "tbody";
    renderTurnText(b, role, text);
    t.appendChild(b);
    into.appendChild(t);
    into.scrollTop = into.scrollHeight;
    return b;
  }
  function chatTurn(
    role: ThreadTurn["role"],
    text: string,
    meta?: string,
    thinking?: string,
    turnIndex?: number,
  ): HTMLDivElement {
    chatEmptyEl.hidden = true;
    return renderTurn(chatTurnsEl, role, text, meta, thinking, turnIndex);
  }
  /**
   * A system chat line with a trailing clickable "[review]" affordance. Used when a
   * reopened doc has a pending full rewrite: we don't slam the modal in the user's
   * face on load — they click to open it. Label text goes via textContent (XSS-safe).
   */
  function chatTurnWithAction(label: string, onClick: () => void): void {
    const body = chatTurn("system", label); // chatTurn returns the .tbody element
    body.appendChild(document.createTextNode(" "));
    const btn = document.createElement("button");
    btn.className = "reviewlink";
    btn.textContent = "[review]";
    btn.addEventListener("click", onClick);
    body.appendChild(btn);
  }

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
  // Demoted secondary line shown under BOTH a genuine thrown error and the rare honest
  // "no response" fallback below — generic troubleshooting context, not the headline (see
  // renderFailBody's doc comment).
  const AGENT_FAIL_HINT =
    "Check the model in File ▸ Settings: a wrong/forbidden model id, an unreachable" +
    " gateway, or rate-limiting all look like this.";

  /**
   * A live agent turn that shows a working spinner, streamed 💭 reasoning, 🔧 tool
   * activity, and the reply — until done() clears the working state.
   *
   * `modelId` names the model actually driving THIS bubble, used only to compute the
   * "who" in the empty-reply/fail text below — deliberately never `meta`: for discuss/
   * reply/branch, `meta` carries the STANCE (e.g. "none"), not a model id, so reusing it
   * there produced bubbles reading "No response from none". `meta` still drives the
   * visible `Agent · <meta>` header unchanged (stance IS the right label there; for a
   * panel run, `meta` is already the model name, which is also a fine "who" — see the
   * panel call site, which passes the same value for both).
   */
  function streamingAgentTurn(meta?: string, modelId?: string): {
    onEvent: (e: RpcEvent) => void;
    done: (finalText?: string) => void;
    fail: (msg: string) => void;
  } {
    chatEmptyEl.hidden = true;
    const t = document.createElement("div");
    t.className = "turn turn-agent working";
    // Structure via innerHTML, but the role label (meta) is user-derived (model
    // display names) — set it via textContent to avoid HTML injection.
    t.innerHTML = `
      <div class="trole"><span class="rolename"></span> <span class="spin">working…</span></div>
      <div class="think" hidden><div class="thinkhdr">💭 reasoning</div><div class="thinkbody"></div></div>
      <div class="tools" hidden></div>
      <div class="tbody"></div>`;
    t.querySelector<HTMLSpanElement>(".rolename")!.textContent = `Agent · ${meta ?? "default"}`;
    const thinkWrap = t.querySelector<HTMLDivElement>(".think")!;
    const thinkBody = t.querySelector<HTMLDivElement>(".thinkbody")!;
    const toolsEl = t.querySelector<HTMLDivElement>(".tools")!;
    const body = t.querySelector<HTMLDivElement>(".tbody")!;
    chatTurnsEl.appendChild(t);
    chatTurnsEl.scrollTop = chatTurnsEl.scrollHeight;
    const scroll = () => (chatTurnsEl.scrollTop = chatTurnsEl.scrollHeight);
    let replyText = "";
    /**
     * Render an error bubble body as a prominent headline (the actual detail) plus a
     * smaller, demoted secondary line of generic troubleshooting hints — useful context,
     * but not the first thing a reviewer's eye should land on. Shared by fail() (a real
     * thrown error) and done()'s empty-reply fallback (no error was ever reported).
     */
    const renderFailBody = (headline: string): void => {
      body.textContent = "";
      const head = document.createElement("div");
      head.className = "tbody-fail-headline";
      head.textContent = `⚠ ${headline}`;
      const hint = document.createElement("div");
      hint.className = "tbody-fail-hint";
      hint.textContent = AGENT_FAIL_HINT;
      body.append(head, hint);
    };
    return {
      onEvent: (e) => {
        const d = String(e.data);
        if (e.event === "token") {
          replyText += d;
          renderTurnText(body, "agent", replyText);
        }
        else if (e.event === "thinking") {
          thinkWrap.hidden = false;
          thinkBody.textContent += d;
        } else if (e.event === "tool") {
          toolsEl.hidden = false;
          const l = document.createElement("div");
          l.className = "toolline";
          l.textContent = `Tool · ${d}`;
          toolsEl.appendChild(l);
        }
        scroll();
      },
      done: (finalText) => {
        t.classList.remove("working");
        t.querySelector(".spin")?.remove();
        // A resolved-but-empty reply now only happens when the turn was stopped before
        // anything streamed, or (rare) the agent produced no reply/proposal/findings and
        // nothing failed either — pi-runner throws instead of resolving silently whenever
        // it captured a real error (see pi-runner.ts's finishTurn), so this is an honest
        // "nothing to show", not a hidden failure.
        if (!replyText) {
          body.className = "tbody empty-reply";
          const who = modelName(modelId || chatModelEl.value) || "the agent";
          renderFailBody(`No response from ${who} — it returned no content.`);
        } else if (finalText !== undefined && finalText !== replyText) {
          // The persisted reply differs from the raw accumulated stream (e.g. Codex's
          // trailing fenced-json edit block was stripped server-side into turn.proposal —
          // see Phase-8 T1). Re-render from the source of truth so the raw JSON that was
          // live-streamed into this bubble never stays visible.
          renderTurnText(body, "agent", finalText);
        }
      },
      fail: (msg) => {
        body.className = "tbody agent-fail";
        renderFailBody(msg);
        t.classList.remove("working");
        t.querySelector(".spin")?.remove();
      },
    };
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
      let docChanged = false;
      try {
        const res = await deps.api.branchThread(
          { threadId: parentId, atTurnIndex: turnIndex, message, doc, ...(modelId ? { modelId } : {}) },
          (e: RpcEvent) => {
            if (deps.routeProposal(e)) return;
            if (e.event === "docChanged") docChanged = true;
            else bubble.onEvent(e);
          },
        );
        bubble.done();
        if (docChanged) {
          deps.log("agent edited the document — reloading");
          await deps.reloadActiveDoc();
        }
        registerBranchEntry(res.branchThreadId, quoted, parentId);
        refreshThreadSelect();
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

  function refreshThreadSelect(): void {
    const opts = ['<option value="">— no discussion —</option>'];
    for (const e of comments.values()) {
      const label = e.quoted.length > 30 ? e.quoted.slice(0, 30) + "…" : e.quoted;
      // Branch threads (forked from a parent) read as lineage under their source.
      // Escape: comment text is user-derived and interpolated into innerHTML.
      opts.push(`<option value="${escapeHtml(e.id)}">${e.parent ? "↳ " : ""}${escapeHtml(label)}</option>`);
    }
    chatThreadSelectEl.innerHTML = opts.join("");
    chatThreadSelectEl.value = activeChatId ?? "";
    // The select is hidden; the branch tree is the real navigator. Refresh it from
    // the server on every call site that refreshes the select, so they stay in sync.
    void refreshThreadTree();
  }

  /**
   * Fetch the discussion-thread lineage from the server and render it as a nested
   * branch tree into `#threadTree`. Roots are nodes with no parent (or whose parent
   * isn't in the set); children indent by depth. Each row promotes its thread into
   * the chat pane on click; the 📄 chip opens the version preview.
   */
  async function refreshThreadTree(): Promise<void> {
    const gen = ++treeGen;
    if (!deps.getDocPath()) {
      threadNodes = [];
      threadTreeEl.innerHTML = "";
      return;
    }
    let nodes: ThreadNode[];
    try {
      nodes = await deps.api.listThreads({});
    } catch (e) {
      if (gen !== treeGen) return; // stale: a newer call took over, discard
      reportError("thread tree load", e, deps.log);
      return;
    }
    if (gen !== treeGen) return; // stale: a newer call took over, discard
    threadNodes = nodes;
    renderThreadTree();
  }

  /** Render the (cached) thread tree, scoped to the active thread's branch family. */
  function renderThreadTree(): void {
    const byId = new Map(threadNodes.map((n) => [n.id, n]));
    const children = new Map<string, ThreadNode[]>();
    for (const n of threadNodes) {
      if (n.parent && byId.has(n.parent)) {
        const arr = children.get(n.parent) ?? [];
        arr.push(n);
        children.set(n.parent, arr);
      }
    }

    threadTreeEl.innerHTML = "";
    const renderNode = (node: ThreadNode, depth: number): void => {
      const kids = children.get(node.id) ?? [];
      const row = document.createElement("div");
      row.className = "tnode";
      row.dataset.thread = node.id;
      row.style.paddingLeft = `${0.4 + depth * 0.85}rem`;
      if (node.id === activeChatId) row.classList.add("active");

      const fork = document.createElement("span");
      fork.className = "tfork";
      fork.textContent = kids.length ? "⑂" : "";
      row.appendChild(fork);

      const title = document.createElement("span");
      title.className = "ttitle";
      title.textContent = deps.truncTitle(node.title);
      title.title = node.title;
      row.appendChild(title);

      const count = document.createElement("span");
      count.className = "tcount";
      count.textContent = String(node.turnCount);
      count.title = `${node.turnCount} turn(s)`;
      row.appendChild(count);

      if (node.baseVersion) {
        const chip = document.createElement("span");
        chip.className = "tverchip";
        chip.textContent = `📄 ${node.baseVersion}`;
        chip.title = `Pinned to version ${node.baseVersion}`;
        chip.addEventListener("click", (ev) => {
          ev.stopPropagation();
          void deps.openVersionPreview(node.baseVersion!);
        });
        row.appendChild(chip);
      }

      row.addEventListener("click", () => void promoteToChat(node.id));
      threadTreeEl.appendChild(row);
      for (const kid of kids) renderNode(kid, depth + 1);
    };

    // Focus the tree on the ACTIVE thread's family only (its root + descendants),
    // not every comment in the doc — otherwise it reads as an unrelated jumble.
    // A lone thread (no branches) shows no tree; the chat just shows its conversation.
    if (!activeChatId || !byId.has(activeChatId)) return;
    let rootId = activeChatId;
    for (let hop = 0; hop < threadNodes.length; hop++) {
      const node = byId.get(rootId);
      if (node?.parent && byId.has(node.parent)) rootId = node.parent;
      else break;
    }
    const familySize = (function size(id: string): number {
      return 1 + (children.get(id) ?? []).reduce((s, k) => s + size(k.id), 0);
    })(rootId);
    if (familySize <= 1) return; // single thread → nothing to navigate
    renderNode(byId.get(rootId)!, 0);
  }

  /** Threads that are alternatives to `displayedId` at turn index `i` (a fork point). Original first, then branches by createdAt. */
  function siblingsAt(displayedId: string, i: number): ThreadNode[] {
    const displayed = threadNodes.find((n) => n.id === displayedId);
    if (!displayed) return [];
    const byCreated = (a: ThreadNode, b: ThreadNode) =>
      a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
    // Case A: `displayed` is the original; branches fork off it at index i.
    const children = threadNodes.filter((n) => n.parent === displayedId && n.branchFromTurn === i);
    if (children.length > 0) return [displayed, ...children.sort(byCreated)];
    // Case B: `displayed` is itself a branch forked at index i; siblings = parent (original) + co-branches.
    if (displayed.parent && displayed.branchFromTurn === i) {
      const parent = threadNodes.find((n) => n.id === displayed.parent);
      const co = threadNodes
        .filter((n) => n.parent === displayed.parent && n.branchFromTurn === i)
        .sort(byCreated);
      const group = parent ? [parent, ...co] : [...co];
      return group;
    }
    return [];
  }

  /**
   * A ChatGPT-style version pager rendered under a forked "you" turn: `‹ k / n › ⑂`.
   * Flipping the arrows promotes the previous/next sibling thread into the chat pane
   * (which re-renders and recomputes the pager, keeping it in sync).
   */
  function renderVersionPager(sibs: ThreadNode[], currentId: string): void {
    const k = sibs.findIndex((n) => n.id === currentId); // 0-based
    const row = document.createElement("div");
    row.className = "verpager";
    const prev = document.createElement("button");
    prev.className = "vp-arrow";
    prev.textContent = "‹";
    prev.disabled = k <= 0;
    prev.title = "Previous branch at this point";
    const next = document.createElement("button");
    next.className = "vp-arrow";
    next.textContent = "›";
    next.disabled = k >= sibs.length - 1;
    next.title = "Next branch at this point";
    const label = document.createElement("span");
    label.className = "vp-label";
    label.textContent = ` ${k + 1} / ${sibs.length}  ⑂`;
    prev.addEventListener("click", () => {
      if (k > 0) void promoteToChat(sibs[k - 1].id);
    });
    next.addEventListener("click", () => {
      if (k < sibs.length - 1) void promoteToChat(sibs[k + 1].id);
    });
    row.append(prev, label, next);
    chatTurnsEl.appendChild(row); // sits right under the just-rendered turn
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
    chatThreadSelectEl.value = id;
    renderThreadTree(); // re-scope the tree to the newly-focused thread's family
    chatQuoteEl.hidden = false;
    chatQuoteEl.textContent = `“${quoted}”`;
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
    try {
      const thread = await deps.api.getThread({ threadId: id });
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
          const sibs = siblingsAt(id, i);
          if (sibs.length >= 2) renderVersionPager(sibs, id);
        }
      });
      if (thread.frontmatter?.status === "error" && lastUser && !chatInputEl.value.trim()) {
        chatInputEl.value = lastUser.body;
      }
      if (!thread.turns.length) {
        chatTurn("you", entry.commentInput.value || "(write a comment, then Discuss)");
      }
    } catch {
      chatTurn("you", entry.commentInput.value || "(write a comment, then Discuss)");
    }
    // Phase 9 T1: replay this thread's still-queued (not yet dispatched) messages —
    // they're client-only, so the getThread() above never includes them. This is
    // what makes switching away from a busy thread and back show them again,
    // instead of a queued message silently vanishing until it's actually sent.
    for (const item of sendQueue.list(id)) renderYouTurn(item, { queued: true });
    refreshEditLocks(); // Phase 9 T2: a reopened busy/queued thread starts fork-locked too
  }

  chatThreadSelectEl.addEventListener("change", () => {
    if (chatThreadSelectEl.value) void promoteToChat(chatThreadSelectEl.value);
  });

  /**
   * Run the Improve flow for thread `id`: render a proposal box in the chat pane,
   * stream the agent's rewrite into it, then wire Apply to `approveProposal` (the
   * backend persists every Improve rewrite as a proposal — a legacy single-span one
   * for markdown, a structured hunk one for HTML — so Apply is always the same RPC).
   * Shared by the chat Improve button and the popover ✨ Improve quick action (the
   * popover activates the chat pane first so the box renders).
   */
  async function runImprove(id: string): Promise<void> {
    if (!deps.getDocPath()) return;
    chatImproveEl.disabled = true;
    chatImproveEl.textContent = "Improving...";
    const entry = comments.get(id);
    // One live improve proposal at a time — drop any stale box (e.g. from a prior
    // Improve click on this pane) so rewrites don't stack on top of each other.
    chatTurnsEl.querySelectorAll(".proposal").forEach((node) => node.remove());
    const box = document.createElement("div");
    box.className = "proposal working";
    box.innerHTML = `<div class="ptitle">Proposed rewrite</div>
      <div class="pold"></div><div class="pnew"></div>
      <div class="pacts"><button class="papply" disabled>Apply and version</button><button class="preject">Reject</button></div>`;
    box.querySelector<HTMLDivElement>(".pold")!.textContent = entry?.quoted ?? "";
    const pnew = box.querySelector<HTMLDivElement>(".pnew")!;
    pnew.classList.add("pending");
    pnew.textContent = "Waiting for the agent stream...";
    const applyBtn = box.querySelector<HTMLButtonElement>(".papply")!;
    box.querySelector<HTMLButtonElement>(".preject")!.addEventListener("click", () => box.remove());
    chatEmptyEl.hidden = true;
    chatTurnsEl.appendChild(box);
    chatTurnsEl.scrollTop = chatTurnsEl.scrollHeight;

    setChatBusy(id); // show Stop; cancelKey for improve is docPath#<id>
    let sawToken = false;
    let sawProposal = false;
    let proposedText = "";
    const outcome = await runStreamingTurn({
      run: () =>
        deps.api.improve(
          { threadId: id },
          (e) => {
            if (deps.routeProposal(e)) {
              sawProposal = true;
              pnew.classList.remove("pending");
              pnew.textContent = "Review the proposed edit in the document.";
              return;
            }
            if (e.event === "token") {
              if (!sawToken) {
                pnew.textContent = "";
                pnew.classList.remove("pending");
                sawToken = true;
              }
              proposedText += String(e.data);
              deps.renderPreviewText(pnew, proposedText);
              chatTurnsEl.scrollTop = chatTurnsEl.scrollHeight;
            }
          },
        ),
      onError: (e) => {
        pnew.classList.remove("pending");
        pnew.textContent = `⚠ ${String(e)}`;
        chatImproveEl.disabled = false;
        updateChatActions();
      },
      onSettled: () => {
        box.classList.remove("working");
        setChatBusy(null);
      },
    });
    if (!outcome.ok) return;
    const result = outcome.result;
    const proposalId = result.proposalId;
    // HTML Improve's newText is a raw HTML fragment — never dump it as chat text; point
    // the reviewer at the in-document proposal card instead. Markdown's proposal is a
    // plain legacy single-span one (see Orchestrator.improve), so its newText is always
    // safe to show here directly.
    if (proposalId && deps.getFormat() === "html") {
      pnew.classList.remove("pending");
      pnew.textContent = sawProposal
        ? "Review the proposed edit in the document."
        : "Review the proposed edit in the document, then approve it here or inline.";
    } else if (!sawToken || !deps.rawPreviewText(pnew).trim()) {
      pnew.classList.remove("pending");
      proposedText = result.newText;
      deps.renderPreviewText(pnew, proposedText);
    }
    applyBtn.disabled = false;
    applyBtn.addEventListener("click", async () => {
      applyBtn.disabled = true;
      try {
        if (!proposalId) throw new Error("no proposal to approve");
        await deps.api.approveProposal({ threadId: id, proposalId });
        deps.log(`applied rewrite to ${id}`);
        box.remove();
        await deps.reloadActiveDoc();
      } catch (e) {
        // Already-resolved retry (see ui.ts's alreadyResolvedStatus + proposalActions):
        // a lost approve RESPONSE (connection drop / sidecar restart after the server
        // durably applied it) leaves this box live; the retry click then gets the
        // orchestrator's `proposal already <status>` guard. Mirror proposalActions'
        // success-shaped cleanup instead of re-enabling for another doomed retry:
        // "already approved" → the same success continuation as above (remove the box,
        // reload to pick up the applied rewrite); "already rejected" → just remove the
        // box (no reload — nothing was applied). The button stays disabled either way:
        // the box is being torn down, not retried. (This box's Reject stays client-side
        // only — documented phase-3 tech debt, deliberately untouched here.)
        const resolved = alreadyResolvedStatus(e);
        if (resolved) {
          deps.log(`proposal already ${resolved} — removing the stale card`);
          box.remove();
          if (resolved === "approved") await deps.reloadActiveDoc();
          return;
        }
        reportError("apply", e, deps.log);
        applyBtn.disabled = false;
      }
    });
    chatImproveEl.disabled = false;
    updateChatActions();
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
   * thread's pane is open), and the docChanged-triggered reload are not.
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
    let docChanged = false;
    const onEvent = (e: RpcEvent) => {
      if (deps.routeProposal(e)) return;
      if (e.event === "docChanged") docChanged = true;
      else bubble?.onEvent(e);
    };
    setChip(threadId, "running");
    if (isActive) setChatBusy(threadId); // show Stop; cancelKey for discuss/reply is docPath#<threadId>
    // onSuccess runs INSIDE runStreamingTurn's try, before its finally clears busy — matching
    // the pre-refactor try body, which ran bubble.done()/setCommentActionState/the conditional
    // `await reloadActiveDoc()` before `finally { setChatBusy(null) }`. Without this, busy (Stop
    // button) would clear before an in-flight reload finished.
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
        if (docChanged) {
          deps.log("agent edited the document — reloading");
          await deps.reloadActiveDoc();
        }
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
    if (!models.length) models.push(chatModelEl.value || "");
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
      onSettled: () => setChatBusy(null),
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

  // --- document-wide Agent Review Pass ---
  // Runs one agent over the whole doc; each finding becomes an agent-authored comment
  // (with an optional pending proposal) that lands in the review rail via the normal
  // load path. The agent never edits the doc — edits are reviewed/approved as usual.
  reviewDocBtn.addEventListener("click", () => {
    if (!deps.getDocPath()) return void deps.log("review: open a document first");
    reviewForm.hidden = !reviewForm.hidden;
    if (!reviewForm.hidden) {
      modelSelectOptions(reviewModelEl, defaultModelKey);
      reviewRubricEl.focus();
    }
  });
  reviewCancelEl.addEventListener("click", () => {
    reviewForm.hidden = true;
  });

  async function runReview(): Promise<void> {
    if (!deps.getDocPath()) return;
    reviewRunEl.disabled = true;
    reviewStatusEl.hidden = false;
    reviewStatusEl.textContent = "Reviewing the document…";
    let count = 0;
    const modelId = reviewModelEl.value || undefined;
    setOptimisticTask("review", "running");
    agentsBtn.textContent = "Agents (…)"; // instant feedback; the poll reconciles the real count
    agentsBtn.classList.add("busy");
    try {
      await deps.syncDocToDisk(); // review the text the user currently sees, not the last save
      const res = await deps.api.reviewDocument(
        {
          stance: reviewStanceEl.value,
          rubric: reviewRubricEl.value.trim() || undefined,
          ...(modelId ? { modelId } : {}),
        },
        (e) => {
          // pi harness: add_review_finding emits this live, as the agent calls the tool,
          // so the counter ticks up while the model is still working. Codex harness
          // reviews (no such tool) emit no live "finding" frames — reviewStatus just
          // stays "Reviewing the document…" until the batch lands, unchanged from before.
          if (e.event === "finding") {
            count++;
            reviewStatusEl.textContent = `Reviewing… ${count} finding${count === 1 ? "" : "s"} so far`;
          }
        },
      );
      const n = res.findings.length;
      reviewStatusEl.textContent = `Review complete — ${n} finding${n === 1 ? "" : "s"} added to the rail.`;
      deps.log(`review pass added ${n} finding(s)`);
      await deps.reloadActiveDoc(); // re-render annotations + proposals through the normal load path
    } catch (e) {
      reviewStatusEl.textContent = `Review failed: ${String(e)}`;
      reportError("review", e, deps.log);
    } finally {
      clearOptimisticTask("review");
      reviewRunEl.disabled = false;
    }
  }
  reviewRunEl.addEventListener("click", () => void runReview());

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
    try {
      const thread = await deps.api.getThread({ threadId: id });
      if (thread.frontmatter?.stance) chatStanceEl.value = thread.frontmatter.stance;
      modelSelectOptions(chatModelEl, thread.frontmatter?.model ?? defaultModelKey);
      if (!thread.turns.length) chatTurn("system", "No transcript for this agent task yet.");
      thread.turns.forEach((tn, i) => chatTurn(tn.role, tn.body, tn.meta, tn.thinking, i));
    } catch (e) {
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
    else await openThreadById(id, taskTitle(id));
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
    await openThreadById(id, taskTitle(id));
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
  async function runResolveDirectives(): Promise<void> {
    if (!deps.getDocPath()) return void deps.log("directives: open a document first");
    resolveDirectivesBtn.disabled = true;
    deps.setDirectivesWorking(true); // pulse the [[ … ]] chips while the pass runs
    setOptimisticTask("directives", "running");
    agentsBtn.textContent = "Agents (…)"; // instant feedback; the poll reconciles the real count
    agentsBtn.classList.add("busy");
    const outcome = await runStreamingTurn({
      run: async () => {
        await deps.syncDocToDisk(); // ensure just-typed [[ … ]] directives are on disk for the backend
        return deps.api.resolveDirectives(
          {},
          // Proposal events render the edit inline (markdown decoration or HTML overlay);
          // tokens are ignored here since the outcome is reported in the result.
          (e) => void deps.routeProposal(e),
        );
      },
      onError: (e) => reportError("resolve directives", e, deps.log),
      onSettled: () => {
        clearOptimisticTask("directives");
        resolveDirectivesBtn.disabled = false;
        deps.setDirectivesWorking(false);
      },
    });
    if (!outcome.ok) return;
    const res = outcome.result;
    if (res.count === 0) {
      showDirectiveResult("No [[ … ]] directives found in the document.", "");
      deps.log("no [[ … ]] directives found");
    } else if (res.proposed) {
      deps.log(`resolving ${res.count} directive(s) — review the proposed edit in the document`);
    } else {
      // The agent responded but proposed no edit (e.g. it couldn't fulfill the directive).
      // Surface its reply so the action isn't a silent no-op. Exactly one directive means
      // this summary IS that one thread ("directive-1") — since res.proposed is false here,
      // that single directive is the one that didn't propose, so it's a real reply target.
      showDirectiveResult(
        `The agent didn't propose an edit for the ${res.count} directive(s):`,
        res.reply,
        res.count === 1 ? "directive-1" : undefined,
      );
      deps.log("resolve directives: agent returned no edit (see chat pane)");
    }
  }
  resolveDirectivesBtn.addEventListener("click", () => void runResolveDirectives());

  // Keyboard shortcut so you can resolve directives without reaching for the mouse.
  function handleResolveShortcut(e: KeyboardEvent): void {
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === "d" || e.key === "D")) {
      e.preventDefault();
      e.stopPropagation();
      void runResolveDirectives();
    }
  }
  window.addEventListener("keydown", handleResolveShortcut, true);

  function setOptimisticTask(threadId: string, status: TaskRow["status"]): void {
    // piSessionId is unknown until the backend's TaskDB row exists; null is the
    // canonical "no session yet" value (matches the real row's shape once it lands).
    optimisticTasks.set(threadId, { threadId, status, piSessionId: null, updatedAt: new Date().toISOString() });
    void refreshAgents();
  }

  function clearOptimisticTask(threadId: string): void {
    optimisticTasks.delete(threadId);
    void refreshAgents();
  }

  /** Human label for a task's thread id (comment quote, or a name for pseudo-threads). */
  function taskTitle(threadId: string): string {
    if (threadId === "directives") return "Inline directives";
    if (/^directive-\d+$/.test(threadId)) return `Inline directive ${threadId.slice("directive-".length)}`;
    if (threadId === "review") return "Review pass";
    const q = comments.get(threadId)?.quoted;
    if (q) return q.length > 40 ? q.slice(0, 40) + "…" : q;
    return threadId;
  }

  /** Drop an optimistic placeholder after this long even if its RPC never settled — a
   * safety net behind the try/finally clearOptimisticTask calls at each call site (e.g. a
   * hung backend that never closes the socket, so the promise never resolves OR rejects). */
  const OPTIMISTIC_TASK_TTL_MS = 5 * 60 * 1000;

  /**
   * The ONE source of truth for the task list: server rows merged with any live
   * optimistic placeholder (a real server row always wins over a same-id placeholder).
   * Both `refreshAgents` (the panel) and `refreshAgentsBadge` (the always-on poll) render
   * from this SAME list, so the badge count and the panel's row count can never disagree
   * — they used to be computed two different ways (badge from raw server rows, panel from
   * the merge), which is exactly how the badge and panel fell out of sync in practice.
   */
  async function mergedTasks(): Promise<TaskRow[]> {
    const tasks = await deps.api.listTasks({});
    const byId = new Map(tasks.map((t) => [t.threadId, t]));
    const now = Date.now();
    for (const [id, t] of optimisticTasks) {
      if (now - Date.parse(t.updatedAt) > OPTIMISTIC_TASK_TTL_MS) {
        optimisticTasks.delete(id); // stale placeholder — its RPC never settled
        continue;
      }
      // If the real backend task exists, it wins; otherwise show the optimistic task.
      if (!byId.has(id)) byId.set(id, t);
    }
    return [...byId.values()].sort(
      (a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "") || a.threadId.localeCompare(b.threadId),
    );
  }

  async function refreshAgents(): Promise<void> {
    if (!deps.getDocPath()) {
      agentsPanel.replaceChildren();
      const empty = document.createElement("div");
      empty.className = "agentsempty";
      empty.textContent = "No document open.";
      agentsPanel.appendChild(empty);
      return;
    }
    let tasks: TaskRow[];
    try {
      tasks = await mergedTasks();
    } catch (e) {
      reportError("agents load", e, deps.log);
      return;
    }
    agentsPanel.replaceChildren();
    updateAgentsBadge(tasks);

    // Pin the doc-wide pseudo-tasks (directives, review) ahead of per-comment threads so
    // they're never buried under the capped Recent list.
    const pseudoFirst = (rows: TaskRow[]): TaskRow[] => {
      const isPseudo = (t: TaskRow) =>
        t.threadId === "directives" || t.threadId === "review" || /^directive-\d+$/.test(t.threadId);
      return [...rows.filter(isPseudo), ...rows.filter((t) => !isPseudo(t))];
    };
    const active = pseudoFirst(tasks.filter((t) => t.status === "running" || t.status === "queued"));
    const errored = pseudoFirst(tasks.filter((t) => t.status === "error"));
    const done = pseudoFirst(tasks.filter((t) => t.status === "responded"));

    const renderGroup = (label: string, rows: TaskRow[], cap?: number): void => {
      if (rows.length === 0) return;
      const head = document.createElement("div");
      head.className = "agentshead";
      head.textContent = label;
      agentsPanel.appendChild(head);
      const shown = cap ? rows.slice(0, cap) : rows;
      for (const t of shown) {
        const row = document.createElement("div");
        row.className = "agentrow";
        const title = document.createElement("span");
        title.className = "agenttitle";
        const chip = document.createElement("span");
        chip.className = `chip ${t.status === "queued" ? "running" : t.status}`;
        chip.textContent = t.status;
        const label = taskTitle(t.threadId);
        if (t.status === "error" && t.errorText) {
          // Compact first line inline; the full message (title + errorText) is reachable
          // via the native tooltip on both the row and the chip (the Attention popover's
          // error indicator).
          title.textContent = `${label} — ${t.errorText.split("\n")[0]}`;
          const tooltip = `${label}\n${t.errorText}`;
          row.title = tooltip;
          chip.title = tooltip;
        } else {
          title.textContent = label;
        }
        row.append(title, chip);
        // Optimistic placeholder rows (set by setOptimisticTask, not yet reconciled with a
        // real backend TaskRow — see mergedTasks) have no thread to open yet: getThread
        // would 404. Referential identity against the live `optimisticTasks` entry tells
        // us THIS row object is the placeholder rather than a same-id real row that already
        // won the merge (a real row always wins — mergedTasks never overwrites one with its
        // optimistic counterpart), so real rows stay clickable throughout their lifecycle.
        if (optimisticTasks.get(t.threadId) === t) {
          row.title = "Starting…";
        } else {
          row.classList.add("clickable");
          row.addEventListener("click", () => {
            agentsPanel.hidden = true;
            stopAgentsPoll();
            // Comment threads promote with their highlight context; directive/review
            // threads open as plain conversations (replyable since Phase 8).
            if (comments.has(t.threadId)) void promoteToChat(t.threadId);
            else void openThreadById(t.threadId, taskTitle(t.threadId));
          });
        }
        agentsPanel.appendChild(row);
      }
      if (cap && rows.length > cap) {
        const more = document.createElement("div");
        more.className = "agentsempty";
        more.textContent = `+${rows.length - cap} more`;
        agentsPanel.appendChild(more);
      }
    };

    if (tasks.length === 0) {
      const empty = document.createElement("div");
      empty.className = "agentsempty";
      empty.textContent = "No agent tasks yet. Discuss a comment, run a Review, or Resolve [[ ]].";
      agentsPanel.appendChild(empty);
      return;
    }
    renderGroup("Active", active);
    renderGroup("Attention", errored);
    renderGroup("Recent", done, 10);
  }

  /** Update just the Agents button's running-count badge from a task list. */
  function updateAgentsBadge(tasks: TaskRow[]): void {
    const running = tasks.filter((t) => t.status === "running" || t.status === "queued").length;
    agentsBtn.textContent = running > 0 ? `Agents (${running})` : "Agents";
    agentsBtn.classList.toggle("busy", running > 0);
  }

  /** Lightweight always-on poll so the button shows live activity even when the panel is closed. */
  async function refreshAgentsBadge(): Promise<void> {
    if (!deps.getDocPath()) {
      agentsBtn.textContent = "Agents";
      agentsBtn.classList.remove("busy");
      return;
    }
    try {
      updateAgentsBadge(await mergedTasks());
    } catch {
      /* ignore transient poll errors */
    }
  }
  setInterval(() => void refreshAgentsBadge(), 2000);

  function positionAgentsPanel(): void {
    const r = agentsBtn.getBoundingClientRect();
    agentsPanel.style.top = `${r.bottom + 6}px`;
    agentsPanel.style.right = `${Math.max(8, window.innerWidth - r.right)}px`;
  }
  function stopAgentsPoll(): void {
    if (agentsPoll !== null) {
      clearInterval(agentsPoll);
      agentsPoll = null;
    }
  }
  agentsBtn.addEventListener("click", () => {
    agentsPanel.hidden = !agentsPanel.hidden;
    if (agentsPanel.hidden) {
      stopAgentsPoll();
      return;
    }
    positionAgentsPanel();
    void refreshAgents();
    // Poll while open so running → responded transitions show live (no global timers otherwise).
    agentsPoll = setInterval(() => void refreshAgents(), 1500) as unknown as number;
  });
  document.addEventListener("mousedown", (e) => {
    if (agentsPanel.hidden) return;
    if (e.target === agentsBtn || agentsPanel.contains(e.target as Node)) return;
    agentsPanel.hidden = true;
    stopAgentsPoll();
  });

  /** A compact margin comment: number + author + text + stance + actions. */
  function addCommentCard(
    id: string,
    quoted: string,
    body = "",
    num = 0,
    author?: string,
    resolved = false,
    reviewMeta?: { origin?: string; severity?: string; kind?: string },
  ): void {
    const card = document.createElement("div");
    card.className = "comment-card";
    card.dataset.anno = id;
    card.innerHTML = `
      <div class="chead"><span class="cnum"></span><span class="quoted"></span></div>
      <div class="cmeta"><span class="cauthor"></span><span class="cresolved">✓ resolved</span></div>
      <textarea class="cinput" rows="2" placeholder="Comment…"></textarea>
      <div class="crow">
        <select class="stance" title="Agent stance">
          <option value="none">🗣 none</option>
          <option value="critiquer">🔍 critiquer</option>
          <option value="supporter">🤝 supporter</option>
        </select>
        <select class="cmodel" title="Model"></select>
        <button class="discuss">Ask agent</button>
        <span class="chip idle"></span>
        <button class="delete" title="Delete comment">Delete</button>
      </div>`;
    card.querySelector<HTMLSpanElement>(".cnum")!.textContent = String(num);
    card.querySelector<HTMLSpanElement>(".quoted")!.textContent = `“${quoted}”`;
    const isAgent = reviewMeta?.origin === "agent";
    card.querySelector<HTMLSpanElement>(".cauthor")!.textContent = isAgent
      ? "Agent review"
      : `${author ?? "you"}`;
    if (isAgent) {
      card.classList.add("agent");
      const sev = reviewMeta?.severity;
      const label = [sev, reviewMeta?.kind].filter(Boolean).join(" · ");
      if (label) {
        card.querySelector<HTMLDivElement>(".cmeta")!.prepend(
          el("span", { className: `revchip sev-${sev ?? "info"}`, textContent: label }),
        );
      }
    }
    if (resolved) card.classList.add("resolved");
    const input = card.querySelector<HTMLTextAreaElement>(".cinput")!;
    const stanceSel = card.querySelector<HTMLSelectElement>(".stance")!;
    const modelSel = card.querySelector<HTMLSelectElement>(".cmodel")!;
    modelSelectOptions(modelSel, defaultModelKey);
    const discussBtn = card.querySelector<HTMLButtonElement>(".discuss")!;
    const chip = card.querySelector<HTMLSpanElement>(".chip")!;
    input.value = body;

    const entry: CommentEntry = {
      id, quoted, card, chip, discussBtn, stanceSel, commentInput: input, discussed: false, resolved,
    };
    comments.set(id, entry);
    refreshThreadSelect();

    // Keep the field you're typing in visible: when the textarea gains focus, scroll
    // its card into view within the rail (the rail doesn't auto-follow focus on its own).
    input.addEventListener("focus", () => {
      card.scrollIntoView({ block: "nearest" });
    });

    input.addEventListener("blur", () => {
      if (deps.getDocPath() && !entry.discussed) {
        void deps.api.saveComment({ id, anchorExact: quoted, body: input.value }).catch(() => {});
      }
    });

    const prefillLastUserForResend = async (): Promise<void> => {
      if (!deps.getDocPath() || chatInputEl.value.trim()) return;
      try {
        const thread = await deps.api.getThread({ threadId: id });
        const last = lastUserTurn(thread.turns);
        if (last) chatInputEl.value = last.body;
      } catch {
        /* best effort; the user can still type a resend */
      }
    };

    // Discuss promotes this thread into the chat pane and streams the agent's
    // reasoning + reply there live, so you always see the response (not just a chip).
    const runCardAskAgent = async (): Promise<void> => {
      if (entry.discussed) {
        await promoteToChat(id);
        await prefillLastUserForResend();
        chatInputEl.focus();
        return;
      }
      const comment = input.value.trim();
      if (!comment || !deps.getDocPath()) return;
      chatStanceEl.value = stanceSel.value;
      activateChatPane(id, quoted);
      chatModelEl.value = modelSel.value; // keep the footer picker in sync
      setCommentActionState(entry, "running");
      setChatBusy(id); // show Stop; cancelKey for discuss is docPath#<id>
      chatTurn("you", comment);
      const modelId = modelSel.value || undefined;
      const bubble = streamingAgentTurn(stanceSel.value, modelId);
      let docChanged = false;
      try {
        await deps.api.discuss(
          { threadId: id, annotationId: id, stance: stanceSel.value, comment, ...(modelId ? { modelId } : {}) },
          (e: RpcEvent) => {
            if (deps.routeProposal(e)) return;
            if (e.event === "docChanged") docChanged = true;
            else bubble.onEvent(e);
          },
        );
        bubble.done(await fetchLastAgentReply(id));
        entry.discussed = true;
        setCommentActionState(entry, "responded");
        if (docChanged) {
          deps.log("agent edited the document — reloading");
          await deps.reloadActiveDoc();
        }
      } catch (e) {
        bubble.fail(String(e));
        entry.discussed = false;
        setCommentActionState(entry, "error");
        reportError("discuss", e, deps.log);
      } finally {
        setChatBusy(null);
      }
    };
    discussBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      void runCardAskAgent();
    });
    const delBtn = card.querySelector<HTMLButtonElement>(".delete")!;
    delBtn.addEventListener("click", async (ev) => {
      ev.stopPropagation();
      if (!deps.getDocPath()) return;
      if (!window.confirm("Delete this comment and its discussion?")) return;
      await deps.removeAnnotationById(id);
      deps.log(`deleted ${id}`);
    });
    card.addEventListener("click", (ev) => {
      const target = ev.target as HTMLElement | null;
      if (target?.closest("button, textarea, select, input, label")) return;
      void promoteToChat(id);
    });
    commentsEl.prepend(card);

    // reflect persisted state: a thread with agent turns is already discussed
    if (deps.getDocPath()) {
      void deps.api
        .getThread({ threadId: id })
        .then((t) => {
          const last = lastUserTurn(t.turns);
          if (last && !input.value.trim()) input.value = last.body;
          if (t.frontmatter?.status === "error" && last) {
            entry.discussed = t.turns.some((x) => x.role === "agent");
            setCommentActionState(entry, "error");
          } else if (t.turns.some((x) => x.role === "agent")) {
            entry.discussed = true;
            setCommentActionState(entry, "responded");
          }
        })
        .catch(() => {});
    }
  }

  /**
   * Register a branch thread in the comment registry so it shows in the thread
   * selector and can be promoted into the chat pane — WITHOUT a doc highlight or a
   * numbered right-pane card (the parent's highlight already marks the text).
   * The card it builds is a detached, hidden element kept only so the existing
   * CommentEntry reads (activateChatPane's classList toggle, setChip, the empty
   * promoteToChat fallback) keep working unchanged.
   */
  function registerBranchEntry(branchId: string, quoted: string, parentId: string): void {
    if (comments.has(branchId)) return;
    const card = document.createElement("div");
    card.className = "comment-card branch-entry";
    card.dataset.anno = branchId;
    card.hidden = true; // never shown in the right margin
    const chip = document.createElement("span");
    chip.className = "chip idle";
    const discussBtn = document.createElement("button");
    const stanceSel = document.createElement("select");
    const commentInput = document.createElement("textarea");
    const entry: CommentEntry = {
      id: branchId,
      quoted,
      card,
      chip,
      discussBtn,
      stanceSel,
      commentInput,
      discussed: true, // a branch is born with a seeded conversation
      resolved: false,
      parent: parentId,
    };
    comments.set(branchId, entry);
    refreshThreadSelect();
  }

  /**
   * The comment-registry side of fully removing an annotation: backend delete +
   * in-document decoration removal happen in main.ts's removeAnnotationById, which
   * calls this for the (for comments) margin-card/branch-children/chat-pane cleanup.
   */
  function removeCommentEntry(id: string): void {
    if (!comments.has(id)) return;
    comments.get(id)?.card.remove();
    comments.delete(id);
    for (const [bid, e] of comments) if (e.parent === id) comments.delete(bid);
    // The thread itself is gone — any messages still waiting behind an in-flight
    // turn for it would otherwise sit in the queue forever with nothing left to
    // deliver them to.
    for (const item of sendQueue.list(id)) turnElByItemId.delete(item.id);
    sendQueue.clearThread(id);
    refreshThreadSelect();
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
    commentsEl.innerHTML = "";
    comments.clear();
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
    threadTreeEl.innerHTML = "";
    threadNodes = [];
    // Reset the review form: dismiss the form and its status line so the previous
    // document's review result ("N findings added to the rail") does not persist in
    // the right pane after switching to a different document.
    reviewForm.hidden = true;
    reviewStatusEl.hidden = true;
    reviewStatusEl.textContent = "";
    refreshThreadSelect();
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
    markDiscussed: (id) => {
      const e = comments.get(id);
      if (e) e.discussed = true;
    },
    focusCommentInput: (id) => comments.get(id)?.commentInput.focus(),
    hasComment: (id) => comments.has(id),
    getCommentQuoted: (id) => comments.get(id)?.quoted,
    addCommentCard,
    registerBranchEntry,
    removeCommentEntry,
    resetChat,
    getThreadNodes: () => threadNodes,
    refreshThreadTree,
    refreshThreadModels,
    setDefaultModelKey: (key) => {
      defaultModelKey = key;
    },
    modelName,
    runReview,
    runResolveDirectives,
    runImprove,
    refreshAgents,
    handleResolveShortcut,
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
