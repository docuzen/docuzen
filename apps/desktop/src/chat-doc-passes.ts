// The two document-wide agent passes and their controls: the Review pass (Review rail
// button + form) and the inline-directive pass (Resolve [[ ]] button, ⌘⇧D). Each runs
// one RPC over the whole document; results land through the normal load path (findings
// become comment cards, edits become proposals or — in Editing mode — applied edits).
// Split out of chat.ts; reaches the chat pane only through `deps`.
//
// A pass belongs to the document it was started on, not to the tab on screen: it pins
// that document's path before anything awaits and passes it to every RPC, and it holds
// a per-document lock (one review and one directive pass per document at a time; a
// second Review click or ⌘⇧D is refused while one runs). The controls show the state of
// the document ON SCREEN: switching away hides a running pass and frees the buttons for
// the other document; coming back shows it running again, and when it finishes while its
// document is on screen it reports and reloads there. A pass that finishes while its
// document is not on screen touches nothing — its findings, edits and proposals are on
// disk and load with the document.
import type { RpcEvent } from "@ai-native-doc/docd/protocol";
import type { DocdApi } from "./session.js";
import type { AgentsPanelApi } from "./chat-agents-panel.js";
import { reportError, runStreamingTurn } from "./ui.js";
import { startWaitStatus, type WaitStatus } from "./wait-status.js";

export interface DocPassesDeps {
  api: DocdApi;
  log: (line: string) => void;
  getDocPath: () => string | undefined;
  /** Flush the editor to disk first: the agent must work on the text the user sees. */
  syncDocToDisk: () => Promise<void>;
  reloadActiveDoc: () => Promise<void>;
  routeProposal: (e: RpcEvent) => boolean;
  /** editor.ts's directive-chip pulse while the pass runs. */
  setDirectivesWorking: (on: boolean) => void;
  /** Fill a model <select> with the configured models, defaulting to the doc's model. */
  fillModelPicker: (sel: HTMLSelectElement) => void;
  agents: Pick<AgentsPanelApi, "setOptimisticTask" | "clearOptimisticTask" | "markStarting" | "refreshAgents">;
  /** Show a directive-pass outcome banner in the chat pane (see chat.ts). */
  showDirectiveResult: (headline: string, reply: string, threadId?: string) => void;
}

export interface DocPassesApi {
  runReview: () => Promise<void>;
  runResolveDirectives: () => Promise<void>;
  handleResolveShortcut: (e: KeyboardEvent) => void;
  /** The active document changed (or was reloaded): show the controls for it. */
  reset: () => void;
}

/** A review running on one document. */
interface ReviewRun {
  readonly docPath: string;
  readonly t0: number;
  label: string;
}

