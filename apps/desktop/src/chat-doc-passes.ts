// The two document-wide agent passes and their controls: the Review pass (Review rail
// button + form) and the inline-directive pass (Resolve [[ ]] button, ⌘⇧D). Each runs
// one RPC over the whole document; results land through the normal load path (findings
// become comment cards, edits become proposals or — in Editing mode — applied edits).
// Split out of chat.ts; reaches the chat pane only through `deps`.
import type { RpcEvent } from "@ai-native-doc/docd/protocol";
import type { DocdApi } from "./session.js";
import type { AgentsPanelApi } from "./chat-agents-panel.js";
import { reportError, runStreamingTurn } from "./ui.js";
import { startWaitStatus } from "./wait-status.js";

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
  agents: Pick<AgentsPanelApi, "setOptimisticTask" | "clearOptimisticTask" | "markStarting">;
  /** Show a directive-pass outcome banner in the chat pane (see chat.ts). */
  showDirectiveResult: (headline: string, reply: string, threadId?: string) => void;
}

export interface DocPassesApi {
  runReview: () => Promise<void>;
  runResolveDirectives: () => Promise<void>;
  handleResolveShortcut: (e: KeyboardEvent) => void;
  /** Dismiss the review form + status line (document switch). */
  reset: () => void;
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

  // --- document-wide Agent Review Pass ---
  // Runs one agent over the whole doc; each finding becomes an agent-authored comment
  // (with an optional pending proposal) that lands in the review rail via the normal
  // load path. The agent never edits the doc — edits are reviewed/approved as usual.
  reviewDocBtn.addEventListener("click", () => {
    if (!deps.getDocPath()) return void deps.log("review: open a document first");
    reviewForm.hidden = !reviewForm.hidden;
    if (!reviewForm.hidden) {
      deps.fillModelPicker(reviewModelEl);
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
    const status = startWaitStatus(reviewStatusEl, "Reviewing the document…");
    let count = 0;
    const modelId = reviewModelEl.value || undefined;
    deps.agents.setOptimisticTask("review", "running");
    deps.agents.markStarting(); // instant feedback; the poll reconciles the real count
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
            status.set(`Reviewing… ${count} finding${count === 1 ? "" : "s"} so far`);
          }
        },
      );
      status.stop();
      const n = res.findings.length;
      const appliedCount = res.findings.filter((x) => x.applied).length;
      reviewStatusEl.textContent =
        `Review complete — ${n} finding${n === 1 ? "" : "s"} added to the rail.` +
        (appliedCount ? ` ${appliedCount} edit${appliedCount === 1 ? "" : "s"} applied (Editing mode).` : "");
      deps.log(`review pass added ${n} finding(s)`);
      await deps.reloadActiveDoc(); // re-render annotations + proposals through the normal load path
    } catch (e) {
      status.stop();
      reviewStatusEl.textContent = `Review failed: ${String(e)}`;
      reportError("review", e, deps.log);
    } finally {
      deps.agents.clearOptimisticTask("review");
      reviewRunEl.disabled = false;
    }
  }
  reviewRunEl.addEventListener("click", () => void runReview());

  async function runResolveDirectives(): Promise<void> {
    if (!deps.getDocPath()) return void deps.log("directives: open a document first");
    resolveDirectivesBtn.disabled = true;
    deps.setDirectivesWorking(true); // pulse the [[ … ]] chips while the pass runs
    deps.agents.setOptimisticTask("directives", "running");
    deps.agents.markStarting(); // instant feedback; the poll reconciles the real count
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
        deps.agents.clearOptimisticTask("directives");
        resolveDirectivesBtn.disabled = false;
        deps.setDirectivesWorking(false);
      },
    });
    if (!outcome.ok) return;
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

  /** A previous document's review result must not linger in the rail after a switch. */
  function reset(): void {
    reviewForm.hidden = true;
    reviewStatusEl.hidden = true;
    reviewStatusEl.textContent = "";
  }

  return { runReview, runResolveDirectives, handleResolveShortcut, reset };
}
