import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import matter from "gray-matter";
import type { EditHunk, ProposedEdit, TokenSink } from "../agent/types.js";
import { validateHtml } from "../agent/html-validation.js";
import {
  appendProposal,
  isHtmlDoc,
  listProposals,
  readAnnotations,
  readSettings,
  updateAnnotation,
  updateProposal,
  type Proposal,
} from "../had/index.js";
import { withFileLock } from "../had/io.js";
import { createAnchor, resolveAnchor } from "../anchor/index.js";
import { diffToHunks } from "./diff.js";
import { withEditSnapshot } from "./edit-snapshot.js";

/** Stable content fingerprint for the staleness compare-and-swap on proposal approval. */
function bodyHash(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex");
}

/** The document body the agent sees and edits: frontmatter-stripped markdown, or raw HTML. */
export function documentBody(raw: string, docPath: string): string {
  return isHtmlDoc(docPath) ? raw : matter(raw).content;
}

function containsHtmlTag(text: string): boolean {
  return /<\/?[A-Za-z][^>]*>/.test(text);
}

export interface ProposalServiceDeps {
  /** Injected clock so tests are deterministic. */
  now: () => string;
}

/** What became of an edit the agent submitted. */
export interface SubmittedEdit {
  proposal: Proposal;
  /**
   * True when the document's edit mode is "direct" (Editing) and the edit was applied
   * on submission. False in "propose" (Suggesting) mode, and also when a direct apply
   * was refused — the proposal then stays pending for the reviewer, with `applyError`.
   */
  applied: boolean;
  applyError?: string;
}

/**
 * The whole lifecycle of an agent edit, in one place: submit → (review) → apply | reject.
 *
 * There is exactly ONE way a document changes on an agent's behalf — `approve()` — and
 * both edit modes go through it:
 *
 *  - Suggesting ("propose", the default): `submit` persists a pending proposal and tells
 *    the UI; the reviewer approves or rejects it.
 *  - Editing ("direct"): `submit` persists the same proposal and immediately approves it.
 *
 * So Editing mode is "auto-approve", not a second write path: the agent still has no
 * write tools, every applied edit is still a recorded proposal with a pre-apply backup
 * and an agent-edit version (undo = restore the backup), HTML is still validated, and a
 * hunk that doesn't match the current text is still refused rather than misapplied.
 */
export class ProposalService {
  constructor(private deps: ProposalServiceDeps) {}

  /**
   * Record a structured edit the agent produced on `threadId` and, in Editing mode,
   * apply it. Emits exactly one event: "applied" when it was applied, else "proposal"
   * (pending — including a direct apply that was refused, so the reviewer can still see
   * and act on it). `silent` suppresses the event for callers that announce the edit
   * themselves (a review finding rides its own "finding" event). `reviewOnly` keeps the
   * proposal pending even in Editing mode — for conversation turns, which must never
   * change the document whatever the mode and whatever the runner returned.
   */
  async submit(
    docPath: string,
    threadId: string,
    edit: ProposedEdit,
    onToken?: TokenSink,
    opts: { silent?: boolean; reviewOnly?: boolean } = {},
  ): Promise<SubmittedEdit> {
    // Normalize to display/apply hunks: targeted edits ride through verbatim; a full
    // rewrite is diffed against the CURRENT body for display, but the exact body is
    // kept in fullText so apply writes it verbatim (no diff round-trip). The body's
    // hash is the base the edit was made against: it gates approval (staleness).
    const body = documentBody(await readFile(docPath, "utf8"), docPath);
    const fullText = edit.fullRewrite;
    const edits: EditHunk[] = fullText !== undefined ? diffToHunks(body, fullText) : (edit.hunks ?? []);
    const proposal = await appendProposal(docPath, threadId, (id) => ({
      id,
      threadId,
      edits,
      ...(fullText !== undefined ? { fullText } : {}),
      baseHash: bodyHash(body),
      rationale: edit.rationale,
      status: "pending",
      delivered: false,
      at: this.deps.now(),
    }));
    return this.settle(docPath, proposal, onToken, { silent: opts.silent, reviewOnly: opts.reviewOnly });
  }