export function initDocPasses(deps: DocPassesDeps): DocPassesApi {
  const reviewDocBtn = document.querySelector<HTMLButtonElement>("#reviewDocBtn")!;
  const reviewForm = document.querySelector<HTMLDivElement>("#reviewForm")!;
  const reviewStanceEl = document.querySelector<HTMLSelectElement>("#reviewStance")!;
  const reviewModelEl = document.querySelector<HTMLSelectElement>("#reviewModel")!;
  const reviewRubricEl = document.querySelector<HTMLTextAreaElement>("#reviewRubric")!;
  const reviewRunEl = document.querySelector<HTMLButtonElement>("#reviewRun")!;
  const reviewCancelEl = document.querySelector<HTMLButtonElement>("#reviewCancel")!;
  const reviewStatusEl = document.querySelector<HTMLDivElement>("#reviewStatus")!;
  const resolveDirectivesBtn = document.querySelector<HTMLButtonElement>("#resolveDirectivesBtn")!;

  // Per-document locks (see the file header).
  const reviews = new Map<string, ReviewRun>();
  const directivePasses = new Set<string>();
  /** The document the review form / status line currently belong to. */
  let reviewAreaDoc: string | undefined;
  /** The live clock on the status line, for the review shown there. */
  let statusClock: WaitStatus | null = null;

  const onScreen = (docPath: string): boolean => deps.getDocPath() === docPath;
  /** The [[ … ]] chip pulse, switched only on a change (each call re-decorates the editor). */
  let pulsing = false;
  function setPulse(on: boolean): void {
    if (on === pulsing) return;
    pulsing = on;
    deps.setDirectivesWorking(on);
  }

  // --- document-wide Agent Review Pass ---
  // Runs one agent over the whole doc; each finding becomes an agent-authored comment
  // (with an optional pending proposal) that lands in the review rail via the normal
  // load path. The agent never edits the doc — edits are reviewed/approved as usual.
  reviewDocBtn.addEventListener("click", () => {
    if (!deps.getDocPath()) return void deps.log("review: open a document first");
    reviewForm.hidden = !reviewForm.hidden;
    if (!reviewForm.hidden) {
      reviewAreaDoc = deps.getDocPath();
      deps.fillModelPicker(reviewModelEl);
      reviewRubricEl.focus();
    }
  });
  reviewCancelEl.addEventListener("click", () => {
    reviewForm.hidden = true;
  });

  /** Show `run` on the status line: its label and a clock counting from its start. */
  function showReviewRun(run: ReviewRun): void {
    statusClock?.stop();
    reviewAreaDoc = run.docPath;
    reviewStatusEl.hidden = false;
    statusClock = startWaitStatus(reviewStatusEl, run.label, run.t0);
  }
  /** Replace the status line's text with a final message for `docPath`. */
  function settleReviewStatus(text: string): void {
    statusClock?.stop();
    statusClock = null;
    reviewStatusEl.hidden = false;
    reviewStatusEl.textContent = text;
  }

  async function runReview(): Promise<void> {
    const docPath = deps.getDocPath();
    if (!docPath) return;
    if (reviews.has(docPath)) return void deps.log("review: this document is already being reviewed — wait for it to finish");
    const run: ReviewRun = { docPath, t0: Date.now(), label: "Reviewing the document…" };
    reviews.set(docPath, run);
    reviewRunEl.disabled = true;
    showReviewRun(run);
    let count = 0;
    const modelId = reviewModelEl.value || undefined;
    deps.agents.setOptimisticTask("review", "running", docPath);
    deps.agents.markStarting(); // instant feedback; the poll reconciles the real count
    try {
      await deps.syncDocToDisk(); // review the text the user currently sees, not the last save
      const res = await deps.api.reviewDocument(
        {
          docPath,
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
            run.label = `Reviewing… ${count} finding${count === 1 ? "" : "s"} so far`;
            if (onScreen(docPath)) statusClock?.set(run.label);
          }
        },
      );
      reviews.delete(docPath);
      const n = res.findings.length;
      const appliedCount = res.findings.filter((x) => x.applied).length;
      deps.log(`review pass added ${n} finding(s)`);
      if (!onScreen(docPath)) return; // the findings are on disk: they load with the document
      settleReviewStatus(
        `Review complete — ${n} finding${n === 1 ? "" : "s"} added to the rail.` +
          (appliedCount ? ` ${appliedCount} edit${appliedCount === 1 ? "" : "s"} applied (Editing mode).` : ""),
      );
      await deps.reloadActiveDoc(); // re-render annotations + proposals through the normal load path
    } catch (e) {
      reviews.delete(docPath);
      reportError("review", e, deps.log);
      if (onScreen(docPath)) settleReviewStatus(`Review failed: ${String(e)}`);
    } finally {
      reviews.delete(docPath);
      deps.agents.clearOptimisticTask("review", docPath);
      if (onScreen(docPath)) reviewRunEl.disabled = false;
    }
  }
  reviewRunEl.addEventListener("click", () => void runReview());

  async function runResolveDirectives(): Promise<void> {
    const docPath = deps.getDocPath();
    if (!docPath) return void deps.log("directives: open a document first");
    if (directivePasses.has(docPath)) {
      return void deps.log("directives: already resolving [[ … ]] in this document — wait for it to finish");
    }
    directivePasses.add(docPath);
    resolveDirectivesBtn.disabled = true;
    // Pulse the markers immediately. The Agents panel gets one task per marker from the backend.
    setPulse(true);
    const outcome = await runStreamingTurn({
      run: async () => {
        await deps.syncDocToDisk(); // ensure just-typed [[ … ]] directives are on disk for the backend
        return deps.api.resolveDirectives(
          { docPath },
          // Proposal events render the edit inline (markdown decoration or HTML overlay);
          // tokens are ignored here since the outcome is reported in the result. Only
          // into this pass's own document: elsewhere they're pending on disk.
          (e) => {
            if (onScreen(docPath)) void deps.routeProposal(e);
          },
        );
      },
      onError: (e) => reportError("resolve directives", e, deps.log),
      onSettled: () => {
        directivePasses.delete(docPath);
        if (!onScreen(docPath)) return;
        void deps.agents.refreshAgents();
        resolveDirectivesBtn.disabled = false;
        setPulse(false);
      },
    });
    if (!outcome.ok || !onScreen(docPath)) return;
    const res = outcome.result;
    if (res.count === 0) {
      deps.showDirectiveResult("No [[ … ]] directives found in the document.", "");
      deps.log("no [[ … ]] directives found");
    } else if (res.applied > 0) {
      deps.log(`resolved ${res.count} directive(s) — ${res.applied} applied directly (Editing mode)`);
    } else if (res.proposed) {
      deps.log(`resolving ${res.count} directive(s) — review the proposed edit in the document`);
    } else {
      // The agent responded but proposed no edit (e.g. it couldn't fulfill the directive).
      // Surface its reply so the action isn't a silent no-op. Exactly one directive means
      // this summary IS that one thread ("directive-1") — since res.proposed is false here,
      // that single directive is the one that didn't propose, so it's a real reply target.
      deps.showDirectiveResult(
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

  /**
   * The active document changed (tab switch, close) or was reloaded. Show the passes'
   * state for the document now on screen: another document's review form and result
   * must not linger in the rail (a reload of the same document keeps them), a pass
   * running elsewhere must not keep this document's buttons disabled or its chips
   * pulsing, and a pass running on THIS document shows as running.
   */
  function reset(): void {
    const docPath = deps.getDocPath();
    statusClock?.stop();
    statusClock = null;
    if (reviewAreaDoc !== docPath) {
      reviewForm.hidden = true;
      reviewStatusEl.hidden = true;
      reviewStatusEl.textContent = "";
      reviewAreaDoc = undefined;
    }
    const review = docPath ? reviews.get(docPath) : undefined;
    reviewRunEl.disabled = !!review;
    if (review) showReviewRun(review);
    const directives = !!docPath && directivePasses.has(docPath);
    resolveDirectivesBtn.disabled = directives;
    setPulse(directives);
  }

  return { runReview, runResolveDirectives, handleResolveShortcut, reset };
}
