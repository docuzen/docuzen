// Agent-edit proposal rendering + review: the inline (markdown) proposal widgets,
// the HTML-surface overlay proposal card, and the full-rewrite side-by-side diff
// panel.
//
// Wiring pattern: initProposals(deps) queries this module's own DOM elements (the
// diff panel) and returns the external surface other regions call: `routeProposal`
// (every streaming onEvent — chat send, card discuss, brainstorm — routes a
// "proposal" event here before it reaches the chat bubble), `renderProposal`/
// `renderProposalHtml` (also called directly by shell.ts's `activateTab` and
// surface.ts's `onHtmlReady` to re-render PENDING proposals on load), `openDiffPanel`
// (same two callers, for pending full-rewrite proposals), `buildProposalWidget`/
// `buildProposalAddOnly`/`buildProposalFallbackWidget` (consumed by editor.ts's
// proposal-decoration plugin, via main.ts's EditorDeps — unchanged interface, see
// editor.ts), and `diffPanel` itself (main.ts's shared Escape-key handler also
// closes it — the `shell.versionModal` precedent from Task 2).
//
// `proposalKey` (editor.ts's singleton proposal-decoration PluginKey) and
// `findDirectiveOffsets` (editor.ts's [[ ... ]] offset finder) cross into this
// module WITHOUT an editor.ts import, per the plan's "modules never import each
// other" rule — same `searchKey`-by-value precedent surface.ts already set for its
// wave-1 search plugin key. `ProposalView` (this module's own type) is likewise
// NOT exported for cross-module type reuse: shell.ts and surface.ts each redeclare
// the same 6-field shape locally where they need to construct one (mirrors the
// `SearchMeta`/`escapeHtml` precedents from Task 2's report) so this module stays
// import-free of them and vice versa.
//
// `renderPreviewText` (HTML-preview-aware text rendering, shared with chat.ts's
// turn/improve rendering) stays main.ts-owned — see main.ts's header — reached via
// `deps.renderPreviewText`.
//
// The diff panel's lines come straight from `diffLines(before, after)` (the `diff`
// package docd's `diffToHunks` is built on): one pane line per diff part, positioned by
// the diff itself. It briefly rebuilt them from `diffToHunks`' position-less hunks by
// searching for each hunk's text, which put a deleted line that repeats an earlier one
// (a duplicated line, a blank line) at the earlier copy — see
// diff-panel-equivalence.test.ts.
//
// Every proposal belongs to the document it was shown for: approve/reject name that
// document, and the follow-up reload (or card cleanup) only happens while it is still
// the one on screen, so a tab switch during the round-trip can't reload — and discard
// the unsaved edits of — another document.

import type { Editor } from "@milkdown/kit/core";
import { editorViewCtx } from "@milkdown/kit/core";
import type { EditorView } from "@milkdown/kit/prose/view";
import type { PluginKey } from "@milkdown/kit/prose/state";
import { diffLines } from "diff";
import type { EditHunk } from "@ai-native-doc/docd/protocol";
import type { RpcEvent } from "./rpc.js";
import { projectionOf, posRangeForOffsets } from "./anchor-map.js";
import { projectionNeedlesForHtmlHunk, projectionNeedlesForHunk } from "./proposal-locate.js";
import { buildHtmlProjection, rangeForOffsets } from "./html-projection.js";
import { baseHrefForDoc, type HtmlSurface } from "./html-surface.js";
import { buildHtmlSnippetPreviewContext, type HtmlSnippetPreviewContext } from "./html-snippet-preview.js";
import { el, wireModal, proposalActions } from "./ui.js";
import type { DocdApi } from "./session.js";

/** A streamed/loaded proposal, ready to render as an inline multi-hunk diff. */
export interface ProposalView {
  id: string;
  threadId: string;
  rationale: string;
  // Each edit replaces an existing passage (`oldText`) with `newText`. Located by
  // text match in the projection; a hunk whose `oldText` isn't found is skipped.
  edits: EditHunk[];
  // Present ONLY for full-document rewrites; absent for targeted hunks. When set,
  // the proposal is routed to the diff panel (handled elsewhere), not inline.
  fullText?: string;
  status?: string;
}