  /**
   * Record a whole-highlight replacement (markdown Improve's reply IS the new text for
   * the annotated span) as a single-span proposal, applied by re-resolving the
   * annotation's anchor rather than by literal hunk matching. Same modes as `submit`.
   */
  async submitSpan(
    docPath: string,
    threadId: string,
    newText: string,
    onToken?: TokenSink,
  ): Promise<SubmittedEdit> {
    const proposal = await appendProposal(docPath, threadId, (id) => ({
      id,
      threadId,
      edits: [],
      newText,
      rationale: "",
      status: "pending",
      delivered: false,
      at: this.deps.now(),
    }));
    // Suggesting mode announces nothing here: the caller (Improve) returns the rewrite
    // and proposal id to the UI, which renders its own review box.
    return this.settle(docPath, proposal, onToken, { silent: true, announceApplied: true });
  }

  /** Apply now when the document is in Editing mode; otherwise leave pending. */
  private async settle(
    docPath: string,
    proposal: Proposal,
    onToken: TokenSink | undefined,
    opts: { silent?: boolean; announceApplied?: boolean; reviewOnly?: boolean } = {},
  ): Promise<SubmittedEdit> {
    const silent = opts.silent ?? false;
    const announceApplied = opts.announceApplied ?? !silent;
    const direct = !opts.reviewOnly && (await readSettings(docPath)).agentEdit === "direct";
    let applied = false;
    let applyError: string | undefined;
    if (direct) {
      try {
        // Several agents can finish together (parallel directives, a batch of review
        // findings); each was based on the body before the others applied. Targeted
        // hunks are located by their own text, so they are safe to apply to a drifted
        // body (and refused if their text is gone). A full rewrite is not — it would
        // overwrite the others — so it keeps the strict staleness check.
        await this.approve(docPath, proposal.threadId, proposal.id, {
          allowDrift: proposal.fullText === undefined,
        });
        applied = true;
      } catch (e) {
        applyError = e instanceof Error ? e.message : String(e);
      }
    }
    const current = (await listProposals(docPath, proposal.threadId)).find((p) => p.id === proposal.id) ?? proposal;
    const payload = {
      id: current.id,
      threadId: current.threadId,
      edits: current.edits,
      rationale: current.rationale,
      ...(current.fullText !== undefined ? { fullText: current.fullText } : {}),
      ...(current.newText !== undefined ? { newText: current.newText } : {}),
      ...(applyError ? { applyError } : {}),
    };
    if (applied) {
      if (announceApplied) onToken?.({ type: "applied", text: JSON.stringify(payload) });
    } else if (!silent && current.status === "pending") {
      onToken?.({ type: "proposal", text: JSON.stringify(payload) });
    }
    return { proposal: current, applied, ...(applyError ? { applyError } : {}) };
  }

  /**
   * Approve a pending proposal: apply it to the doc, then mark approved. Rewrite mode
   * writes the exact kept body; hunk mode splices each oldText→newText; a single-span
   * proposal (newText only) replaces its annotation's resolved anchor. Frontmatter is
   * preserved. Applies to one document are serialized.
   */
  approve(
    docPath: string,
    threadId: string,
    proposalId: string,
    opts: { allowDrift?: boolean } = {},
  ): Promise<void> {
    // Read-check-write on the user's document must not interleave with another apply.
    return withFileLock(`${docPath}#apply`, () => this.approveLocked(docPath, threadId, proposalId, opts));
  }

