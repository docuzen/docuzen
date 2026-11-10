// Everything that decides WHAT an agent is told: the context builder every turn goes
// through, plus the prompt text for the explicit rewrite flow. Free functions over the
// document's on-disk state — no Orchestrator instance, no runner — so the prompt-shaping
// rules can be read (and tested) apart from the turn engine that invokes agents.
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import matter from "gray-matter";
import type { AgentContext } from "../agent/types.js";
import { resolveDocToolchain } from "../agent/mcp.js";
import { readAnnotations, readSettings, readThread, isHtmlDoc, type HadSettings } from "../had/index.js";
import { findRepoRoot } from "../had/resolve.js";
import type { Annotation } from "../had/types.js";
import { documentBody } from "./proposal-service.js";
import { stancePrompt } from "./stance.js";

/** Opaque key a runner indexes a live session by, so cancel() can abort it. */
export function cancelKeyFor(docPath: string, threadId: string): string {
  return `${docPath}#${threadId}`;
}

/** Doc-text budget passed inline to the agent (~30k tokens). Tools fetch more. */
export const DOC_TEXT_BUDGET = 120_000;

/** Walk up from `start` to the nearest repo root (.git), else return `start`. */
export function repoScope(start: string): string {
  return findRepoRoot(start) ?? start;
}

/**
 * The Improve instruction. `discussed` = a real back-and-forth already exists in
 * this thread (and is in the agent's context), so the rewrite should fold it in;
 * otherwise it's a standalone polish of the passage with no discussion to invoke.
 * Markdown stays replacement-only; HTML uses structured raw-source proposals so
 * validation and the normal approve/reject path protect the document.
 */
export function improvePrompt(
  discussed: boolean,
  history: { role: "you" | "agent"; body: string }[] = [],
  htmlMode = false,
): string {
  const replyOnly =
    "Reply with ONLY the replacement text — no preamble, no quotes, no code" +
    " fences, no explanation.";
  const latestReviewer = [...history].reverse().find((t) => t.role === "you");
  const latestAgent = [...history].reverse().find((t) => t.role === "agent");
  const latest = [
    latestReviewer ? `Latest reviewer ask: ${latestReviewer.body}` : "",
    latestAgent ? `Latest agent response: ${latestAgent.body}` : "",
  ].filter(Boolean);
  const conversation = history
    .map((t) => `${t.role === "agent" ? "agent" : "reviewer"}: ${t.body}`)
    .join("\n");

  if (htmlMode) {
    const contextLine = discussed
      ? "Use the conversation so far as context for this rewrite, especially the latest reviewer ask and agent response."
      : "Improve the highlighted passage without inventing discussion context that is not present.";
    return (
      `${contextLine} Produce a focused HTML-safe edit for the document source. ` +
      "Call propose_edit with raw-source `oldText` copied VERBATIM from the HTML document and `newText` as the replacement raw HTML fragment. " +
      "If the useful edit needs the containing heading, paragraph, list item, card, or section, include that containing raw HTML in oldText/newText instead of editing only the rendered selected text. " +
      "Keep tags balanced and properly nested, validate the candidate HTML, and do not paste the replacement HTML in your prose." +
      (latest.length ? `\n\n${latest.join("\n")}` : "") +
      (conversation ? `\n\nConversation so far:\n${conversation}` : "")
    );
  }

  if (!discussed) {
    return (
      "Rewrite the highlighted passage to make it clearer, tighter, and more" +
      " precise, preserving its meaning and any commitments it makes. Make a" +
      " focused improvement to that passage only — do not rewrite the rest of" +
      " the document. " +
      replyOnly
    );
  }

  return (
    "Use the conversation so far as context for this rewrite. Rewrite the" +
    " highlighted passage to fold in the discussion above, especially the" +
    " latest reviewer ask and agent response, improving its clarity and" +
    " precision while preserving its intent." +
    (latest.length ? `\n\n${latest.join("\n")}` : "") +
    (conversation ? `\n\nConversation so far:\n${conversation}` : "") +
    `\n\n${replyOnly}`
  );
}

function localSourceContext(raw: string, docPath: string, ann: Annotation): string {
  if (!isHtmlDoc(docPath)) return ann.anchor.prefix + ann.anchor.exact + ann.anchor.suffix;
  const at = raw.indexOf(ann.anchor.exact);
  if (at < 0) return ann.anchor.prefix + ann.anchor.exact + ann.anchor.suffix;
  const start = Math.max(0, at - 500);
  const end = Math.min(raw.length, at + ann.anchor.exact.length + 500);
  return raw.slice(start, end);
}

/**
 * Inputs to the single `buildContext` builder, covering discuss/reply/resume/branch/
 * improve/visualize (anchored to `ann`), a whole-document Review Pass (`reviewMode`),
 * and an inline-directive pass (`directiveMode`).
 */
