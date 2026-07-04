import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import matter from "gray-matter";
import type {
  AgentContext,
  AgentRunner,
  AgentTurn,
  EditHunk,
  ProposedEdit,
  ReviewFinding,
  TokenSink,
} from "../agent/types.js";
import { HarnessRegistry, type AgentHarness } from "../agent/harness-registry.js";
import { validateHtml } from "../agent/html-validation.js";
import { resolveDocToolchain } from "../agent/mcp.js";
import type { TaskDB } from "../state/task-db.js";
import { stancePrompt } from "./stance.js";
import { diffToHunks } from "./diff.js";
import { findDirectives } from "./directives.js";
import { transition } from "./turn-status.js";
import {
  readAnnotations,
  addAnnotation,
  updateAnnotation,
  nextAnnotationId,
  initThread,
  appendTurn,
  readThread,
  updateThreadFrontmatter,
  snapshot,
  readVersion,
  latestVersionId,
  readSettings,
  listProposals,
  addProposal,
  updateProposal,
  isHtmlDoc,
  type HadSettings,
} from "../had/index.js";
import { createAnchor, resolveAnchor } from "../anchor/index.js";
import type { Annotation, ThreadTurn } from "../had/types.js";
import { withEditSnapshot } from "./edit-snapshot.js";

/** Doc-text budget passed inline to the agent (~30k tokens). Tools fetch more. */
const DOC_TEXT_BUDGET = 120_000;

/** Walk up from `start` to the nearest repo root (.git), else return `start`. */
function findRepoRoot(start: string): string {
  let cur = start;
  for (;;) {
    if (existsSync(join(cur, ".git"))) return cur;
    const parent = dirname(cur);
    if (parent === cur) return start;
    cur = parent;
  }
}

/**
 * The Improve instruction. `discussed` = a real back-and-forth already exists in
 * this thread (and is in the agent's context), so the rewrite should fold it in;
 * otherwise it's a standalone polish of the passage with no discussion to invoke.
 * Markdown stays replacement-only; HTML uses structured raw-source proposals so
 * validation and the normal approve/reject path protect the document.
 */