  private async approveLocked(
    docPath: string,
    threadId: string,
    proposalId: string,
    opts: { allowDrift?: boolean },
  ): Promise<void> {
    const p = (await listProposals(docPath, threadId)).find((x) => x.id === proposalId);
    if (!p) throw new Error(`proposal not found: ${proposalId}`);
    // Idempotency guard: a lost approve/reject RESPONSE (e.g. a sidecar restart between
    // applying the change and sending the reply) leaves the client's card/diff-panel live
    // even though the proposal already resolved server-side. Without this guard, a retry
    // click on an already-approved fullText/hunk proposal would fall through to the
    // baseHash staleness check below and throw a confusing "the document changed" error
    // (the body legitimately changed — because THIS proposal already applied it). This
    // throws a clean, distinguishable message instead, which the client's proposalActions
    // recognizes and treats as success-shaped cleanup (remove the card; reload if approved)
    // rather than a normal failure to retry.
    if (p.status !== "pending") {
      throw new Error(`proposal already ${p.status}`);
    }
    // Single-span proposal (newText, no edits/fullText) → anchor-resolved apply.
    if (p.fullText === undefined && (!p.edits || p.edits.length === 0) && p.newText !== undefined) {
      await this.applySpan(docPath, threadId, p.newText);
      await updateProposal(docPath, proposalId, { status: "approved" });
      return;
    }
    // Guard a degenerate proposal: no full rewrite AND no hunks. applyHunks([]) would
    // return the body verbatim, so without this we'd write an identical body, take two
    // snapshots, and mark it approved as if something happened. Reject it instead, atomically.
    if (p.fullText === undefined && (p.edits?.length ?? 0) === 0) {
      throw new Error("proposal has no edits to apply");
    }
    const raw = await readFile(docPath, "utf8");
    const htmlDoc = isHtmlDoc(docPath);
    const parsed = htmlDoc ? null : matter(raw);
    const body = htmlDoc ? raw : parsed!.content;
    // Staleness compare-and-swap: if the body drifted since the proposal was made, refuse
    // rather than clobber the intervening edits (a full rewrite would overwrite the whole
    // body; hunks would apply against text the agent never saw). Legacy proposals have no
    // baseHash, so the guard is skipped for them. `allowDrift` (Editing mode, hunks only)
    // relies on the hunks' own text matching instead — see `settle`.
    if (!opts.allowDrift && p.baseHash !== undefined && bodyHash(body) !== p.baseHash) {
      throw new Error(
        "the document changed since this edit was proposed — discard it and ask the agent again",
      );
    }
    if (htmlDoc && p.fullText === undefined) assertHtmlHunksSafe(p.edits);
    const newBody = p.fullText !== undefined ? p.fullText : applyHunks(body, p.edits);
    if (htmlDoc) {
      const validation = validateHtml(newBody);
      if (!validation.ok) {
        const feedback =
          `HTML validation failed: ${validation.error}. ` +
          "Repair the proposal so the resulting HTML has balanced, properly nested tags.";
        await updateProposal(docPath, proposalId, {
          status: "rejected",
          delivered: false,
          feedback,
        });
        throw new Error(feedback);
      }
    }
    // Unlike the single-span path (applySpan), this path intentionally leaves the
    // annotation `open`: the discussion may continue, and after a full rewrite the old anchor
    // may no longer resolve, so re-anchoring + marking it resolved here would be wrong.
    await withEditSnapshot(
      this.deps,
      docPath,
      threadId,
      async () => {
        await writeFile(docPath, htmlDoc ? newBody : matter.stringify(newBody, parsed!.data), "utf8");
      },
      { before: raw },
    );
    await updateProposal(docPath, proposalId, { status: "approved" });
  }

  /**
   * Reject a pending proposal. The doc is left untouched; the proposal is marked rejected
   * but stays undelivered, so its feedback is queued to ride along with the user's NEXT
   * reply (see rejectFeedbackPrefix), not pushed to the agent immediately.
   */
  async reject(docPath: string, threadId: string, proposalId: string): Promise<void> {
    const p = (await listProposals(docPath, threadId)).find((x) => x.id === proposalId);
    if (!p) throw new Error(`proposal not found: ${proposalId}`);
    // Same idempotency guard as approve (see its comment): without it, a stray reject on
    // an already-APPROVED proposal would silently flip its status to "rejected" even
    // though the edit is already applied to the doc — corrupting the record (and
    // rejectFeedbackPrefix would later tell the agent an applied edit was rejected).
    if (p.status !== "pending") {
      throw new Error(`proposal already ${p.status}`);
    }
    await updateProposal(docPath, proposalId, { status: "rejected" });
  }

  /**
   * Build the deferred reject-feedback prefix for a thread: any proposals the reviewer
   * REJECTED but that haven't yet been delivered to the agent. Mirrors the mid-thread
   * stance re-injection — the prefix rides along with the NEXT agent message, and each
   * rejection is marked delivered so it's sent exactly once. Returns "" when none pend.
   */
  async rejectFeedbackPrefix(docPath: string, threadId: string): Promise<string> {
    const pending = (await listProposals(docPath, threadId)).filter(
      (p) => p.status === "rejected" && !p.delivered,
    );
    if (pending.length === 0) return "";
    let prefix =
      "(The reviewer rejected your earlier proposed edit(s) — do not repeat them; reconsider:\n";
    for (const p of pending) {
      if (p.fullText !== undefined) {
        prefix += `- a full rewrite\n`;
      } else if (p.edits?.length) {
        for (const h of p.edits) {
          prefix += `- replace "${h.oldText.slice(0, 60)}" → "${h.newText.slice(0, 60)}"\n`;
        }
      } else if (p.newText) {
        prefix += `- "${p.newText.slice(0, 80)}"\n`;
      }
      if (p.feedback?.trim()) {
        prefix += `  Feedback: ${p.feedback.trim()}\n`;
      }
    }
    prefix += ")\n\n";
    for (const p of pending) await updateProposal(docPath, p.id, { delivered: true });
    return prefix;
  }