export interface BuildContextOpts {
  docPath: string;
  /**
   * Annotation this context is anchored to. Supplies `anchorExact` + `surrounding`
   * (from the live doc) and is excluded from the OTHER-annotations digest via
   * `annotationId`. Omitted for `reviewMode` and `directiveMode`, which pass
   * `anchorExact`/`surrounding` explicitly instead (or leave them empty).
   */
  ann?: Annotation;
  anchorExact?: string;
  surrounding?: string;
  comment: string;
  stance: string;
  modelId?: string;
  /**
   * The "self" annotation id excluded from the OTHER-annotations digest. Ignored in
   * `reviewMode` (which digests every annotation, no exclusion) and `directiveMode`
   * (which never builds a digest).
   */
  annotationId?: string;
  /** Thread id the cancelKey is keyed on: `${docPath}#${threadId}`. */
  threadId: string;
  /**
   * Whole-document Review Pass: doc text is always frontmatter-stripped via `matter()`
   * (NOT html-aware, unlike the anchored passes), the digest covers every annotation
   * with a 200-char agent-reply slice (vs. 300 elsewhere), and `reviewMode: true` is set
   * on the resulting context.
   */
  reviewMode?: boolean;
  /**
   * Inline-directive pass: no annotations digest at all ("").
   * Doc text/scope/settings are supplied via `shared` since resolveDirectives reads the
   * doc once and fans out one context per directive against that same read.
   */
  directiveMode?: boolean;
  shared?: { docText: string; scopeDir: string; settings: HadSettings };
}

/**
 * Assemble the agent's context. One builder powers three passes:
 *  - anchored (discuss/reply/resume/branch/improve/visualize): `opts.ann` supplies the
 *    highlight + local surrounding text (html-aware doc body), digest of every OTHER
 *    annotation (300-char agent-reply slice). This is also where `conversationOnly`
 *    defaults to true (see below) — improve() is the one anchored caller that flips it
 *    back to false on the context it hands the runner, since Improve is an explicit
 *    edit flow, not a conversation turn.
 *  - `reviewMode` (whole-document Review Pass): no anchor; doc text is always
 *    frontmatter-stripped via `matter()` regardless of doc type; digest of EVERY
 *    annotation (200-char agent-reply slice); `conversationOnly` forced off.
 *  - `directiveMode` (inline `[[ … ]]` directives): no digest at all; doc text/scope/
 *    settings come from `opts.shared` (resolveDirectives reads the doc once and fans
 *    out one context per directive against that same read); `conversationOnly`
 *    forced off.
 *
 * No context ever grants write tools: the agent never edits the document directly.
 * Every change is a proposal (propose_edit, a review finding's edit, or Improve's
 * rewrite) that the reviewer approves through `approveProposal`.
 */
export async function buildAgentContext(opts: BuildContextOpts): Promise<AgentContext> {
  const { docPath, ann } = opts;

  let docText: string;
  let scopeDir: string;
  let settings: HadSettings;
  let raw: string | undefined;

  if (opts.shared) {
    ({ docText, scopeDir, settings } = opts.shared);
  } else {
    raw = await readFile(docPath, "utf8");
    const body = opts.reviewMode ? matter(raw).content : documentBody(raw, docPath);
    docText =
      body.length > DOC_TEXT_BUDGET ? body.slice(0, DOC_TEXT_BUDGET) + "\n…[truncated]" : body;
    settings = await readSettings(docPath);
    const folder = dirname(docPath);
    scopeDir = settings.scope === "repo" ? repoScope(folder) : folder;
  }

  let digest = "";
  if (!opts.directiveMode) {
    const all = (await readAnnotations(docPath)).annotations;
    const others = opts.reviewMode ? all : all.filter((a) => a.id !== opts.annotationId);
    const sliceLen = opts.reviewMode ? 200 : 300;
    for (const a of others) {
      digest += `- [${a.type}] "${a.anchor.exact}"\n`;
      try {
        const th = await readThread(docPath, a.id);
        const you = th.turns.find((t) => t.role === "you");
        const agent = [...th.turns].reverse().find((t) => t.role === "agent");
        if (you) digest += `    comment: ${you.body}\n`;
        if (agent) digest += `    agent: ${agent.body.slice(0, sliceLen)}\n`;
      } catch {
        // annotation has no discussion thread yet
      }
    }
  }

  // `ann` is only ever set on the non-`shared` path (anchored passes always read
  // `raw` above for docText), so `raw` is guaranteed defined here.
  const anchorExact = ann ? ann.anchor.exact : (opts.anchorExact ?? "");
  const surrounding = ann ? localSourceContext(raw!, docPath, ann) : (opts.surrounding ?? "");

  // The ONE context predicate conversation turns are gated on (tool-policy.ts,
  // pi-runner.ts, codex-runner.ts) — true for every anchored call EXCEPT reviewMode/
  // directiveMode. improve() (the one other anchored caller) overrides this back to
  // false on the context object it actually hands the runner, since Improve is an
  // explicit edit flow, not a conversation turn — see its own comment.
  const conversationOnly = !opts.reviewMode && !opts.directiveMode;

  return {
    docText,
    anchorExact,
    surrounding,
    comment: opts.comment,
    stancePrompt: stancePrompt(opts.stance),
    docPath,
    scopeDir,
    annotationsDigest: digest,
    ...(settings.instructions?.trim() ? { instructions: settings.instructions } : {}),
    ...(settings.webSearch ? { webSearch: settings.webSearch } : {}),
    conversationOnly,
    ...(opts.reviewMode ? { reviewMode: true } : {}),
    htmlMode: isHtmlDoc(docPath),
    docToolchain: resolveDocToolchain(docPath),
    modelId: opts.modelId ?? settings.model,
    cancelKey: cancelKeyFor(docPath, opts.threadId),
  };
}
