// The Improve flow: ask the agent to rewrite a comment's highlighted passage, stream the
// rewrite into a review box in the chat pane, and apply it — on the reviewer's click in
// Suggesting mode, or already applied by the sidecar in Editing mode. Shared by the chat
// footer's Improve button and the selection popover's Improve quick action. Split out of
// chat.ts; reaches the pane only through `deps`.
import type { RpcEvent } from "@ai-native-doc/docd/protocol";
import type { DocdApi } from "./session.js";
import type { HtmlSnippetPreviewContext } from "./html-snippet-preview.js";
import { alreadyResolvedStatus, reportError, runStreamingTurn } from "./ui.js";
import { startWaitStatus } from "./wait-status.js";

export interface ImproveDeps {
  api: DocdApi;
  log: (line: string) => void;
  getDocPath: () => string | undefined;
  getFormat: () => "markdown" | "html";
  renderPreviewText: (into: HTMLElement, text: string, context?: HtmlSnippetPreviewContext | null) => void;
  rawPreviewText: (from: HTMLElement) => string;
  routeProposal: (e: RpcEvent) => boolean;
  reloadActiveDoc: () => Promise<void>;
  /** The highlighted passage of a comment thread (shown as the "before" text). */
  commentQuoted: (id: string) => string | undefined;
  /** One agent turn per thread: see chat.ts's beginExclusiveTurn/endExclusiveTurn. */
  beginExclusiveTurn: (threadId: string, label: string) => boolean;
  endExclusiveTurn: (threadId: string, drain: boolean) => void;
  setChatBusy: (threadId: string | null) => void;
  /** Re-derive the footer's Resolve/Improve button labels from the active thread. */
  updateChatActions: () => void;
}

export interface ImproveApi {
  runImprove: (id: string) => Promise<void>;
}

export function initImprove(deps: ImproveDeps): ImproveApi {
  const chatTurnsEl = document.querySelector<HTMLDivElement>("#chatTurns")!;
  const chatEmptyEl = document.querySelector<HTMLDivElement>("#chatEmpty")!;
  const chatImproveEl = document.querySelector<HTMLButtonElement>("#chatImprove")!;

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
    if (!deps.beginExclusiveTurn(id, "improve")) return;
    chatImproveEl.disabled = true;
    chatImproveEl.textContent = "Improving...";
    // One live improve proposal at a time — drop any stale box (e.g. from a prior
    // Improve click on this pane) so rewrites don't stack on top of each other.
    chatTurnsEl.querySelectorAll(".proposal").forEach((node) => node.remove());
    const box = document.createElement("div");
    box.className = "proposal working";
    box.innerHTML = `<div class="ptitle">Proposed rewrite</div>
      <div class="pold"></div><div class="pnew"></div>
      <div class="pacts"><button class="papply" disabled>Apply and version</button><button class="preject">Reject</button></div>`;
    box.querySelector<HTMLDivElement>(".pold")!.textContent = deps.commentQuoted(id) ?? "";
    const pnew = box.querySelector<HTMLDivElement>(".pnew")!;
    pnew.classList.add("pending");
    const status = startWaitStatus(pnew, "Waiting for the model…");
    const applyBtn = box.querySelector<HTMLButtonElement>(".papply")!;
    box.querySelector<HTMLButtonElement>(".preject")!.addEventListener("click", () => box.remove());
    chatEmptyEl.hidden = true;
    chatTurnsEl.appendChild(box);
    chatTurnsEl.scrollTop = chatTurnsEl.scrollHeight;

    deps.setChatBusy(id); // show Stop; cancelKey for improve is docPath#<id>
    let sawToken = false;
    let sawProposal = false;
    let proposedText = "";
    const outcome = await runStreamingTurn({
      run: () =>
        deps.api.improve(
          { threadId: id },
          (e) => {
            if (e.event === "applied") {
              deps.routeProposal(e); // Editing mode: already applied — reload, no review card
              return;
            }
            if (deps.routeProposal(e)) {
              status.stop();
              sawProposal = true;
              pnew.classList.remove("pending");
              pnew.textContent = "Review the proposed edit in the document.";
              return;
            }
            if (e.event === "thinking") status.set("The agent is thinking…");
            else if (e.event === "tool") status.set("The agent is using a tool…");
            if (e.event === "token") {
              status.stop();
              if (!sawToken) {
                pnew.textContent = "";
                pnew.classList.remove("pending");
                sawToken = true;
              }
              proposedText += String(e.data);
              // Plain text while streaming; the HTML-aware preview (which builds a
              // sandboxed iframe) is rendered once, after the stream settles.
              pnew.textContent = proposedText;
              chatTurnsEl.scrollTop = chatTurnsEl.scrollHeight;
            }
          },
        ),
      onError: (e) => {
        status.stop();
        pnew.classList.remove("pending");
        pnew.textContent = `⚠ ${String(e)}`;
        chatImproveEl.disabled = false;
        deps.updateChatActions();
      },
      onSettled: () => {
        status.stop();
        box.classList.remove("working");
        deps.setChatBusy(null);
        // Improve adds no conversation turn, so queued messages can go either way.
        deps.endExclusiveTurn(id, true);
      },
    });
    if (!outcome.ok) return;
    const result = outcome.result;
    const proposalId = result.proposalId;
    if (result.applied) {
      // Editing mode: the rewrite is already in the document (and versioned). Show what
      // was applied; there is nothing to approve.
      box.querySelector<HTMLDivElement>(".ptitle")!.textContent = "Applied rewrite";
      pnew.classList.remove("pending");
      if (deps.getFormat() === "html") pnew.textContent = "The edit was applied to the document.";
      else deps.renderPreviewText(pnew, result.newText);
      applyBtn.remove();
      box.querySelector<HTMLButtonElement>(".preject")!.textContent = "Dismiss";
      deps.log(`applied rewrite to ${id} (Editing mode)`);
      chatImproveEl.disabled = false;
      deps.updateChatActions();
      return;
    }
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
    deps.updateChatActions();
  }

  return { runImprove };
}
