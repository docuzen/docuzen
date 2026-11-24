// The prompt and reply contract shared by Docuzen's external harnesses (Codex's `codex
// exec`, and every ACP agent). These harnesses get no Docuzen tools, so an edit comes
// back as text: the prompt asks for ONE trailing fenced ```json block, and
// extractTrailingProposal turns that block into a ProposedEdit for the reviewer to
// approve. Moved here from codex-runner.ts unchanged; buildCodexPrompt is
// buildHarnessPrompt(ctx, "Codex"), byte for byte (see codex-runner-prompt.test.ts).
import type { AgentContext, EditHunk, ProposedEdit } from "./types.js";
import { historySection, standingInstructionsSection } from "./prompt-sections.js";

/** The external harnesses' history/standing-instructions phrasing (see prompt-sections.ts for the pi divergence). */
const HISTORY_LABELS = { agent: "Agent", reviewer: "Reviewer" };
const HISTORY_HEADING = "## Conversation so far";
const STANDING_INSTRUCTIONS_HEADING = "## Standing instructions";

/**
 * True in the modes where pi would offer the propose_edit tool (see tool-policy.ts's
 * gating): the default propose mode wants a structured edit back; reviewMode wants
 * findings, replacementOnly wants raw replacement text, and conversationOnly turns
 * (discuss/reply/panel/branch) never edit at all — so none of the three get the
 * contract. This single predicate gates BOTH the prompt clause below AND the reply
 * parser in each external runner — a volunteered trailing ```json block in a
 * conversation turn is never parsed into a proposal; it stays visible prose.
 */
export function canProposeEdits(ctx: AgentContext): boolean {
  return !ctx.reviewMode && !ctx.replacementOnly && !ctx.conversationOnly;
}

/** Verbatim contract text asked of the harness in place of the "not exposed" disclaimer — see extractTrailingProposal for the matching parser. */
const PROPOSAL_CONTRACT =
  "To propose a document edit, end your reply with exactly ONE fenced ```json block of shape" +
  ' {"rationale": string, "hunks": [{"oldText": string, "newText": string}, …]} or' +
  ' {"rationale": string, "fullRewrite": string}. oldText must be copied verbatim from the' +
  " document. Output no other fenced json blocks.";

/** The first prompt of an external-harness session; `label` names the harness ("Codex", "Claude Code"). */
export function buildHarnessPrompt(ctx: AgentContext, label: string): string {
  const history = historySection(ctx.history, HISTORY_HEADING, HISTORY_LABELS);
  const instructions = standingInstructionsSection(ctx.instructions, STANDING_INSTRUCTIONS_HEADING, true);
  const mode = [
    ctx.conversationOnly
      ? "This is a conversation turn: discuss only. Docuzen will not apply or offer for" +
        " approval any edit you include here, even a fenced ```json block — it will be" +
        " shown to the reviewer as plain text, not as a proposal. If the reviewer wants a" +
        " change made, tell them to use Improve, Resolve, or Review instead."
      : "",
    ctx.replacementOnly
      ? "This turn wants only the replacement text for the highlighted passage. Reply with the replacement text only."
      : "",
    ctx.reviewMode
      ? `This turn is a document review. Return concise findings in prose. The ${label} adapter cannot yet file Docuzen review annotations directly.`
      : "",
    "Do not edit files. Docuzen will persist only your final reply.",
  ].filter(Boolean);

  return [
    `You are running as Docuzen's ${label} external harness adapter.`,
    `Use ${label}'s native capabilities, including its managed web search when useful, but do not claim Docuzen tools are available.`,
    canProposeEdits(ctx)
      ? PROPOSAL_CONTRACT
      : `Docuzen has not exposed propose_edit or add_review_finding tools to ${label} yet.`,
    "",
    "## Document",
    ctx.docPath ? `Path: ${ctx.docPath}` : "Path: unknown",
    ctx.htmlMode ? "Format: HTML source" : "Format: Markdown/body text",
    "",
    "## Stance",
    ctx.stancePrompt,
    ...instructions,
    ...(ctx.handoffNote ? [ctx.handoffNote] : []),
    ...history,
    "",
    "## Current document text",
    ctx.docText,
    "",
    "## Highlight / local context",
    `Highlighted text: ${ctx.anchorExact}`,
    ctx.surrounding,
    "",
    "## Reviewer request",
    ctx.comment,
    "",
    "## Adapter limitations",
    ...mode,
  ].join("\n");
}