  /**
   * Apply a single-span proposal: resolve its owning annotation's anchor in the CURRENT
   * doc (fuzzy-tolerant, NOT literal `oldText` matching like the hunk path), splice in
   * the replacement text, snapshot, and re-anchor the annotation as resolved.
   */
  private async applySpan(docPath: string, annotationId: string, newText: string): Promise<void> {
    if (isHtmlDoc(docPath)) {
      throw new Error("HTML proposals must be persisted and approved through approveProposal as structured hunks");
    }
    const before = await readFile(docPath, "utf8");
    const ann = (await readAnnotations(docPath)).annotations.find((a) => a.id === annotationId);
    if (!ann) throw new Error(`annotation not found: ${annotationId}`);
    const range = resolveAnchor(before, ann.anchor);
    if (!range) {
      throw new Error(`cannot apply: anchor for ${annotationId} no longer resolves`);
    }

    const after = before.slice(0, range.start) + newText + before.slice(range.end);
    await withEditSnapshot(
      this.deps,
      docPath,
      annotationId,
      async () => {
        await writeFile(docPath, after, "utf8");
      },
      { before, after },
    );

    const newStart = after.indexOf(newText, range.start);
    const newAnchor = createAnchor(after, newStart, newStart + newText.length);
    await updateAnnotation(docPath, annotationId, {
      anchor: newAnchor,
      status: "resolved",
    });
  }
}

/**
 * Apply hunks to `body`. Resolves each hunk in list order with a FORWARD CURSOR, so a
 * duplicate `oldText` maps to SUCCESSIVE occurrences — the same way the editor's display
 * scans — instead of every duplicate hitting the first occurrence (which would let the
 * backend edit a different occurrence than the reviewer saw). Resolved spans are strictly
 * increasing, so they can never overlap; splicing descending keeps earlier offsets valid.
 * Atomic: throws before any mutation if a hunk has no anchor or its text isn't found, so
 * the caller's status stays pending.
 */
export function applyHunks(body: string, edits: EditHunk[]): string {
  // An empty oldText is an insertion with no anchor — we can't place it, and silently
  // dropping it would "approve" an edit that changes nothing. Reject the whole proposal.
  // (Full rewrites carry their insertions in fullText, not here.)
  if (edits.some((h) => h.oldText.length === 0)) {
    throw new Error(
      "a proposed edit has no anchor text — ask the agent to include the surrounding text to anchor it",
    );
  }
  let cursor = 0;
  const placed: { start: number; end: number; newText: string }[] = [];
  for (const h of edits) {
    const at = body.indexOf(h.oldText, cursor);
    if (at < 0) throw new Error(`hunk text not found: ${JSON.stringify(h.oldText.slice(0, 40))}`);
    placed.push({ start: at, end: at + h.oldText.length, newText: h.newText });
    cursor = at + h.oldText.length;
  }
  let out = body;
  for (let i = placed.length - 1; i >= 0; i--) {
    const r = placed[i];
    out = out.slice(0, r.start) + r.newText + out.slice(r.end);
  }
  return out;
}

function assertHtmlHunksSafe(edits: EditHunk[]): void {
  for (const h of edits) {
    const oldHasTags = containsHtmlTag(h.oldText);
    const newHasTags = containsHtmlTag(h.newText);
    if (oldHasTags && h.newText.trim() !== "" && !newHasTags) {
      throw new Error(
        "HTML proposal hunk replaces tagged source with plain text — ask the agent for a raw HTML replacement or a full rewrite",
      );
    }
    if (!oldHasTags && newHasTags) {
      throw new Error(
        "HTML proposal hunk inserts raw tags into text-only source — ask the agent to include the containing raw HTML element in oldText or use a full rewrite",
      );
    }
  }
}