export interface ProposalsDeps {
  api: DocdApi;
  log: (line: string) => void;
  getDocPath: () => string | undefined;
  getFormat: () => "markdown" | "html";
  getEditor: () => Editor | null;
  getHtmlSurface: () => HtmlSurface | null;
  /** Still main.ts-owned — see file header. */
  renderPreviewText: (into: HTMLElement, text: string, context?: HtmlSnippetPreviewContext | null) => void;
  reloadActiveDoc: () => Promise<void>;
  chatTurn: (role: "system", text: string) => HTMLDivElement;
  chatTurnWithAction: (label: string, onClick: () => void) => void;
  getCommentQuoted: (id: string) => string | undefined;
  /** editor.ts's singleton proposal-decoration PluginKey — passed by value (see file header). */
  proposalKey: PluginKey;
  /** editor.ts's [[ ... ]] offset finder — passed by value (see file header). */
  findDirectiveOffsets: (text: string) => { start: number; end: number }[];
}

export interface ProposalsApi {
  routeProposal(e: RpcEvent): boolean;
  renderProposal(p: ProposalView): void;
  renderProposalHtml(p: ProposalView): void;
  clearProposal(id: string): void;
  buildProposalWidget(p: { id: string; threadId: string; newText: string; rationale: string; count?: number }): HTMLElement;
  buildProposalAddOnly(newText: string): HTMLElement;
  buildProposalFallbackWidget(p: {
    id: string;
    threadId: string;
    rationale: string;
    edits: { oldText: string; newText: string }[];
    located: number;
  }): HTMLElement;
  openDiffPanel(p: ProposalView): Promise<void>;
  /** Close the full-rewrite panel (the active document changed: it showed the previous one's rewrite). */
  closeDiffPanel(): void;
  /** Exposed only so main.ts's shared Escape-key handler can also close it (see file header). */
  diffPanel: HTMLDivElement;
}

interface DiffPaneLine {
  cls: "diff-ctx" | "diff-del" | "diff-add";
  value: string;
}

/**
 * The two diff panes' line entries: one per `diffLines(before, after)` part — removed
 * parts on the left, added on the right, unchanged parts as context in both. Exported
 * so diff-panel-equivalence.test.ts can check it on fixture texts.
 */
export function buildDiffPaneLines(before: string, after: string): { before: DiffPaneLine[]; after: DiffPaneLine[] } {
  const beforeLines: DiffPaneLine[] = [];
  const afterLines: DiffPaneLine[] = [];
  for (const part of diffLines(before, after)) {
    if (part.removed) beforeLines.push({ cls: "diff-del", value: part.value });
    else if (part.added) afterLines.push({ cls: "diff-add", value: part.value });
    else {
      beforeLines.push({ cls: "diff-ctx", value: part.value });
      afterLines.push({ cls: "diff-ctx", value: part.value });
    }
  }
  return { before: beforeLines, after: afterLines };
}

/** Inline (phrasing) elements a block-level review card must not be put inside. */
const INLINE_TAGS = new Set([
  "A", "ABBR", "B", "BDI", "BDO", "CITE", "CODE", "DATA", "DEL", "DFN", "EM", "FONT", "I", "INS",
  "KBD", "LABEL", "MARK", "Q", "S", "SAMP", "SMALL", "SPAN", "STRONG", "SUB", "SUP", "TIME", "U", "VAR",
]);

/**
 * Put an HTML review card at the end of `range`, but never inside a link or an
 * annotation mark (their click handlers — open the link, open the annotation menu —
 * would get the card's clicks) nor inside inline formatting: it goes right after the
 * outermost such element instead.
 */
function insertCardAt(range: Range, card: HTMLElement): void {
  const end = range.endContainer;
  const start = end.nodeType === Node.ELEMENT_NODE ? (end as Element) : end.parentElement;
  let after: Element | null = null;
  for (let el = start?.closest("a, .had-mark") ?? null; el; el = el.parentElement?.closest("a, .had-mark") ?? null) after = el;
  for (let el = after ?? start; el && INLINE_TAGS.has(el.tagName); el = el.parentElement) after = el;
  if (after) {
    after.after(card);
    return;
  }
  range.collapse(false);
  range.insertNode(card);
}