/** Matches a fenced ```json block that runs all the way to the end of the (already
 * right-trimmed) string handed to it — see extractTrailingProposal. */
const TRAILING_JSON_FENCE = /^```json[ \t]*\r?\n([\s\S]*?)\r?\n?```[ \t]*$/;

/** A line that opens a ```json fence. A ```json inside the block's JSON (an edit to a doc
 * with its own json example) is in a string, where newlines are escaped, so it never
 * starts a line. */
const JSON_FENCE_OPENING = /^[ \t]*(```json[ \t]*)\r?$/gm;

/**
 * Parser half of the structured-edit contract in buildHarnessPrompt (PROPOSAL_CONTRACT):
 * pulls a TRAILING fenced ```json block out of a harness reply and turns it into a
 * ProposedEdit, stripping the block from the returned reply.
 *
 * Only a block anchored at the very end of the reply (after trimming trailing
 * whitespace) is considered — an earlier ```json block (e.g. a code sample in the
 * agent's prose) is left untouched as ordinary reply text; only the LAST opening
 * fence at the start of a line is ever a candidate. On any failure (no trailing block, invalid JSON, JSON that
 * matches neither the contract shape nor the legacy flat shape) this returns the
 * original reply completely unchanged and no proposal — never throws.
 *
 * On success the returned `reply` is the prose that preceded the block, trimmed; if
 * that's empty, the proposal's rationale is used instead, or "Proposed an edit." if
 * the rationale is empty too, so the persisted turn never has a blank reply.
 */
export function extractTrailingProposal(reply: string): { reply: string; proposal?: ProposedEdit } {
  const trimmed = reply.trimEnd();
  let idx = -1;
  for (const m of trimmed.matchAll(JSON_FENCE_OPENING)) idx = m.index + m[0].indexOf(m[1]);
  if (idx === -1) return { reply };

  const match = trimmed.slice(idx).match(TRAILING_JSON_FENCE);
  if (!match) return { reply }; // ```json found, but more than whitespace follows its close — not trailing

  let parsed: unknown;
  try {
    parsed = JSON.parse(match[1] ?? "");
  } catch {
    return { reply };
  }

  const proposal = toProposedEdit(parsed);
  if (!proposal) return { reply };

  const prose = trimmed.slice(0, idx).trim();
  return { reply: prose || proposal.rationale || "Proposed an edit.", proposal };
}

/**
 * Validates+normalizes the parsed JSON into a ProposedEdit. Accepts the contract
 * shape ({rationale, hunks} / {rationale, fullRewrite}, rationale optional) and the
 * legacy flat shape a model might improvise instead ({oldText, newText}, mapped to a
 * single hunk with an empty rationale — mirrors pi-runner's propose_edit tool).
 * Returns undefined for anything else (wrong types, empty hunks array, neither
 * hunks nor fullRewrite present).
 */
function toProposedEdit(value: unknown): ProposedEdit | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const obj = value as Record<string, unknown>;

  if (
    obj.hunks === undefined &&
    obj.fullRewrite === undefined &&
    typeof obj.oldText === "string" &&
    typeof obj.newText === "string"
  ) {
    return { rationale: "", hunks: [{ oldText: obj.oldText, newText: obj.newText }] };
  }

  const rationale = typeof obj.rationale === "string" ? obj.rationale : "";

  if (Array.isArray(obj.hunks)) {
    if (obj.hunks.length === 0) return undefined;
    const hunks: EditHunk[] = [];
    for (const raw of obj.hunks) {
      if (!raw || typeof raw !== "object") return undefined;
      const h = raw as Record<string, unknown>;
      if (typeof h.oldText !== "string" || typeof h.newText !== "string") return undefined;
      hunks.push({ oldText: h.oldText, newText: h.newText });
    }
    return { rationale, hunks };
  }

  if (typeof obj.fullRewrite === "string") {
    return { rationale, fullRewrite: obj.fullRewrite };
  }

  return undefined;
}