function improvePrompt(
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

/** Stable content fingerprint for the staleness compare-and-swap on proposal approval. */
function bodyHash(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex");
}

/** Max length of a TaskDB `errorText` value — a summary for the UI, not a full stack trace. */
const ERROR_TEXT_MAX = 300;

/**
 * A thrown error's first line, truncated for the TaskDB `errorText` column. Every
 * `transition(..., "error")` call site uses this so a task's failure reason is a short,
 * UI-safe summary rather than a raw (possibly multi-line, possibly huge) error dump.
 */
function errorSummary(e: unknown): string {
  const line = String(e).split("\n")[0];
  return line.length > ERROR_TEXT_MAX ? line.slice(0, ERROR_TEXT_MAX) : line;
}

function documentBody(raw: string, docPath: string): string {
  return isHtmlDoc(docPath) ? raw : matter(raw).content;
}

function containsHtmlTag(text: string): boolean {
  return /<\/?[A-Za-z][^>]*>/.test(text);
}

function proposalPreview(pe: ProposedEdit): string {
  if (pe.fullRewrite !== undefined) return pe.fullRewrite.trim();
  const hunks = pe.hunks ?? [];
  if (hunks.length === 1) return hunks[0].newText.trim();
  return hunks.map((h) => h.newText.trim()).filter(Boolean).join("\n\n");
}

function localSourceContext(raw: string, docPath: string, ann: Annotation): string {
  if (!isHtmlDoc(docPath)) return ann.anchor.prefix + ann.anchor.exact + ann.anchor.suffix;
  const at = raw.indexOf(ann.anchor.exact);
  if (at < 0) return ann.anchor.prefix + ann.anchor.exact + ann.anchor.suffix;
  const start = Math.max(0, at - 500);
  const end = Math.min(raw.length, at + ann.anchor.exact.length + 500);
  return raw.slice(start, end);
}

export interface OrchestratorDeps {
  runner?: AgentRunner;
  registry?: HarnessRegistry;
  db: TaskDB;
  /** Injected clock so tests are deterministic. */
  now: () => string;
  /** System user name, used as the author of human ("you") turns. */
  author?: string;
}

export interface DiscussArgs {
  threadId: string;
  annotationId: string;
  stance: string;
  comment: string;
  /** "provider/modelId" key selecting which model answers; falls back to settings.model, then runner default. */
  modelId?: string;
}

export interface ReviewArgs {
  /** Stance fragment for the review (none/critiquer/supporter or a custom one). */
  stance: string;
  /** Optional focus/rubric, e.g. "Find risks and unclear passages." */
  rubric?: string;
  /** "provider/modelId" key selecting which model reviews; falls back to settings.model. */
  modelId?: string;
}

/** One materialized review finding: its annotation + optional pending proposal. */
export interface MaterializedFinding {
  annotationId: string;
  status: string;
  severity?: string;
  kind?: string;
  proposalId?: string;
}

/**
 * Inputs to the single `buildContext` builder, covering discuss/reply/resume/branch/
 * improve/visualize (anchored to `ann`), a whole-document Review Pass (`reviewMode`),
 * and an inline-directive pass (`directiveMode`).
 */
interface BuildContextOpts {
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
   * with a 200-char agent-reply slice (vs. 300 elsewhere), `allowEdit` is forced false,
   * and `reviewMode: true` is set on the resulting context.
   */
  reviewMode?: boolean;
  /**
   * Inline-directive pass: no annotations digest at all (""), `allowEdit` forced false.
   * Doc text/scope/settings are supplied via `shared` since resolveDirectives reads the
   * doc once and fans out one context per directive against that same read.
   */
  directiveMode?: boolean;
  shared?: { docText: string; scopeDir: string; settings: HadSettings };
}

/**
 * One agent turn's shared lifecycle, as `runTurn` executes it. Each field is a seam where a
 * converting method injects its differences; the invariant sequence lives in `runTurn` and
 * never branches on which method is calling.
 *
 * Contract for the converting methods (discuss, reply, resumeFromTranscript, branch;
 * review stays on its bespoke path — see the class-level `runTurn` doc comment): `runTurn`
 * owns, in order — harness resolve → doc-version snapshot → append you-turn →
 * transition(running) → the shared per-invoke core (`runAgentStep`: buildContext →
 * afterContext → invoke (try/catch) → append agent-turn) → transition(responded) →
 * persistProposal → detectDirectEdit; on invoke failure it transitions to error (with
 * frontmatter) and rethrows the original value unchanged. Method-unique pre-work (thread
 * init vs load, stance switch, reject-feedback prefix, live-vs-resume routing, fork/
 * thread-copy) stays in the caller, before `runTurn`. The `skip*`/`docVersion`/
 * `afterContext` fields are opt-in seams for the methods whose spine differs from
 * discuss/reply's default in one of these specific ways — they are pure data toggles, never
 * a branch on caller identity inside the engine. `panel` needs its OWN you-turn/transition
 * bracketing around N invokes (not one pair per model), and `resolveDirectives` needs its
 * OWN persist-before-responded ordering and error-swallow (instead of rethrow), so both skip
 * `runTurn` entirely and call `runAgentStep` directly instead — see that method's doc
 * comment.
 */
export interface TurnSpec {
  /** Thread the turn runs on: keys the transitions, the appended turns, and direct-edit detection. */
  threadId: string;
  /** Annotation the turn is anchored to; handed to persistProposal for any structured edit the turn carries. */
  ann: Annotation;
  /**
   * The you-turn to persist before the agent runs. The engine stamps author + the turn-base
   * docVersion. Required — every `runTurn` call has exactly one you-turn. `panel` shares ONE
   * you-turn across its whole per-model loop instead, which is why it doesn't build a
   * TurnSpec at all — see `runAgentStep`.
   */
  youTurn: { body: string };
  /** meta stamped on the agent turn — the effective stance (discuss/reply/resumeFromTranscript/branch). */
  agentMeta: string;
  /**
   * buildContext inputs. The engine builds the context, uses its `allowEdit` to drive the
   * pre/post direct-edit snapshot, and hands it to `invoke`. (reply's send() ignores the
   * context arg but still relies on its `allowEdit` — the same value reply's old direct
   * settings read produced.)
   */
  context: BuildContextOpts;
  /**
   * Runner invocation. discuss/resumeFromTranscript/branch → `runner.start(ctx)` (fresh
   * session); reply → `runner.send(sid, agentMessage)` (live session). Returns the turn plus
   * the session id to record on the responded transition (start: the id it minted; send: the
   * live sid). `panel`'s per-model `runAgentStep` calls use this identical shape.
   */
  invoke: (
    runner: AgentRunner,
    ctx: AgentContext,
    onToken?: TokenSink,
  ) => Promise<{ turn: AgentTurn; sessionId: string }>;
  /**
   * Live/resumed session id known BEFORE invocation, used for the running and error
   * transitions. Omit when starting a fresh session (discuss/resumeFromTranscript/branch) —
   * those transitions record null until `invoke` returns the minted id.
   */
  sessionId?: string;
  /** Harness override: reply/branch pin the thread's persisted harness so a doc-settings change can't switch mid-thread. Omit for the doc default. */
  preferredHarness?: string;
  /** Streamed-event sink, threaded to invoke, persistProposal, and detectDirectEdit. */
  onToken?: TokenSink;
  /**
   * Mutator run right after `buildContext`, before the pre-invoke doc snapshot and `invoke`.
   * A pure data seam, never a branch on caller identity: resumeFromTranscript uses it to
   * attach the prior transcript as replayable history; branch additionally overrides the doc
   * text with a base version's content.
   */
  afterContext?: (ctx: AgentContext) => void;
  /**
   * Override for the you/agent turns' docVersion stamp, and for whether the engine takes a
   * fresh "turn-base" snapshot. Omit (default) to snapshot the CURRENT doc and stamp both
   * turns with that version — what discuss/reply/resumeFromTranscript want. Pass a version
   * id to stamp it without an extra snapshot — branch's already-resolved `baseVersion`. Pass
   * `null` to stamp neither turn and skip the snapshot (branch's pre-versioning-thread edge
   * case, where the edited turn was never version-stamped). `panel` computes an analogous
   * ONE shared version itself and passes it straight to `runAgentStep`, bypassing this
   * three-way override since it never calls `runTurn`.
   */
  docVersion?: string | null;
  /** Skip `persistProposal` at the tail. Branch never turns a fork into a reviewable proposal. */
  skipProposalPersist?: boolean;
  /** Skip the pre/post-invoke direct-edit snapshot. Branch reasons about a past/alternate doc version, so it never enables direct-edit detection either. */
  skipDetectDirectEdit?: boolean;
}

export class Orchestrator {
  constructor(private deps: OrchestratorDeps) {}

  /** Serialize proposals.json writes; parallel directive/review agents can finish together. */
  private proposalWriteChain: Promise<void> = Promise.resolve();

  private registry(): HarnessRegistry {
    if (this.deps.registry) return this.deps.registry;
    if (!this.deps.runner) throw new Error("Orchestrator requires runner or registry");
    return HarnessRegistry.single(this.deps.runner);
  }

  private async harnessForDoc(docPath: string, preferred?: string): Promise<AgentHarness> {
    const settings = await readSettings(docPath);
    return this.registry().resolve(preferred ?? settings.harness);
  }

  /** Opaque key the runner indexes a live session by, so cancel() can abort it. */
  private cancelKey(docPath: string, threadId: string): string {
    return `${docPath}#${threadId}`;
  }

  /** The thread's session id, but only if its owning harness still holds it live (null after a restart). */
  private liveSessionId(threadId: string, harness: AgentHarness): string | null {
    const sid = this.deps.db.get(threadId)?.piSessionId ?? null;
    if (!sid) return null;
    const r = harness.runner;
    return !r.hasSession || r.hasSession(sid) ? sid : null;
  }

  /** Abort the in-flight agent turn for a thread, if the runner supports cancellation. */
  async cancel(docPath: string, threadId: string): Promise<void> {
    let owner: string | undefined;
    try {
      owner = (await readThread(docPath, threadId)).frontmatter.harness;
    } catch {
      owner = undefined;
    }
    const harness = await this.harnessForDoc(docPath, owner);
    await harness.runner.cancel?.(this.cancelKey(docPath, threadId));
  }

  /**
   * Minimal in-memory Annotation for `runTurn`'s required `ann` field when a thread has
   * no persisted annotation on disk — directive-N threads, the "review" umbrella, or any
   * other thread a client replies into without one (see `reply`/`resumeFromTranscript`).
   * `persistProposal`, the sole consumer of `TurnSpec.ann`, reads only `.id`; the
   * placeholder anchor/thread/session fields here are never written to disk. Mirrors
   * `resolveDirectives`'s own local `Annotation` object, built for the identical reason
   * at directive-creation time.
   */
  private syntheticAnnotation(threadId: string): Annotation {
    return {
      id: threadId,
      type: "comment",
      anchor: { exact: "", prefix: "", suffix: "" },
      status: "open",
      thread: `threads/${threadId}.md`,
      session: `sessions/${threadId}.session.jsonl`,
      createdAt: this.deps.now(),
    };
  }

  /**
   * If the just-finished agent turn carried a structured edit proposal, persist it as a
   * pending Proposal and surface it to the UI via a "proposal" event. Shared by discuss,
   * reply, and resumeFromTranscript so every agent turn can produce a reviewable proposal.
   */
  private async persistProposal(
    docPath: string,
    ann: Annotation,
    turn: { proposal?: ProposedEdit },
    onToken?: TokenSink,
  ): Promise<void> {
    const proposal = turn.proposal;
    if (!proposal) return;
    const write = async (): Promise<void> => {
    const pe = proposal;
    const threadId = ann.id;
    // Normalize to display/apply hunks: targeted edits ride through verbatim; a full
    // rewrite is diffed against the CURRENT body for display, but the exact body is
    // kept in fullText so apply writes it verbatim (no diff round-trip).
    // Capture the body the agent's edit is based on: its hash gates approval (staleness),
    // and the rewrite path diffs against it for display.
    const body = documentBody(await readFile(docPath, "utf8"), docPath);
    let edits: EditHunk[] = pe.hunks ?? [];
    let fullText: string | undefined;
    if (pe.fullRewrite !== undefined) {
      fullText = pe.fullRewrite;
      edits = diffToHunks(body, pe.fullRewrite);
    }
    const id = `${threadId}#p${(await listProposals(docPath, threadId)).length + 1}`;
    await addProposal(docPath, {
      id,
      threadId,
      edits,
      ...(fullText !== undefined ? { fullText } : {}),
      baseHash: bodyHash(body),
      rationale: pe.rationale,
      status: "pending",
      delivered: false,
      at: this.deps.now(),
    });
    onToken?.({
      type: "proposal",
      text: JSON.stringify({
        id,
        threadId,
        edits,
        rationale: pe.rationale,
        ...(fullText !== undefined ? { fullText } : {}),
      }),
    });
    };
    this.proposalWriteChain = this.proposalWriteChain.then(write, write);
    await this.proposalWriteChain;
  }

  /**
   * Persist a markdown Improve rewrite as a legacy single-span proposal (`newText`, no
   * `edits`/`fullText`) and return its id, so Apply routes through `approveProposal`'s
   * back-compat branch (`applyLegacySpan`) exactly like an on-disk legacy proposal —
   * one apply path instead of a separate unpersisted RPC. Serialized on the SAME write
   * chain as `persistProposal` so concurrent proposal writes for one doc never race.
   */
  private async persistLegacyProposal(
    docPath: string,
    threadId: string,
    newText: string,
  ): Promise<string> {
    let id = "";
    const write = async (): Promise<void> => {
      id = `${threadId}#p${(await listProposals(docPath, threadId)).length + 1}`;
      await addProposal(docPath, {
        id,
        threadId,
        edits: [],
        newText,
        rationale: "",
        status: "pending",
        delivered: false,
        at: this.deps.now(),
      });
    };
    this.proposalWriteChain = this.proposalWriteChain.then(write, write);
    await this.proposalWriteChain;
    return id;
  }

  /**
   * Build the deferred reject-feedback prefix for a thread: any proposals the reviewer
   * REJECTED but that haven't yet been delivered to the agent. Mirrors the mid-thread
   * stance re-injection — the prefix rides along with the NEXT agent message, and each
   * rejection is marked delivered so it's sent exactly once. Returns "" when none pend.
   */
  private async rejectFeedbackPrefix(
    docPath: string,
    threadId: string,
  ): Promise<string> {
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
   * Approve a pending proposal: apply it to the doc, then mark approved. Rewrite mode
   * writes the exact kept body; hunk mode splices each oldText→newText. Frontmatter is
   * preserved. A legacy single-span proposal (newText only) takes the old anchored path.
   */
  async approveProposal(
    docPath: string,
    threadId: string,
    proposalId: string,
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
    // Back-compat: legacy single-span proposal (newText, no edits/fullText) → anchor-
    // resolved apply (see applyLegacySpan), not hunk matching.
    if (p.fullText === undefined && (!p.edits || p.edits.length === 0) && p.newText !== undefined) {
      await this.applyLegacySpan(docPath, threadId, p.newText);
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
    // baseHash, so the guard is skipped for them.
    if (p.baseHash !== undefined && bodyHash(body) !== p.baseHash) {
      throw new Error(
        "the document changed since this edit was proposed — discard it and ask the agent again",
      );
    }
    if (htmlDoc && p.fullText === undefined) this.assertHtmlHunksSafe(p.edits);
    const newBody = p.fullText !== undefined ? p.fullText : this.applyHunks(body, p.edits);
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
    // Unlike the legacy single-span path (applyLegacySpan), this path intentionally leaves the
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
   * Apply hunks to `body`. Resolves each hunk in list order with a FORWARD CURSOR, so a
   * duplicate `oldText` maps to SUCCESSIVE occurrences — the same way the editor's display
   * scans — instead of every duplicate hitting the first occurrence (which would let the
   * backend edit a different occurrence than the reviewer saw). Resolved spans are strictly
   * increasing, so they can never overlap; splicing descending keeps earlier offsets valid.
   * Atomic: throws before any mutation if a hunk has no anchor or its text isn't found, so
   * the caller's status stays pending.
   */
  private applyHunks(body: string, edits: EditHunk[]): string {
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

  private assertHtmlHunksSafe(edits: EditHunk[]): void {
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

  /**
   * Reject a pending proposal. The doc is left untouched; the proposal is marked rejected
   * but stays undelivered, so its feedback is queued to ride along with the user's NEXT
   * reply (see rejectFeedbackPrefix), not pushed to the agent immediately.
   */
  async rejectProposal(
    docPath: string,
    threadId: string,
    proposalId: string,
  ): Promise<void> {
    const p = (await listProposals(docPath, threadId)).find((x) => x.id === proposalId);
    if (!p) throw new Error(`proposal not found: ${proposalId}`);
    // Same idempotency guard as approveProposal (see its comment): without it, a stray
    // reject on an already-APPROVED proposal would silently flip its status to "rejected"
    // even though the edit is already applied to the doc — corrupting the record (and
    // rejectFeedbackPrefix would later tell the agent an applied edit was rejected).
    if (p.status !== "pending") {
      throw new Error(`proposal already ${p.status}`);
    }
    await updateProposal(docPath, proposalId, { status: "rejected" });
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
   *    annotation (200-char agent-reply slice); `allowEdit`/`conversationOnly` forced off.
   *  - `directiveMode` (inline `[[ … ]]` directives): no digest at all; doc text/scope/
   *    settings come from `opts.shared` (resolveDirectives reads the doc once and fans
   *    out one context per directive against that same read); `allowEdit`/
   *    `conversationOnly` forced off.
   *
   * Phase 10: `allowEdit` is now unconditionally false out of this builder — RECORD this
   * semantic change prominently. `settings.agentEdit === "direct"` used to flow straight
   * into `allowEdit` here, which is what let discuss/reply/panel write the document
   * directly; conversation turns must never edit now, under any setting. The setting's
   * only remaining conceptual scope is the explicit flows (resolveDirectives, Improve —
   * "apply-directly vs propose"), but neither currently reads it either (both are
   * propose-only today), so `agentEdit` currently has NO live effect anywhere in docd. It
   * stays on `HadSettings` for forward-compat and the desktop settings UI. See
   * had/settings.ts's `agentEdit` doc comment and the Task 1 report for the same note.
   */
  private async buildContext(opts: BuildContextOpts): Promise<AgentContext> {
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
      scopeDir = settings.scope === "repo" ? findRepoRoot(folder) : folder;
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
      // Phase 10: always false here (never read from settings.agentEdit) — see this
      // method's doc comment for the recorded semantic change.
      allowEdit: false,
      conversationOnly,
      ...(opts.reviewMode ? { reviewMode: true } : {}),
      htmlMode: isHtmlDoc(docPath),
      docToolchain: resolveDocToolchain(docPath),
      modelId: opts.modelId ?? settings.model,
      cancelKey: this.cancelKey(docPath, opts.threadId),
    };
  }

  /**
   * In direct-edit mode the agent may write the doc via its tools. Detect that,
   * snapshot before+after for undo, and tell the UI to reload.
   */
  private async detectDirectEdit(
    docPath: string,
    threadId: string,
    before: string,
    onToken?: TokenSink,
  ): Promise<void> {
    // Read the current (post-agent-write) content once, up front — it doubles as the
    // skipIfUnchanged comparison value AND the "agent-edit" snapshot content, so
    // withEditSnapshot never re-reads disk for a mutate() that's a no-op here.
    const current = await readFile(docPath, "utf8");
    const changed = await withEditSnapshot(
      this.deps,
      docPath,
      threadId,
      async () => {
        /* no-op: the agent already wrote the doc directly before this ran */
      },
      { before, after: current, skipIfUnchanged: true },
    );
    if (changed) onToken?.({ type: "docChanged", text: "" });
  }

  /**
   * Snapshot the current doc (deduped) and return its version id — the doc version a
   * turn is "grounded in". Both the you- and agent-turn of one exchange share this id,
   * even when the agent then direct-edits the doc (that edit produces a LATER version).
   * Stamping the agent turn with its base (not post-edit) version is deliberate and
   * load-bearing: branch(baseDoc:"at-turn") restores `turn.docVersion` to reconstruct
   * the doc the turn was reasoning about. Do not "fix" it to the post-edit version.
   */
  private async currentDocVersion(docPath: string): Promise<string> {
    const content = await readFile(docPath, "utf8");
    const v = await snapshot(docPath, content, { cause: "turn-base", at: this.deps.now() });
    return v.id;
  }

  /**
   * The per-invoke core every agent turn shares, regardless of who's bracketing it:
   * buildContext → afterContext → (pre-invoke direct-edit snapshot, if enabled) → invoke →
   * append the agent turn. `runTurn` wraps this with its own you-turn/transitions/
   * persistProposal/detectDirectEdit for callers with exactly one invoke per call (discuss/
   * reply/resumeFromTranscript/branch); `panel` calls this directly, once per model, so its
   * own try/catch can bracket the whole per-model loop with ONE you-turn and ONE running/
   * responded/error transition instead of one pair per invoke. `resolveDirectives` also
   * calls this directly, once per directive: its `invoke` closure substitutes its own
   * no-agent-text fallback into the turn BEFORE returning it (this method appends
   * `turn.reply` verbatim, so the fallback has to already be applied), and its own try/catch
   * swallows a directive's failure (`recordAgentError`) instead of rethrowing.
   *
   * `before` is the pre-invoke doc snapshot a caller can use for its own direct-edit
   * detection (null when `skipDetectDirectEdit` is set or the context doesn't allow edits).
   * It's captured here, between `afterContext` and `invoke`, to preserve the exact read
   * timing the pre-extraction `runTurn` always used — do not move it relative to those two
   * calls. `runTurn` reads it off the return value and calls `detectDirectEdit` itself
   * afterward; `panel` always passes `skipDetectDirectEdit: true` and ignores it.
   * `resolveDirectives` never calls `detectDirectEdit` either, but doesn't need the flag —
   * directiveMode's `allowEdit: false` already short-circuits the read.
   */
  private async runAgentStep(
    docPath: string,
    runner: AgentRunner,
    spec: {
      threadId: string;
      /** meta stamped on the agent turn — the effective stance, or (panel) the model id. */
      agentMeta: string;
      /** Already-resolved docVersion to stamp on the agent turn; caller owns the 3-way override logic. */
      docVersion?: string;
      context: BuildContextOpts;
      invoke: (
        runner: AgentRunner,
        ctx: AgentContext,
        onToken?: TokenSink,
      ) => Promise<{ turn: AgentTurn; sessionId: string }>;
      onToken?: TokenSink;
      afterContext?: (ctx: AgentContext) => void;
      skipDetectDirectEdit?: boolean;
    },
  ): Promise<{
    turn: AgentTurn;
    agentTurn: ThreadTurn;
    sessionId: string;
    context: AgentContext;
    before: string | null;
  }> {
    const context = await this.buildContext(spec.context);
    spec.afterContext?.(context);
    const before =
      !spec.skipDetectDirectEdit && context.allowEdit ? await readFile(docPath, "utf8") : null;
    const { turn, sessionId } = await spec.invoke(runner, context, spec.onToken);
    const agentTurn: ThreadTurn = {
      role: "agent",
      timestamp: this.deps.now(),
      meta: spec.agentMeta,
      docVersion: spec.docVersion,
      ...(turn.thinking ? { thinking: turn.thinking } : {}),
      body: turn.reply,
    };
    await appendTurn(docPath, spec.threadId, agentTurn);
    return { turn, agentTurn, sessionId, context, before };
  }

  /**
   * The shared agent-turn lifecycle for a caller with exactly one you-turn and one invoke:
   * harness resolve → doc-version snapshot → append you-turn → transition(running) →
   * `runAgentStep` (buildContext → afterContext → invoke → append agent-turn) →
   * transition(responded) → persistProposal → detectDirectEdit; on invoke failure it
   * transitions to error (with frontmatter) and rethrows the original value unchanged.
   * Method-unique pre-work (thread init vs load, stance switch, reject-feedback prefix,
   * live-vs-resume routing, fork/thread-copy) stays in the caller; the differences that vary
   * the spine arrive as TurnSpec fields (youTurn body, agent meta, context opts, the invoke
   * closure, the pre-invoke session id, and the opt-in `docVersion`/`skipProposalPersist`/
   * `skipDetectDirectEdit`/`afterContext` seams), never as a branch on which method is
   * calling. `panel` doesn't call this at all — its per-model loop needs its OWN you-turn/
   * transition bracketing around N invokes, so it calls `runAgentStep` directly instead (see
   * that method's doc comment). `resolveDirectives` also skips this entirely, for two
   * reasons: its per-directive turn's `persistProposal` write has always preceded its
   * responded transition (this engine always does the opposite order), and a directive's
   * failure is swallowed + recorded (`recordAgentError`), never rethrown — so it calls
   * `runAgentStep` directly, once per directive, with its own you-turn/transition/persist
   * bracketing (see that method's doc comment).
   *
   * review stays on its bespoke path (not converted): it transitions/appends around its
   * invoke BEFORE creating its own "review" thread — `runAgentStep`'s `appendTurn` requires
   * the thread to already exist, which it deliberately doesn't yet at invoke time (see the
   * `transition` test asserting this thread's frontmatter is set directly by the later
   * `initThread` call, never by a `frontmatter:true` transition) — and then fans one turn
   * into many per-finding child threads; it isn't a single-thread turn at all. Its error path
   * is a different shape too: a failed pass replaces the (not-yet-existing) "review" thread
   * with a minimal system-note-only transcript via `recordAgentError`, not a transition on an
   * existing one.
   */
  private async runTurn(
    docPath: string,
    spec: TurnSpec,
  ): Promise<{ turn: AgentTurn; sessionId: string }> {
    const { db, now } = this.deps;
    const { threadId } = spec;
    const runner = (await this.harnessForDoc(docPath, spec.preferredHarness)).runner;

    const docVersionOverride = spec.docVersion;
    const docVersion: string | undefined =
      docVersionOverride !== undefined
        ? (docVersionOverride ?? undefined)
        : await this.currentDocVersion(docPath);

    await appendTurn(docPath, threadId, {
      role: "you",
      timestamp: now(),
      meta: this.deps.author,
      docVersion,
      body: spec.youTurn.body,
    });

    // A live/resumed session (reply) rides through the running + error transitions; a fresh
    // start (discuss/resumeFromTranscript/branch) has none yet, so those record null until
    // invoke returns the minted id.
    let sessionId: string | null = spec.sessionId ?? null;
    await transition({ db, docPath }, threadId, "running", { piSessionId: sessionId });

    let turn: AgentTurn;
    let before: string | null;
    try {
      const step = await this.runAgentStep(docPath, runner, {
        threadId,
        agentMeta: spec.agentMeta,
        docVersion,
        context: spec.context,
        invoke: spec.invoke,
        onToken: spec.onToken,
        afterContext: spec.afterContext,
        skipDetectDirectEdit: spec.skipDetectDirectEdit,
      });
      turn = step.turn;
      sessionId = step.sessionId;
      before = step.before;
    } catch (e) {
      await transition({ db, docPath }, threadId, "error", {
        piSessionId: sessionId,
        frontmatter: true,
        error: errorSummary(e),
      });
      throw e;
    }

    await transition({ db, docPath }, threadId, "responded", {
      piSessionId: sessionId,
      frontmatter: true,
    });
    if (!spec.skipProposalPersist) {
      await this.persistProposal(docPath, spec.ann, turn, spec.onToken);
    }
    if (!spec.skipDetectDirectEdit && before !== null) {
      await this.detectDirectEdit(docPath, threadId, before, spec.onToken);
    }
    return { turn, sessionId };
  }

  async discuss(docPath: string, args: DiscussArgs, onToken?: TokenSink): Promise<void> {
    const harness = await this.harnessForDoc(docPath);
    const ann = (await readAnnotations(docPath)).annotations.find(
      (a) => a.id === args.annotationId,
    );
    if (!ann) throw new Error(`annotation not found: ${args.annotationId}`);

    // Fresh thread: create it (stance/harness/model on the frontmatter) before the shared
    // spine appends the you-turn into it.
    const resolvedModel = args.modelId ?? (await readSettings(docPath)).model;
    await initThread(docPath, {
      id: args.threadId,
      anchorExact: ann.anchor.exact,
      stance: args.stance,
      status: "running",
      piSession: `sessions/${args.threadId}.session.jsonl`,
      harness: harness.id,
      ...(resolvedModel ? { model: resolvedModel } : {}),
    });

    await this.runTurn(docPath, {
      threadId: args.threadId,
      ann,
      youTurn: { body: args.comment },
      agentMeta: args.stance,
      context: {
        docPath,
        ann,
        threadId: args.threadId,
        annotationId: args.annotationId,
        stance: args.stance,
        comment: args.comment,
        modelId: args.modelId,
      },
      invoke: (runner, ctx, onToken) => runner.start(ctx, onToken),
      onToken,
    });
  }

  /**
   * Mode B fan-out: run one comment through each configured model SEQUENTIALLY, each
   * in its own fresh session, and persist one agent turn per model (meta = the model id).
   * Streamed tokens are TAGGED with the producing model so the UI can fan them into
   * per-model panes. Sequential + awaited means the model→turn mapping is deterministic.
   * Doesn't go through `runTurn` (one you-turn, N invokes, one terminal transition — not the
   * one-you-turn-per-invoke shape `runTurn` assumes): it calls the shared `runAgentStep`
   * core directly, once per model, and owns its own running/responded/error bracketing
   * around the whole loop. The harness is resolved ONCE up front (not re-resolved per
   * model), so every model's invoke shares the identical runner instance.
   */
  async panel(
    docPath: string,
    args: DiscussArgs,
    modelIds: string[],
    onToken?: TokenSink,
  ): Promise<void> {
    const { db, now } = this.deps;
    const harness = await this.harnessForDoc(docPath);
    const runner = harness.runner;
    const ann = (await readAnnotations(docPath)).annotations.find(
      (a) => a.id === args.annotationId,
    );
    if (!ann) throw new Error(`annotation not found: ${args.annotationId}`);

    const docVersion = await this.currentDocVersion(docPath);

    await initThread(docPath, {
      id: args.threadId,
      anchorExact: ann.anchor.exact,
      stance: args.stance,
      status: "running",
      piSession: `sessions/${args.threadId}.session.jsonl`,
      harness: harness.id,
    });
    await appendTurn(docPath, args.threadId, {
      role: "you",
      timestamp: now(),
      meta: this.deps.author,
      docVersion,
      body: args.comment,
    });
    await transition({ db, docPath }, args.threadId, "running", { piSessionId: null });

    let lastSessionId: string | null = null;
    try {
      for (const mid of modelIds) {
        const tagged: TokenSink | undefined = onToken
          ? (e) => onToken({ ...e, model: mid })
          : undefined;
        // Each model's turn goes through the shared runAgentStep core (buildContext→invoke→
        // append-agent), sharing panel's ONE you-turn/docVersion/runner and skipping
        // detectDirectEdit (panel never did either, and never called persistProposal, which
        // isn't part of runAgentStep at all); panel's own try/catch around this loop owns
        // the running/responded/error bracketing instead of one pair per model.
        const { sessionId } = await this.runAgentStep(docPath, runner, {
          threadId: args.threadId,
          agentMeta: mid,
          docVersion,
          context: {
            docPath,
            ann,
            threadId: args.threadId,
            annotationId: args.annotationId,
            stance: args.stance,
            comment: args.comment,
            modelId: mid,
          },
          invoke: (runner, ctx, tok) => runner.start(ctx, tok),
          skipDetectDirectEdit: true,
          onToken: tagged,
        });
        lastSessionId = sessionId;
      }
    } catch (e) {
      await transition({ db, docPath }, args.threadId, "error", {
        piSessionId: lastSessionId,
        frontmatter: true,
        error: errorSummary(e),
      });
      throw e;
    }

    await transition({ db, docPath }, args.threadId, "responded", {
      piSessionId: lastSessionId,
      frontmatter: true,
    });
  }

  /**
   * Document-wide Agent Review Pass. The agent reads the whole doc and emits findings
   * via add_review_finding; each finding becomes an agent-authored comment annotation
   * (its own thread) plus, when it carries an edit, a pending proposal reviewed through
   * the normal approve/reject path. The agent never writes the document directly.
   *
   * Doesn't use `runTurn`/`runAgentStep`: the umbrella "review" thread is only created
   * (via `initThread`) AFTER the running/responded transitions around the invoke complete,
   * so nothing exists yet for `runAgentStep`'s `appendTurn` to write into, and a failed pass
   * produces a wholly different system-note-only transcript (`recordAgentError`) instead of
   * transitioning an existing thread to "error" — see `runTurn`'s doc comment.
   */
  async review(
    docPath: string,
    args: ReviewArgs,
    onToken?: TokenSink,
  ): Promise<{ batchId: string; findings: MaterializedFinding[] }> {
    const { db, now } = this.deps;
    const harness = await this.harnessForDoc(docPath);
    const runner = harness.runner;
    const context = await this.buildContext({
      docPath,
      threadId: "review",
      stance: args.stance,
      comment: args.rubric?.trim()
        ? args.rubric
        : "Review the document for risks, gaps, unclear passages, and concrete improvements.",
      modelId: args.modelId,
      reviewMode: true,
    });
    // Surface the review as a live agent task while the model works.
    await transition({ db, docPath }, "review", "running", { piSessionId: null });
    let reviewStarted: Awaited<ReturnType<typeof runner.start>>;
    try {
      reviewStarted = await runner.start(context, onToken);
    } catch (e) {
      await transition({ db, docPath }, "review", "error", {
        piSessionId: null,
        error: errorSummary(e),
      });
      await this.recordAgentError(docPath, "review", "Review pass", e);
      throw e;
    }
    const { sessionId, turn } = reviewStarted;
    await transition({ db, docPath }, "review", "responded", { piSessionId: sessionId });
    // Openable umbrella thread for the review pass (findings are also filed as comments).
    await initThread(docPath, {
      id: "review",
      anchorExact: "",
      stance: args.stance,
      status: "responded",
      piSession: "sessions/review.session.jsonl",
      harness: harness.id,
    });
    await appendTurn(docPath, "review", { role: "you", timestamp: now(), body: context.comment });
    await appendTurn(docPath, "review", {
      role: "agent",
      timestamp: now(),
      meta: "review",
      ...(turn.thinking ? { thinking: turn.thinking } : {}),
      body: turn.reply || "(findings filed as comments)",
    });

    const batchId = `review:${now()}`;
    const findings = turn.findings ?? [];
    const body = matter(await readFile(docPath, "utf8")).content;
    const anns = (await readAnnotations(docPath)).annotations;
    const out: MaterializedFinding[] = [];

    for (const f of findings) {
      const id = nextAnnotationId(anns);
      const at = body.indexOf(f.anchorText);
      const anchor =
        at >= 0
          ? createAnchor(body, at, at + f.anchorText.length)
          : { exact: f.anchorText, prefix: "", suffix: "" };
      const status = at >= 0 ? "open" : "orphaned";

      const annotation: Annotation = {
        id,
        type: "comment",
        anchor,
        status: status as Annotation["status"],
        thread: `threads/${id}.md`,
        session: `sessions/${id}.session.jsonl`,
        createdAt: now(),
        origin: "agent",
        review: {
          batchId,
          ...(f.severity ? { severity: f.severity } : {}),
          ...(f.kind ? { kind: f.kind } : {}),
        },
      };
      await addAnnotation(docPath, annotation);
      anns.push(annotation);

      // Seed the thread: a system note for provenance + the agent's finding comment,
      // so the margin card and chat both show it and replies continue the discussion.
      await initThread(docPath, {
        id,
        anchorExact: anchor.exact,
        stance: args.stance,
        status: "open",
        piSession: `sessions/${id}.session.jsonl`,
        harness: harness.id,
        ...(context.modelId ? { model: context.modelId } : {}),
      });
      await appendTurn(docPath, id, {
        role: "system",
        timestamp: now(),
        body: `Review finding${f.severity ? ` · ${f.severity}` : ""}${f.kind ? ` · ${f.kind}` : ""}.`,
      });
      await appendTurn(docPath, id, {
        role: "agent",
        timestamp: now(),
        meta: args.stance,
        body: f.comment,
      });
      await transition({ db, docPath }, id, "responded", { piSessionId: sessionId });

      // If the finding proposes a concrete edit, persist it as a pending proposal on
      // this thread (reusing the normal proposal pipeline). Streamed as a finding event
      // below, not via persistProposal's own event, so the UI gets exactly one per finding.
      let proposalId: string | undefined;
      if ((f.edits && f.edits.length) || f.fullRewrite !== undefined) {
        const proposal: ProposedEdit = {
          rationale: f.comment,
          ...(f.edits && f.edits.length ? { hunks: f.edits } : {}),
          ...(f.fullRewrite !== undefined ? { fullRewrite: f.fullRewrite } : {}),
        };
        await this.persistProposal(docPath, annotation, { proposal });
        const ps = await listProposals(docPath, id);
        proposalId = ps[ps.length - 1]?.id;
      }

      const materialized: MaterializedFinding = {
        annotationId: id,
        status,
        ...(f.severity ? { severity: f.severity } : {}),
        ...(f.kind ? { kind: f.kind } : {}),
        ...(proposalId ? { proposalId } : {}),
      };
      out.push(materialized);
      onToken?.({
        type: "finding",
        text: JSON.stringify({
          ...materialized,
          anchor,
          comment: f.comment,
          ...(f.edits ? { edits: f.edits } : {}),
          ...(f.fullRewrite !== undefined ? { fullRewrite: f.fullRewrite } : {}),
        }),
      });
    }

    return { batchId, findings: out };
  }

  /**
   * Inline-directive pass: find `[[ … ]]` markers in the document and launch one agent
   * task per directive. Each task gets local context around its directive plus the full
   * doc, persists an openable transcript, and emits a normal proposal event if it proposes.
   *
   * Like `panel`, each directive's turn calls the shared `runAgentStep` core directly
   * instead of going through `runTurn`: `runTurn`'s transition(responded) always runs
   * BEFORE `persistProposal`, but this method's proposal write has always preceded its
   * responded transition, so it keeps its own you-turn/transition/persist bracketing (in
   * that order) around the `runAgentStep` call. Its `invoke` closure folds the method's own
   * no-agent-text fallback into the turn that gets PERSISTED (`runAgentStep` appends
   * `turn.reply` verbatim, so the fallback has to be applied before it sees the turn), while
   * `rawReply` keeps the un-substituted text for this method's OWN returned summary, which
   * has never applied that fallback. A directive's failure is swallowed (`recordAgentError`)
   * and does not abort the other directives' jobs — this is why it can't route through
   * `runTurn`, which always rethrows.
   */
  async resolveDirectives(
    docPath: string,
    onToken?: TokenSink,
  ): Promise<{ count: number; proposed: boolean; reply: string }> {
    const { db, now } = this.deps;
    const harness = await this.harnessForDoc(docPath);
    const runner = harness.runner;
    const body = matter(await readFile(docPath, "utf8")).content;
    const directives = findDirectives(body);
    if (directives.length === 0) return { count: 0, proposed: false, reply: "" };

    const settings = await readSettings(docPath);
    const folder = dirname(docPath);
    const scopeDir = settings.scope === "repo" ? findRepoRoot(folder) : folder;
    const docText =
      body.length > DOC_TEXT_BUDGET ? body.slice(0, DOC_TEXT_BUDGET) + "\n…[truncated]" : body;

    const jobs = directives.map(async (d, i) => {
      const threadId = `directive-${i + 1}`;
      const prefix = body.slice(Math.max(0, d.index - 500), d.index);
      const suffix = body.slice(d.index + d.marker.length, d.index + d.marker.length + 500);
      const prompt =
        "Resolve this ONE inline directive. Make the requested change and remove its" +
        " [[ … ]] marker. Call propose_edit with a focused edit whose `oldText` is copied" +
        " VERBATIM from the current document (include the directive marker and enough" +
        " surrounding text to be unique), and whose `newText` is the revised text with the" +
        " marker removed. Do not change unrelated text.\n\n" +
        `Directive marker:\n${d.marker}\n\nInstruction:\n${d.instruction}\n\nLocal context:\n${prefix}${d.marker}${suffix}`;

      const ann: Annotation = {
        id: threadId,
        type: "comment",
        anchor: { exact: d.marker, prefix, suffix },
        status: "open",
        thread: `threads/${threadId}.md`,
        session: `sessions/${threadId}.session.jsonl`,
        createdAt: now(),
      };

      await transition({ db, docPath }, threadId, "running", { piSessionId: null });
      await initThread(docPath, {
        id: threadId,
        anchorExact: d.marker,
        stance: "none",
        status: "running",
        piSession: `sessions/${threadId}.session.jsonl`,
        harness: harness.id,
      });
      await appendTurn(docPath, threadId, {
        role: "you",
        timestamp: now(),
        body: `Resolve inline directive:\n${d.marker}\n\n${d.instruction}`,
      });

      try {
        let rawReply = "";
        const { turn, sessionId } = await this.runAgentStep(docPath, runner, {
          threadId,
          agentMeta: "directives",
          context: {
            docPath,
            threadId,
            anchorExact: d.marker,
            surrounding: `${prefix}${d.marker}${suffix}`,
            comment: prompt,
            stance: "none",
            directiveMode: true,
            shared: { docText, scopeDir, settings },
          },
          invoke: async (r, ctx, tok) => {
            const started = await r.start(ctx, tok);
            rawReply = started.turn.reply ?? "";
            return {
              turn: {
                ...started.turn,
                reply: started.turn.reply || "(the agent returned no text and no edit)",
              },
              sessionId: started.sessionId,
            };
          },
          onToken,
        });
        await this.persistProposal(docPath, ann, turn, onToken);
        await transition({ db, docPath }, threadId, "responded", {
          piSessionId: sessionId,
          frontmatter: true,
        });
        return { proposed: turn.proposal !== undefined, reply: rawReply };
      } catch (e) {
        await transition({ db, docPath }, threadId, "error", {
          piSessionId: null,
          error: errorSummary(e),
        });
        await this.recordAgentError(docPath, threadId, `Resolve inline directive ${i + 1}`, e);
        return { proposed: false, reply: `Error: ${(e as Error).message}` };
      }
    });

    const results = await Promise.all(jobs);
    return {
      count: directives.length,
      proposed: results.some((r) => r.proposed),
      reply: results.map((r, i) => `Directive ${i + 1}: ${r.reply}`).join("\n\n"),
    };
  }

  async reply(
    docPath: string,
    threadId: string,
    message: string,
    onToken?: TokenSink,
    stance?: string,
    modelId?: string,
  ): Promise<void> {
    let thread = await readThread(docPath, threadId);
    const harness = await this.harnessForDoc(docPath, thread.frontmatter.harness);
    const sid = this.liveSessionId(threadId, harness);
    if (!sid) {
      // The live pi session is gone — either after a doc reopen (the thread
      // transcript persists but the in-memory session does not) or because a
      // sidecar restart left a stale id the runner no longer holds. Rebuild a
      // fresh session seeded with the prior turns as replayable history, then continue.
      return this.resumeFromTranscript(docPath, threadId, message, onToken, stance, modelId);
    }
    // Directive/review-umbrella threads (and any other thread with no persisted
    // annotation) reply with no highlight/surrounding — `buildContext` already knows how
    // to build a context with an absent `ann` (it does exactly this for reviewMode/
    // directiveMode at creation time; see its comment). A missing THREAD (the
    // `readThread` above) is still the identity check and still errors; a missing
    // ANNOTATION for an existing thread no longer does.
    const ann = (await readAnnotations(docPath)).annotations.find((a) => a.id === threadId);

    // Mid-thread stance change: persist it and prepend the new instruction so the
    // already-running agent session actually adopts the new stance.
    let agentMessage = message;
    if (stance && stance !== thread.frontmatter.stance) {
      await this.switchStance(docPath, threadId, stance);
      thread = await readThread(docPath, threadId);
      agentMessage = `(Your stance is now — ${stancePrompt(stance)})\n\n${message}`;
    }

    // Deferred reject feedback: any earlier proposal the reviewer rejected rides along
    // with this reply (once). Prepend it ahead of the stance prefix so the agent reads
    // "don't repeat these rejected edits" before the new instruction.
    const rejectPrefix = await this.rejectFeedbackPrefix(docPath, threadId);
    if (rejectPrefix) agentMessage = rejectPrefix + agentMessage;

    await this.runTurn(docPath, {
      threadId,
      ann: ann ?? this.syntheticAnnotation(threadId),
      preferredHarness: thread.frontmatter.harness,
      sessionId: sid,
      youTurn: { body: message },
      agentMeta: thread.frontmatter.stance,
      context: {
        docPath,
        ann,
        threadId,
        annotationId: threadId,
        stance: thread.frontmatter.stance,
        comment: message,
        modelId,
      },
      // Live session: continue it with the prefixed message; the built context is unused by
      // send() but its allowEdit still governs direct-edit detection. Reuse the same sid.
      invoke: async (runner, _ctx, tok) => ({
        turn: await runner.send(sid, agentMessage, tok),
        sessionId: sid,
      }),
      onToken,
    });
  }

  /**
   * Resume a thread whose live pi session is gone (e.g. after a doc reopen): start a
   * FRESH agent session seeded with the existing transcript as replayable history, then
   * continue the discussion. Mirrors the live reply() path (stance change, turn stamping,
   * direct-edit detection) but uses runner.start() with history instead of runner.send().
   */
  private async resumeFromTranscript(
    docPath: string,
    threadId: string,
    message: string,
    onToken?: TokenSink,
    stance?: string,
    modelId?: string,
  ): Promise<void> {
    let thread = await readThread(docPath, threadId);

    // Capture the prior transcript as history BEFORE appending the new user turn.
    const prior = thread.turns
      .filter((t) => t.role !== "system")
      .map((t) => ({ role: t.role as "you" | "agent", body: t.body }));

    // See reply()'s identical comment: a missing annotation is tolerated here too — the
    // thread's existence, checked above via `readThread`, is the real identity check.
    const ann = (await readAnnotations(docPath)).annotations.find((a) => a.id === threadId);

    // Mid-thread stance change: persist it and reason with the new stance from here on.
    let effectiveStance = thread.frontmatter.stance;
    if (stance && stance !== thread.frontmatter.stance) {
      await this.switchStance(docPath, threadId, stance);
      thread = await readThread(docPath, threadId);
      effectiveStance = stance;
    }

    // Deferred reject feedback rides along with this (resumed) reply, once. Prepend it
    // to the comment so the fresh session reads it ahead of the new instruction.
    const rejectPrefix = await this.rejectFeedbackPrefix(docPath, threadId);
    const agentComment = rejectPrefix + message;

    await this.runTurn(docPath, {
      threadId,
      ann: ann ?? this.syntheticAnnotation(threadId),
      preferredHarness: thread.frontmatter.harness,
      youTurn: { body: message },
      agentMeta: effectiveStance,
      context: {
        docPath,
        ann,
        threadId,
        annotationId: threadId,
        stance: effectiveStance,
        comment: agentComment,
        // Effective model: explicit override, else the model this thread already used,
        // else (via buildContext) the per-doc settings default, else the runner default.
        modelId: modelId ?? thread.frontmatter.model,
      },
      // Fresh session seeded with the prior transcript as replayable history. The stance
      // flows in through buildContext's stancePrompt (no need for the live path's
      // "(Your stance is now …)" preamble, which steers a running one).
      afterContext: (ctx) => {
        ctx.history = prior;
      },
      invoke: (runner, ctx, tok) => runner.start(ctx, tok),
      onToken,
    });
  }

  /**
   * Resolve the base doc text + version a branch is grounded in, per `opts.doc`:
   * "latest" reads the current doc (and its latest snapshot id); "at-turn" restores
   * the doc version the edited turn was reasoning about.
   */
  private async resolveBaseDoc(
    docPath: string,
    editPoint: { docVersion?: string },
    opts: { doc: "latest" | "at-turn" },
  ): Promise<{ baseText: string; baseVersion?: string }> {
    if (opts.doc === "at-turn") {
      const baseVersion = editPoint.docVersion;
      // A "you" turn from discuss/reply is always docVersion-stamped; an unset version
      // means a pre-versioning thread, so we degrade to the current doc (baseVersion
      // stays unset, matching the doc we actually grounded on).
      const baseText = baseVersion
        ? await readVersion(docPath, baseVersion)
        : await readFile(docPath, "utf8");
      return { baseText, baseVersion: baseVersion ?? undefined };
    }
    const baseText = await readFile(docPath, "utf8");
    const baseVersion = (await latestVersionId(docPath)) ?? undefined;
    return { baseText, baseVersion };
  }

  /**
   * Fork a new thread from an earlier "you" turn of `parentThreadId`, editing that
   * message and resuming from there. The branch is purely additive: the parent thread
   * is never modified. `opts.doc` selects the doc the new thread reasons about —
   * "latest" (current doc) or "at-turn" (the doc version active when that turn was made).
   * Prior turns (before the edited one) are copied verbatim and replayed as history.
   */
  async branch(
    docPath: string,
    parentThreadId: string,
    atTurnIndex: number,
    editedMessage: string,
    opts: { doc: "latest" | "at-turn"; modelId?: string },
    onToken?: TokenSink,
  ): Promise<{ branchThreadId: string }> {
    const { now } = this.deps;

    const parent = await readThread(docPath, parentThreadId);
    const harness = await this.harnessForDoc(docPath, parent.frontmatter.harness);
    const editPoint = parent.turns[atTurnIndex];
    if (!editPoint || editPoint.role !== "you") {
      throw new Error(
        `branch point must be a "you" turn: ${parentThreadId}#${atTurnIndex}`,
      );
    }

    // Resolve the base doc text + version the branch is grounded in.
    const { baseText, baseVersion } = await this.resolveBaseDoc(docPath, editPoint, opts);

    const anns = (await readAnnotations(docPath)).annotations;
    const branchId = nextAnnotationId(anns);
    const parentAnn = anns.find((a) => a.id === parentThreadId);

    // Directive-N threads and the "review" umbrella (and any other thread with no
    // persisted annotation) fork with no anchor to inherit — mirrors reply()/
    // resumeFromTranscript's identical tolerance (see their comments): the thread's
    // EXISTENCE, checked above via readThread, is the real identity check; a missing
    // ANNOTATION for an existing parent no longer throws. The branch's own bookkeeping
    // annotation is still created either way: `nextAnnotationId` (and the thread-tree/
    // branch-navigator UI, which lists whatever's in annotations.json) depend on every
    // branch landing there, or a second annotation-less fork — including a fork OF this
    // fork — would collide on the SAME generated id. When there's nothing to inherit it
    // just degrades to an empty anchor; that degraded anchor is kept OUT of the prompt
    // context below, so the agent sees the same empty anchor/surrounding an
    // annotation-less reply() already builds.
    const branchAnn: Annotation = {
      id: branchId,
      type: parentAnn?.type ?? "comment",
      anchor: parentAnn?.anchor ?? { exact: parent.frontmatter.anchorExact, prefix: "", suffix: "" },
      status: "open",
      thread: `threads/${branchId}.md`,
      session: `sessions/${branchId}.session.jsonl`,
      createdAt: now(),
      ...(parentAnn?.color ? { color: parentAnn.color } : {}),
      ...(this.deps.author ? { author: this.deps.author } : {}),
    };
    await addAnnotation(docPath, branchAnn);

    // Effective model: explicit override, else the parent thread's model, else the
    // per-doc settings default; persisted on the branch and threaded into its context.
    const branchModel = opts.modelId ?? parent.frontmatter.model ?? (await readSettings(docPath)).model;

    await initThread(docPath, {
      id: branchId,
      anchorExact: branchAnn.anchor.exact,
      stance: parent.frontmatter.stance,
      status: "running",
      piSession: `sessions/${branchId}.session.jsonl`,
      harness: harness.id,
      ...(branchModel ? { model: branchModel } : {}),
      parent: parentThreadId,
      branchFromTurn: atTurnIndex,
      ...(baseVersion ? { baseVersion } : {}),
      baseDoc: opts.doc,
    });

    // Seed prior turns verbatim; the shared spine appends the edited "you" turn.
    for (const t of parent.turns.slice(0, atTurnIndex)) {
      await appendTurn(docPath, branchId, t);
    }

    const priorHistory = parent.turns
      .slice(0, atTurnIndex)
      .filter((t) => t.role !== "system")
      .map((t) => ({ role: t.role as "you" | "agent", body: t.body }));
    const baseBody = matter(baseText).content;
    const baseDocText =
      baseBody.length > DOC_TEXT_BUDGET
        ? baseBody.slice(0, DOC_TEXT_BUDGET) + "\n…[truncated]"
        : baseBody;

    await this.runTurn(docPath, {
      threadId: branchId,
      ann: branchAnn,
      preferredHarness: parent.frontmatter.harness,
      // The branch is grounded in the ALREADY-resolved base version, not a fresh snapshot
      // of the current doc — stamp it directly (or nothing, for a pre-versioning thread).
      docVersion: baseVersion ?? null,
      youTurn: { body: editedMessage },
      agentMeta: parent.frontmatter.stance,
      context: {
        docPath,
        // See the comment above `branchAnn`: when the PARENT had no persisted
        // annotation, the prompt context stays anchor-less too — buildContext
        // defaults anchorExact/surrounding to "" when `ann` is omitted, exactly
        // like reply()'s tolerant path. When it did, this is `branchAnn` exactly
        // as before — byte-identical anchored behavior.
        ann: parentAnn ? branchAnn : undefined,
        threadId: branchId,
        annotationId: branchId,
        stance: parent.frontmatter.stance,
        comment: editedMessage,
        modelId: branchModel,
      },
      // Reuse buildContext for digest/scope/anchor/allowEdit, then override the doc text
      // with the base version and attach prior turns as replayable history.
      afterContext: (ctx) => {
        ctx.docText = baseDocText;
        ctx.history = priorHistory;
      },
      invoke: (runner, ctx, tok) => runner.start(ctx, tok),
      skipProposalPersist: true,
      skipDetectDirectEdit: true,
      onToken,
    });

    return { branchThreadId: branchId };
  }

  /** Persist a minimal, openable transcript when a doc-wide pass fails, so the UI can show why. */
  private async recordAgentError(
    docPath: string,
    threadId: string,
    label: string,
    err: unknown,
  ): Promise<void> {
    try {
      await initThread(docPath, {
        id: threadId,
        anchorExact: "",
        stance: "none",
        status: "error",
        piSession: `sessions/${threadId}.session.jsonl`,
      });
      await appendTurn(docPath, threadId, {
        role: "system",
        timestamp: this.deps.now(),
        body: `${label} failed: ${(err as Error).message}`,
      });
    } catch {
      // best effort — never mask the original error
    }
  }

  /** Change a thread's stance mid-discussion. Records a system turn; next agent turn uses it. */
  async switchStance(docPath: string, threadId: string, stance: string): Promise<void> {
    const thread = await readThread(docPath, threadId);
    await appendTurn(docPath, threadId, {
      role: "system",
      timestamp: this.deps.now(),
      body: `Stance changed from ${thread.frontmatter.stance} to ${stance}.`,
    });
    await updateThreadFrontmatter(docPath, threadId, { stance });
  }

  /**
   * Ask the agent to rewrite the highlighted text using the discussion so far.
   * Returns the proposed replacement (not applied — the user reviews a diff first).
   */
  async improve(
    docPath: string,
    threadId: string,
    onToken?: TokenSink,
  ): Promise<{ newText: string; proposalId?: string }> {
    const ann = (await readAnnotations(docPath)).annotations.find((a) => a.id === threadId);
    if (!ann) throw new Error(`annotation not found: ${threadId}`);

    // Improve always starts a fresh session instead of resuming the warm discussion
    // session. Markdown asks for replacement text; HTML offers propose_edit so raw
    // source validation can run. Prior turns are replayed as history either way.
    let history: { role: "you" | "agent"; body: string }[] = [];
    let harnessId: string | undefined;
    try {
      const thread = await readThread(docPath, threadId);
      harnessId = thread.frontmatter.harness;
      history = thread.turns
        .filter((t) => t.role !== "system")
        .map((t) => ({ role: t.role as "you" | "agent", body: t.body }));
    } catch {
      // no thread file yet → un-discussed comment, no history to replay
    }
    const runner = (await this.harnessForDoc(docPath, harnessId)).runner;
    const discussed = history.some((t) => t.role === "agent");
    const htmlDoc = isHtmlDoc(docPath);

    const context = await this.buildContext({
      docPath,
      ann,
      threadId,
      annotationId: threadId,
      stance: "none",
      comment: improvePrompt(discussed, history, htmlDoc),
    });
    context.history = history;

    // Markdown Improve preserves the legacy replacement-text path: the reply IS the
    // replacement for the whole highlighted span, persisted as a legacy single-span
    // proposal (newText, no edits) so Apply goes through the SAME approveProposal path
    // (applyLegacySpan) as every other proposal, instead of a separate unpersisted RPC.
    // HTML Improve must go through structured hunk proposals so raw-source validation
    // protects the document before approval. Both branches force `conversationOnly:
    // false` — buildContext's anchored default is true (see its comment), but Improve is
    // an explicit edit flow, not a conversation turn, so it must not inherit the
    // conversation-only prompt/tool-policy gating.
    const { sessionId, turn } = await runner.start(
      htmlDoc
        ? { ...context, allowEdit: false, improveMode: true, conversationOnly: false }
        : { ...context, replacementOnly: true, improveMode: true, conversationOnly: false },
      onToken,
    );
    await transition({ db: this.deps.db, docPath }, threadId, "responded", {
      piSessionId: sessionId,
    });
    if (htmlDoc) {
      if (!turn.proposal) {
        throw new Error(
          "HTML Improve requires a structured proposal so the edit can be validated before approval",
        );
      }
      await this.persistProposal(docPath, ann, turn, onToken);
      const proposals = await listProposals(docPath, threadId);
      const proposalId = proposals.at(-1)?.id;
      return {
        newText: proposalPreview(turn.proposal),
        ...(proposalId ? { proposalId } : {}),
      };
    }
    const newText = turn.reply.trim();
    const proposalId = await this.persistLegacyProposal(docPath, threadId, newText);
    return { newText, proposalId };
  }

  /**
   * Ask the agent for a diagram (mermaid) that visualizes the highlighted text,
   * using the discussion so far. Returns the fenced code block (not applied).
   */
  async visualize(
    docPath: string,
    threadId: string,
    onToken?: TokenSink,
  ): Promise<{ diagram: string }> {
    const prompt =
      "Produce a diagram that visualizes the highlighted passage. Reply with ONLY a" +
      " fenced ```mermaid code block (flowchart/sequence/class/state/etc.) — no" +
      " prose, no explanation.";
    let harnessId: string | undefined;
    try {
      harnessId = (await readThread(docPath, threadId)).frontmatter.harness;
    } catch {
      // no thread yet; use doc default harness below
    }
    const harness = await this.harnessForDoc(docPath, harnessId);
    const runner = harness.runner;
    const sid = this.liveSessionId(threadId, harness);

    // Continue the existing discussion session if there is a live one...
    if (sid) {
      const turn = await runner.send(sid, prompt, onToken);
      return { diagram: turn.reply.trim() };
    }

    // ...otherwise start a fresh session so Visualize works on an un-discussed
    // comment, or one whose session is gone after a sidecar restart / reopen.
    const ann = (await readAnnotations(docPath)).annotations.find((a) => a.id === threadId);
    if (!ann) throw new Error(`annotation not found: ${threadId}`);
    const context = await this.buildContext({
      docPath,
      ann,
      threadId,
      annotationId: threadId,
      stance: "none",
      comment: prompt,
    });
    const { sessionId, turn } = await runner.start(context, onToken);
    await transition({ db: this.deps.db, docPath }, threadId, "responded", {
      piSessionId: sessionId,
    });
    return { diagram: turn.reply.trim() };
  }

  /**
   * Apply a legacy single-span proposal (`newText`, no `edits`/`fullText`): resolve its
   * owning annotation's anchor in the CURRENT doc, splice in the replacement text,
   * snapshot, and re-anchor the annotation. The sole caller is `approveProposal`'s
   * back-compat branch — for on-disk proposals persisted before hunks/full-rewrite
   * existed, or a markdown Improve rewrite (see `improve`) — which resolves via the
   * anchor (fuzzy-tolerant), NOT literal `oldText` matching like the hunk path.
   */
  private async applyLegacySpan(
    docPath: string,
    annotationId: string,
    newText: string,
  ): Promise<void> {
    if (isHtmlDoc(docPath)) {
      throw new Error("HTML proposals must be persisted and approved through approveProposal");
    }
    const before = await readFile(docPath, "utf8");
    const ann = (await readAnnotations(docPath)).annotations.find(
      (a) => a.id === annotationId,
    );
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

  /**
   * Recover task liveness after a crash, sidecar restart, or doc reopen.
   * One path for all three: for each task still marked running, inspect its
   * thread file — if the last turn is the agent's, the turn completed and we
   * just finalize to responded; otherwise it was interrupted mid-turn → error.
   *
   * Each row is isolated in its own try/catch: a row whose thread file is missing
   * (review() marks the TaskDB row running BEFORE initThread creates the thread
   * file, so a sidecar killed in that window leaves exactly this state) or corrupt
   * must not stop the rest of the rows from reconciling — and reconcile is awaited
   * before every openDoc, so letting it reject would make the document permanently
   * un-openable.
   */
  async reconcile(
    docPath: string,
  ): Promise<{ finalized: string[]; errored: string[] }> {
    const finalized: string[] = [];
    const errored: string[] = [];
    for (const row of this.deps.db.listByStatus("running")) {
      try {
        const thread = await readThread(docPath, row.threadId);
        const last = thread.turns[thread.turns.length - 1];
        if (last && last.role === "agent") {
          await transition({ db: this.deps.db, docPath }, row.threadId, "responded", {
            piSessionId: row.piSessionId,
          });
          finalized.push(row.threadId);
        } else {
          await transition({ db: this.deps.db, docPath }, row.threadId, "error", {
            piSessionId: row.piSessionId,
            error: "interrupted — sidecar restarted",
          });
          errored.push(row.threadId);
        }
      } catch {
        // The fallback status write must not be able to reject reconcile either
        // (e.g. SQLITE_BUSY or a closed DB handle) — swallow, leave the row
        // "running" for the next reconcile to retry, and keep going.
        try {
          await transition({ db: this.deps.db, docPath }, row.threadId, "error", {
            piSessionId: row.piSessionId,
            error: "interrupted — sidecar restarted",
          });
          errored.push(row.threadId);
        } catch (err) {
          console.warn(`reconcile: could not mark ${row.threadId} as error:`, err);
        }
      }
    }
    return { finalized, errored };
  }
}