export function initProposals(deps: ProposalsDeps): ProposalsApi {
  /** `docPath` is still the document on screen. */
  const showing = (docPath: string | undefined): boolean => !!docPath && deps.getDocPath() === docPath;
  /** After approving a proposal of `docPath`: show the applied change — if that document is still on screen. */
  async function reloadIfShowing(docPath: string | undefined): Promise<void> {
    if (showing(docPath)) await deps.reloadActiveDoc();
  }

  /** Remove a proposal's inline diff decorations (strike + widget) from the editor. */
  function clearProposal(id: string): void {
    deps.getEditor()?.action((ctx) => {
      const view: EditorView = ctx.get(editorViewCtx);
      view.dispatch(view.state.tr.setMeta(deps.proposalKey, { remove: id }));
    });
  }

  /**
   * Build the inline widget DOM for a proposal: a non-editable card showing the
   * proposed new text (green) + optional rationale + Approve/Reject buttons. HTML
   * snippets render in a sandboxed preview; raw text remains available as fallback.
   * contentEditable=false so ProseMirror treats it as an atom and never tries to edit it.
   */
  function buildProposalWidget(p: {
    id: string;
    threadId: string;
    newText: string;
    rationale: string;
    count?: number;
  }): HTMLElement {
    const docPath = deps.getDocPath();
    const box = el("div", { className: "proposal-inline", contentEditable: "false" });

    const n = p.count ?? 1;
    const label = el("div", { className: "plabel", textContent: `Proposed edit (${n} change${n === 1 ? "" : "s"})` });
    box.appendChild(label);

    const add = el("div", { className: "proposed-add" });
    deps.renderPreviewText(add, p.newText);
    box.appendChild(add);

    if (p.rationale) {
      // agent text — textContent
      const why = el("div", { className: "prationale", textContent: p.rationale });
      box.appendChild(why);
    }

    const acts = el("div", { className: "pacts" });

    const approve = el("button", { className: "approve", textContent: "Approve" });
    approve.addEventListener("mousedown", (e) => e.preventDefault());

    const reject = el("button", { className: "reject", textContent: "Reject" });
    reject.addEventListener("mousedown", (e) => e.preventDefault());

    proposalActions(
      {
        approveBtn: approve,
        rejectBtn: reject,
        approveProposal: (ids) => deps.api.approveProposal(ids),
        rejectProposal: (ids) => deps.api.rejectProposal(ids),
        log: deps.log,
        guard: () => !!docPath,
        // Embedded in a contentEditable ProseMirror node — without this, the
        // browser's own mousedown/click handling would fight the editor for
        // focus/selection before our handler runs.
        onClick: (e) => {
          e.preventDefault();
          e.stopPropagation();
        },
        // Both buttons disable together (proposalActions' default): one answer per proposal.
        onApproved: async () => {
          if (showing(docPath)) clearProposal(p.id);
          await reloadIfShowing(docPath); // shows the applied change; pending re-render excludes it
          deps.log("proposal approved — applied to the document");
        },
        onRejected: () => {
          if (showing(docPath)) clearProposal(p.id);
          deps.log("rejected — the agent will be told on your next message");
        },
      },
      { threadId: p.threadId, proposalId: p.id, docPath },
    );

    acts.appendChild(approve);
    acts.appendChild(reject);
    box.appendChild(acts);
    return box;
  }

  /**
   * Green-only add widget for a non-first hunk: a non-editable block showing just
   * the proposed new text (the shared Approve/Reject card lives on the first hunk).
   * HTML snippets render in a sandboxed preview; contentEditable=false so ProseMirror
   * treats it as an atom and never tries to edit it.
   */
  function buildProposalAddOnly(newText: string): HTMLElement {
    const add = el("div", { className: "proposed-add", contentEditable: "false" });
    deps.renderPreviewText(add, newText);
    return add;
  }

  /** Build a document-anchored fallback when a proposal cannot be struck inline. */
  function buildProposalFallbackWidget(p: {
    id: string;
    threadId: string;
    rationale: string;
    edits: { oldText: string; newText: string }[];
    located: number;
  }): HTMLElement {
    const docPath = deps.getDocPath();
    const box = el("div", { className: "proposal-inline proposal-anchor-fallback", contentEditable: "false" });

    const title = el("div", { className: "plabel", textContent: "Review proposal" });
    box.appendChild(title);

    const note = el("div", {
      className: "prationale",
      textContent:
        p.located === 0
          ? "Could not place this edit inline in the rendered document. You can still approve it if the source text has not changed, or reject it and ask the agent to try again."
          : `Placed ${p.located} of ${p.edits.length} changes inline. Approve applies the whole proposal after backend validation.`,
    });
    box.appendChild(note);

    for (const edit of p.edits.slice(0, 3)) {
      const oldEl = el("div", { className: "proposed-old", textContent: edit.oldText });
      const newEl = el("div", { className: "proposed-add" });
      deps.renderPreviewText(newEl, edit.newText);
      box.append(oldEl, newEl);
    }
    if (p.edits.length > 3) {
      const more = el("div", {
        className: "prationale",
        textContent: `Plus ${p.edits.length - 3} more change${p.edits.length - 3 === 1 ? "" : "s"}.`,
      });
      box.appendChild(more);
    }

    const acts = el("div", { className: "pacts" });
    const approve = el("button", { className: "papply", textContent: "Approve and version" });
    approve.addEventListener("mousedown", (e) => e.preventDefault());

    const reject = el("button", { className: "preject", textContent: "Reject" });
    reject.addEventListener("mousedown", (e) => e.preventDefault());

    proposalActions(
      {
        approveBtn: approve,
        rejectBtn: reject,
        approveProposal: (ids) => deps.api.approveProposal(ids),
        rejectProposal: (ids) => deps.api.rejectProposal(ids),
        log: deps.log,
        guard: () => !!docPath,
        onApproved: async () => {
          box.remove();
          if (showing(docPath)) clearProposal(p.id);
          await reloadIfShowing(docPath);
          deps.log("proposal approved — applied to the document");
        },
        onRejected: () => {
          box.remove();
          if (showing(docPath)) clearProposal(p.id);
          deps.log("rejected — the agent will be told on your next message");
        },
      },
      { threadId: p.threadId, proposalId: p.id, docPath },
    );

    acts.append(approve, reject);
    box.appendChild(acts);
    return box;
  }

  /**
   * Place a proposal's inline diff. For each edit with non-empty `oldText`, locate
   * it in the projection (scanning forward from a cursor so distinct identical hunks
   * don't collide on the first occurrence) → offsets → posRange. Dispatch ONE
   * proposalKey "add" meta carrying all located hunks. If some hunks can't be
   * located, attach a fallback review card to the highlighted passage so proposal
   * review still happens in the document instead of the chat pane.
   */
  function renderProposal(p: ProposalView): void {
    deps.getEditor()?.action((ctx) => {
      const view: EditorView = ctx.get(editorViewCtx);
      const proj = projectionOf(view);
      const hunks: { from: number; to: number; newText: string }[] = [];
      let cursor = 0; // forward scan position so distinct identical hunks don't collide
      let located = 0;
      for (const edit of p.edits) {
        if (!edit.oldText) continue; // nothing to strike (pure insert) — skip for v1
        let start = -1;
        let matched = "";
        for (const needle of projectionNeedlesForHunk(edit.oldText)) {
          const at = proj.text.indexOf(needle, cursor);
          if (at >= 0) {
            start = at;
            matched = needle;
            break;
          }
        }
        if (start < 0) continue; // unlocated — counted via located < edits.length below
        const range = posRangeForOffsets(proj, start, start + matched.length);
        if (!range) continue;
        hunks.push({ from: range.from, to: range.to, newText: edit.newText });
        cursor = start + matched.length; // advance past this match
        located++;
      }
      if (hunks.length) {
        view.dispatch(
          view.state.tr.setMeta(deps.proposalKey, {
            id: p.id,
            threadId: p.threadId,
            rationale: p.rationale,
            hunks,
          }),
        );
      }
      if (located < p.edits.length) {
        let fallbackAt = view.state.doc.content.size;
        const quoted = deps.getCommentQuoted(p.threadId);
        if (quoted) {
          for (const needle of projectionNeedlesForHunk(quoted)) {
            const at = proj.text.indexOf(needle);
            if (at < 0) continue;
            const range = posRangeForOffsets(proj, at, at + needle.length);
            if (range) {
              fallbackAt = range.to;
              break;
            }
          }
        }
        const directiveN = /^directive-(\d+)$/.exec(p.threadId);
        if (fallbackAt === view.state.doc.content.size && directiveN) {
          // directive-N is the N-th `[[ … ]]` in document order (1-based).
          const directive = deps.findDirectiveOffsets(proj.text)[Number(directiveN[1]) - 1];
          if (directive) {
            const range = posRangeForOffsets(proj, directive.start, directive.end);
            if (range) fallbackAt = range.to;
          }
        }
        view.dispatch(
          view.state.tr.setMeta(deps.proposalKey, {
            id: p.id,
            threadId: p.threadId,
            rationale: p.rationale,
            hunks: [],
            fallback: { at: fallbackAt, edits: p.edits, located },
          }),
        );
        deps.chatTurn(
          "system",
          located === 0
            ? "Proposal review is attached to the highlighted passage in the document."
            : `Showing ${located} of ${p.edits.length} change${p.edits.length === 1 ? "" : "s"} inline. The full proposal is also attached to the highlighted passage.`,
        );
      }
    });
  }

  /** Remove a proposal's overlay card from the iframe. */
  function clearHtmlProposal(id: string): void {
    const doc = deps.getHtmlSurface()?.doc;
    doc?.querySelectorAll(`[data-had-proposal="${CSS.escape(id)}"]`).forEach((n) => n.remove());
  }

  /** Build the in-iframe proposal review card (old→new preview + Approve/Reject). */
  function buildHtmlProposalCard(doc: Document, p: ProposalView, located: number): HTMLElement {
    const docPath = deps.getDocPath();
    const box = doc.createElement("div");
    box.setAttribute("data-had-overlay", ""); // stripped on serialize + skipped by projection
    box.setAttribute("data-had-proposal", p.id);
    box.contentEditable = "false";
    // The card's own clicks are its own: never the document's link or mark handlers'.
    box.addEventListener("click", (e) => e.stopPropagation());
    box.style.cssText =
      "display:block;margin:8px 0;border:1px solid #bfe6c8;background:#f3fbf5;border-radius:8px;" +
      "padding:8px 10px;font:13px/1.45 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#15301f;";

    const label = doc.createElement("div");
    const n = p.edits.length;
    label.textContent =
      located < n
        ? `Proposed edit (${n} change${n === 1 ? "" : "s"}; ${located} located here)`
        : `Proposed edit (${n} change${n === 1 ? "" : "s"})`;
    label.style.cssText = "font-weight:700;color:#1f7a37;margin-bottom:4px;";
    box.appendChild(label);

    const previewContext = buildHtmlSnippetPreviewContext(doc, docPath ? baseHrefForDoc(docPath) : undefined);
    for (const e of p.edits.slice(0, 3)) {
      if (e.oldText) {
        const o = doc.createElement("div");
        o.textContent = e.oldText;
        o.style.cssText =
          "background:#ffe9e5;color:#7c2c22;text-decoration:line-through;border-radius:4px;padding:3px 6px;margin:2px 0;white-space:pre-wrap;";
        box.appendChild(o);
      }
      const nw = doc.createElement("div");
      nw.style.cssText =
        "background:#dcf5e1;color:#15622b;border-radius:4px;padding:3px 6px;margin:2px 0;white-space:pre-wrap;";
      deps.renderPreviewText(nw, e.newText, previewContext);
      box.appendChild(nw);
    }
    if (p.rationale) {
      const why = doc.createElement("div");
      why.textContent = p.rationale;
      why.style.cssText = "color:#6b6b80;font-size:12px;margin:4px 0;";
      box.appendChild(why);
    }

    const acts = doc.createElement("div");
    acts.style.cssText = "display:flex;gap:6px;margin-top:4px;";
    const approve = doc.createElement("button");
    approve.textContent = "Approve and version";
    approve.style.cssText =
      "border:1px solid #bfe6c8;background:#eef9f0;color:#1f7a37;border-radius:6px;padding:3px 9px;cursor:pointer;font-weight:700;";
    const reject = doc.createElement("button");
    reject.textContent = "Reject";
    reject.style.cssText =
      "border:1px solid #f1c9c2;background:#fff7f5;color:#9a3429;border-radius:6px;padding:3px 9px;cursor:pointer;";
    proposalActions(
      {
        approveBtn: approve,
        rejectBtn: reject,
        approveProposal: (ids) => deps.api.approveProposal(ids),
        rejectProposal: (ids) => deps.api.rejectProposal(ids),
        log: deps.log,
        guard: () => !!docPath,
        onApproved: async () => {
          deps.log("proposal approved — applied to the document");
          await reloadIfShowing(docPath); // re-renders the iframe from disk with the edit applied
        },
        onRejected: () => {
          if (showing(docPath)) clearHtmlProposal(p.id);
          deps.log("rejected — the agent will be told on your next message");
        },
      },
      { threadId: p.threadId, proposalId: p.id, docPath },
    );
    acts.append(approve, reject);
    box.appendChild(acts);
    return box;
  }

  /**
   * Render a targeted-hunk proposal as an overlay card in the iframe, anchored just
   * after the located passage (or the thread's comment anchor, else end of doc). The
   * card is review-only and stripped on serialize; Approve applies on the backend and
   * reloads the iframe. Full-rewrite proposals route to the shared diff panel instead.
   */
  function renderProposalHtml(p: ProposalView): void {
    const doc = deps.getHtmlSurface()?.doc;
    if (!doc || !doc.body) return;
    clearHtmlProposal(p.id);
    const proj = buildHtmlProjection(doc.body);
    let anchorEnd = -1;
    let located = 0;
    for (const edit of p.edits) {
      if (!edit.oldText) continue;
      for (const needle of projectionNeedlesForHtmlHunk(edit.oldText)) {
        const at = proj.text.indexOf(needle);
        if (at >= 0) {
          located++;
          if (anchorEnd < 0) anchorEnd = at + needle.length;
          break;
        }
      }
    }
    if (anchorEnd < 0) {
      const quoted = deps.getCommentQuoted(p.threadId);
      if (quoted) {
        for (const needle of projectionNeedlesForHunk(quoted)) {
          const at = proj.text.indexOf(needle);
          if (at >= 0) {
            anchorEnd = at + needle.length;
            break;
          }
        }
      }
    }
    const card = buildHtmlProposalCard(doc, p, located);
    const range = anchorEnd > 0 ? rangeForOffsets(doc, proj, Math.max(0, anchorEnd - 1), anchorEnd) : null;
    if (range) insertCardAt(range, card);
    else doc.body.appendChild(card);
  }

  /**
   * Route a "proposal" streaming event to the inline renderer. Returns true if the
   * event was a proposal (so callers can `return` before routing it to the chat
   * bubble — the proposal JSON must NOT be dumped as tokens). Shared by every
   * streaming onEvent (chat send, card discuss, brainstorm).
   */
  // Editing mode: the sidecar applied an edit on its own. Several can land close together
  // (parallel directives, a batch of review findings), so the reload is coalesced.
  // The reload is for the document the edit was applied to: if the user has switched
  // away by the time it fires, it is dropped (that document is re-read when reopened).
  let appliedReload: ReturnType<typeof setTimeout> | null = null;
  function scheduleAppliedReload(): void {
    const docPath = deps.getDocPath();
    if (appliedReload) clearTimeout(appliedReload);
    appliedReload = setTimeout(() => {
      appliedReload = null;
      if (showing(docPath)) void deps.reloadActiveDoc();
    }, 150);
  }

  function routeProposal(e: RpcEvent): boolean {
    if (e.event === "applied") {
      deps.chatTurn("system", "Applied an edit to the document (Editing mode). Undo it from File ▸ Save ▸ Versions.");
      deps.log("agent edit applied — reloading");
      scheduleAppliedReload();
      return true;
    }
    if (e.event !== "proposal") return false;
    try {
      const pr = JSON.parse(String(e.data)) as ProposalView & { applyError?: string };
      if (pr.applyError) {
        // Editing mode refused to apply this one (its text changed, or it was a stale
        // full rewrite) — it falls back to an ordinary proposal for review.
        deps.chatTurn("system", `Couldn't apply this edit directly (${pr.applyError}). Review it instead.`);
      }
      if (pr.fullText !== undefined) {
        // Full-document rewrite: open the side-by-side diff panel (a whole-doc inline
        // strike would be unusable). The panel re-fetches the current doc to diff.
        deps.chatTurn("system", "Proposed a full rewrite. Review it in the diff panel.");
        void openDiffPanel(pr);
        return true;
      }
      if (deps.getFormat() === "html") renderProposalHtml(pr);
      else renderProposal(pr);
      deps.chatTurn("system", "Proposed an inline edit. Review it in the document.");
    } catch {
      // malformed proposal payload — swallow rather than crash the stream
    }
    return true;
  }

  // --- full-rewrite diff panel (side-by-side current | proposed) ---
  const diffPanel = document.querySelector<HTMLDivElement>("#diffPanel")!;
  const diffWhyEl = diffPanel.querySelector<HTMLSpanElement>(".diffwhy")!;
  const diffBeforeEl = diffPanel.querySelector<HTMLDivElement>(".diffpane.before")!;
  const diffAfterEl = diffPanel.querySelector<HTMLDivElement>(".diffpane.after")!;
  const diffApproveBtn = diffPanel.querySelector<HTMLButtonElement>(".diffapprove")!;
  const diffRejectBtn = diffPanel.querySelector<HTMLButtonElement>(".diffreject")!;
  const diffCloseBtn = diffPanel.querySelector<HTMLButtonElement>(".diffclose")!;

  /** Append one pane line as a div; value is agent text → textContent only. */
  function appendDiffLine(pane: HTMLDivElement, cls: string, value: string): void {
    // Not el()'s textContent prop: `node.textContent = ""` leaves no child text node, but the
    // pre-refactor code always appended one via createTextNode (even for value === "") — matched
    // here explicitly so the child structure is byte-for-byte identical for empty diff lines.
    pane.appendChild(el("div", { className: cls }, [document.createTextNode(value)])); // agent text — never innerHTML
  }

  // Scroll-sync guard: while we mirror one pane's scroll onto the other, the mirror
  // fires the other pane's scroll handler — this flag suppresses that echo so the two
  // listeners can't ping-pong into an infinite loop.
  let diffSyncing = false;
  function syncDiffScroll(from: HTMLDivElement, to: HTMLDivElement): void {
    if (diffSyncing) return;
    diffSyncing = true;
    to.scrollTop = from.scrollTop;
    diffSyncing = false;
  }
  diffBeforeEl.addEventListener("scroll", () => syncDiffScroll(diffBeforeEl, diffAfterEl));
  diffAfterEl.addEventListener("scroll", () => syncDiffScroll(diffAfterEl, diffBeforeEl));

  function closeDiffPanel(): void {
    diffPanel.hidden = true;
  }
  diffCloseBtn.addEventListener("click", closeDiffPanel);
  wireModal(diffPanel); // click backdrop to close (proposal stays pending); closeDiffPanel() is just `diffPanel.hidden = true`

  /**
   * Open the side-by-side diff panel for a full-rewrite proposal. The left pane shows
   * the current doc body (lines removed by the rewrite tinted red + struck), the right
   * shows the proposed body (added lines tinted green); unchanged lines are context in
   * both. Approve applies on the backend (which uses fullText verbatim) and reloads;
   * Reject defers; Close leaves the proposal pending and re-openable.
   */
  let diffGen = 0;
  async function openDiffPanel(p: ProposalView): Promise<void> {
    const docPath = deps.getDocPath();
    if (!docPath || p.fullText === undefined) return;
    const gen = ++diffGen;
    let before: string;
    try {
      before = (await deps.api.openDoc({ docPath })).text;
    } catch (e) {
      deps.log(`diff panel: could not load current doc — ${String(e)}`);
      return;
    }
    // A newer panel was asked for, or the user switched documents while this one loaded.
    if (gen !== diffGen || !showing(docPath)) return;
    const after = p.fullText;

    diffWhyEl.textContent = p.rationale; // agent text — textContent
    diffBeforeEl.replaceChildren();
    diffAfterEl.replaceChildren();
    const panes = buildDiffPaneLines(before, after);
    for (const line of panes.before) appendDiffLine(diffBeforeEl, line.cls, line.value);
    for (const line of panes.after) appendDiffLine(diffAfterEl, line.cls, line.value);
    diffBeforeEl.scrollTop = 0;
    diffAfterEl.scrollTop = 0;

    // Fresh open: both actions are live again (a prior in-flight action may have left one disabled).
    diffApproveBtn.disabled = false;
    diffRejectBtn.disabled = false;
    proposalActions(
      {
        approveBtn: diffApproveBtn,
        rejectBtn: diffRejectBtn,
        approveProposal: (ids) => deps.api.approveProposal(ids),
        rejectProposal: (ids) => deps.api.rejectProposal(ids),
        log: deps.log,
        onApproved: async () => {
          closeDiffPanel();
          await reloadIfShowing(docPath);
          deps.log("rewrite approved — applied to the document");
        },
        onRejected: () => {
          closeDiffPanel();
          deps.log("rewrite rejected — the agent will be told on your next message");
        },
      },
      { threadId: p.threadId, proposalId: p.id, docPath },
    );

    diffPanel.hidden = false;
  }

  return {
    routeProposal,
    renderProposal,
    renderProposalHtml,
    clearProposal,
    buildProposalWidget,
    buildProposalAddOnly,
    buildProposalFallbackWidget,
    openDiffPanel,
    closeDiffPanel: () => {
      diffGen++; // a panel still loading must not open over the next document either
      closeDiffPanel();
    },
    diffPanel,
  };
}
