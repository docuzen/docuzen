import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import matter from "gray-matter";
import type { AgentContext, AgentRunner, AgentTurn, ProposedEdit, TokenSink } from "../agent/types.js";
import { HarnessRegistry, type AgentHarness } from "../agent/harness-registry.js";
import type { TaskDB } from "../state/task-db.js";
import { stancePrompt } from "./stance.js";
import { findDirectives } from "./directives.js";
import { transition } from "./turn-status.js";
import {
  readAnnotations,
  appendAnnotation,
  initThread,
  appendTurn,
  readThread,
  updateThreadFrontmatter,
  snapshot,
  readVersion,
  latestVersionId,
  readSettings,
  isHtmlDoc,
} from "../had/index.js";
import { createAnchor } from "../anchor/index.js";
import type { Annotation, ThreadTurn } from "../had/types.js";
import { ProposalService } from "./proposal-service.js";
import {
  DOC_TEXT_BUDGET,
  buildAgentContext,
  cancelKeyFor,
  improvePrompt,
  repoScope,
  type BuildContextOpts,
} from "./context.js";

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

function proposalPreview(pe: ProposedEdit): string {
  if (pe.fullRewrite !== undefined) return pe.fullRewrite.trim();
  const hunks = pe.hunks ?? [];
  if (hunks.length === 1) return hunks[0].newText.trim();
  return hunks.map((h) => h.newText.trim()).filter(Boolean).join("\n\n");
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
  /** Editing mode: this finding's edit was applied on the spot. */
  applied?: boolean;
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
 * persistProposal; on invoke failure it transitions to error (with
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
  /** Thread the turn runs on: keys the transitions and the appended turns. */
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
   * buildContext inputs. The engine builds the context and hands it to `invoke`. (reply's
   * send() ignores the context arg: a live session already has it.)
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
  /** Streamed-event sink, threaded to invoke and persistProposal. */
  onToken?: TokenSink;
  /**
   * Mutator run right after `buildContext`, before `invoke`.
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
}

export class Orchestrator {
  constructor(private deps: OrchestratorDeps) {}

  /** The agent-edit lifecycle (submit → review → apply | reject), both edit modes. */
  private readonly proposals = new ProposalService({ now: () => this.deps.now() });

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
    return cancelKeyFor(docPath, threadId);
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

  /** Approve a pending proposal: apply it to the document (see ProposalService.approve). */
  approveProposal(docPath: string, threadId: string, proposalId: string): Promise<void> {
    return this.proposals.approve(docPath, threadId, proposalId);
  }

  /** Reject a pending proposal; its feedback rides along with the next reply. */
  rejectProposal(docPath: string, threadId: string, proposalId: string): Promise<void> {
    return this.proposals.reject(docPath, threadId, proposalId);
  }

  /**
   * Snapshot the current doc (deduped) and return its version id — the doc version a
   * turn is "grounded in". Both the you- and agent-turn of one exchange share this id,
   * even when an approved proposal then changes the doc (that edit produces a LATER version).
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
   * buildContext → afterContext → invoke → append the agent turn. `runTurn` wraps this
   * with its own you-turn/transitions/persistProposal for callers with exactly one invoke per call (discuss/
   * reply/resumeFromTranscript/branch); `panel` calls this directly, once per model, so its
   * own try/catch can bracket the whole per-model loop with ONE you-turn and ONE running/
   * responded/error transition instead of one pair per invoke. `resolveDirectives` also
   * calls this directly, once per directive: its `invoke` closure substitutes its own
   * no-agent-text fallback into the turn BEFORE returning it (this method appends
   * `turn.reply` verbatim, so the fallback has to already be applied), and its own try/catch
   * swallows a directive's failure (`recordAgentError`) instead of rethrowing.
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
    },
  ): Promise<{
    turn: AgentTurn;
    agentTurn: ThreadTurn;
    sessionId: string;
    context: AgentContext;
  }> {
    const context = await buildAgentContext(spec.context);
    spec.afterContext?.(context);
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
    return { turn, agentTurn, sessionId, context };
  }

  /**
   * The shared agent-turn lifecycle for a caller with exactly one you-turn and one invoke:
   * harness resolve → doc-version snapshot → append you-turn → transition(running) →
   * `runAgentStep` (buildContext → afterContext → invoke → append agent-turn) →
   * transition(responded) → persistProposal; on invoke failure it
   * transitions to error (with frontmatter) and rethrows the original value unchanged.
   * Method-unique pre-work (thread init vs load, stance switch, reject-feedback prefix,
   * live-vs-resume routing, fork/thread-copy) stays in the caller; the differences that vary
   * the spine arrive as TurnSpec fields (youTurn body, agent meta, context opts, the invoke
   * closure, the pre-invoke session id, and the opt-in `docVersion`/`skipProposalPersist`/
   * `afterContext` seams), never as a branch on which method is
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
    try {
      const step = await this.runAgentStep(docPath, runner, {
        threadId,
        agentMeta: spec.agentMeta,
        docVersion,
        context: spec.context,
        invoke: spec.invoke,
        onToken: spec.onToken,
        afterContext: spec.afterContext,
      });
      turn = step.turn;
      sessionId = step.sessionId;
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
    if (!spec.skipProposalPersist && turn.proposal) {
      // Every runTurn caller is a conversation turn (discuss/reply/resume/branch). Runners
      // don't offer them an edit tool, but if one returns a proposal anyway it is only ever
      // recorded for review — never applied, even in Editing mode.
      await this.proposals.submit(docPath, spec.ann.id, turn.proposal, spec.onToken, { reviewOnly: true });
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
        // append-agent), sharing panel's ONE you-turn/docVersion/runner (panel never calls
        // persistProposal, which isn't part of runAgentStep at all); panel's own try/catch around this loop owns
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
    const context = await buildAgentContext({
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
    const out: MaterializedFinding[] = [];

    for (const f of findings) {
      // Re-read per finding: in Editing mode an earlier finding's edit has already
      // changed the document, and this finding must anchor against what is there now.
      const body = matter(await readFile(docPath, "utf8")).content;
      const at = body.indexOf(f.anchorText);
      const anchor =
        at >= 0
          ? createAnchor(body, at, at + f.anchorText.length)
          : { exact: f.anchorText, prefix: "", suffix: "" };
      const status = at >= 0 ? "open" : "orphaned";

      // Id allocation + append is one locked step (see had/annotations.ts appendAnnotation).
      const annotation = await appendAnnotation(docPath, (newId) => ({
        id: newId,
        type: "comment",
        anchor,
        status: status as Annotation["status"],
        thread: `threads/${newId}.md`,
        session: `sessions/${newId}.session.jsonl`,
        createdAt: now(),
        origin: "agent",
        review: {
          batchId,
          ...(f.severity ? { severity: f.severity } : {}),
          ...(f.kind ? { kind: f.kind } : {}),
        },
      }));
      const id = annotation.id;

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
      let applied = false;
      if ((f.edits && f.edits.length) || f.fullRewrite !== undefined) {
        const proposal: ProposedEdit = {
          rationale: f.comment,
          ...(f.edits && f.edits.length ? { hunks: f.edits } : {}),
          ...(f.fullRewrite !== undefined ? { fullRewrite: f.fullRewrite } : {}),
        };
        const submitted = await this.proposals.submit(docPath, id, proposal, undefined, { silent: true });
        proposalId = submitted.proposal.id;
        applied = submitted.applied;
      }

      const materialized: MaterializedFinding = {
        annotationId: id,
        status,
        ...(f.severity ? { severity: f.severity } : {}),
        ...(f.kind ? { kind: f.kind } : {}),
        ...(proposalId ? { proposalId } : {}),
        ...(applied ? { applied: true } : {}),
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
  ): Promise<{ count: number; proposed: boolean; applied: number; reply: string }> {
    const { db, now } = this.deps;
    const harness = await this.harnessForDoc(docPath);
    const runner = harness.runner;
    const body = matter(await readFile(docPath, "utf8")).content;
    const directives = findDirectives(body);
    if (directives.length === 0) return { count: 0, proposed: false, applied: 0, reply: "" };

    const settings = await readSettings(docPath);
    const folder = dirname(docPath);
    const scopeDir = settings.scope === "repo" ? repoScope(folder) : folder;
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
        const submitted = turn.proposal
          ? await this.proposals.submit(docPath, threadId, turn.proposal, onToken)
          : undefined;
        await transition({ db, docPath }, threadId, "responded", {
          piSessionId: sessionId,
          frontmatter: true,
        });
        return { proposed: turn.proposal !== undefined, applied: !!submitted?.applied, reply: rawReply };
      } catch (e) {
        await transition({ db, docPath }, threadId, "error", {
          piSessionId: null,
          error: errorSummary(e),
        });
        await this.recordAgentError(docPath, threadId, `Resolve inline directive ${i + 1}`, e);
        return { proposed: false, applied: false, reply: `Error: ${(e as Error).message}` };
      }
    });

    const results = await Promise.all(jobs);
    return {
      count: directives.length,
      proposed: results.some((r) => r.proposed),
      applied: results.filter((r) => r.applied).length,
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
    const rejectPrefix = await this.proposals.rejectFeedbackPrefix(docPath, threadId);
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
      // send(). Reuse the same sid.
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
   * continue the discussion. Mirrors the live reply() path (stance change, turn stamping)
   * but uses runner.start() with history instead of runner.send().
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
    const rejectPrefix = await this.proposals.rejectFeedbackPrefix(docPath, threadId);
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

    const parentAnn = (await readAnnotations(docPath)).annotations.find((a) => a.id === parentThreadId);

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
    const branchAnn = await appendAnnotation(docPath, (newId) => ({
      id: newId,
      type: parentAnn?.type ?? "comment",
      anchor: parentAnn?.anchor ?? { exact: parent.frontmatter.anchorExact, prefix: "", suffix: "" },
      status: "open",
      thread: `threads/${newId}.md`,
      session: `sessions/${newId}.session.jsonl`,
      createdAt: now(),
      ...(parentAnn?.color ? { color: parentAnn.color } : {}),
      ...(this.deps.author ? { author: this.deps.author } : {}),
    }));
    const branchId = branchAnn.id;

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
      // Reuse buildContext for digest/scope/anchor, then override the doc text
      // with the base version and attach prior turns as replayable history.
      afterContext: (ctx) => {
        ctx.docText = baseDocText;
        ctx.history = priorHistory;
      },
      invoke: (runner, ctx, tok) => runner.start(ctx, tok),
      skipProposalPersist: true,
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
   * Bracket a one-shot runner call (Improve, Visualize) with the same TaskDB lifecycle
   * every other turn gets — running → responded | error (with the failure summary) — so
   * the Agents panel shows it while it works and a failure leaves a record instead of
   * vanishing. No thread frontmatter is touched: these flows append no turns, and the
   * thread file may not exist yet (an un-discussed comment).
   *
   * By default the thread's existing session id is preserved across all three
   * transitions; `recordSession` stores the id `run` minted instead.
   */
  private async trackOneShot<T extends { turn: AgentTurn; sessionId?: string }>(
    docPath: string,
    threadId: string,
    run: () => Promise<T>,
    opts: { recordSession?: boolean } = {},
  ): Promise<T> {
    const { db } = this.deps;
    const prior = db.get(threadId)?.piSessionId ?? null;
    await transition({ db, docPath }, threadId, "running", { piSessionId: prior });
    let result: T;
    try {
      result = await run();
    } catch (e) {
      await transition({ db, docPath }, threadId, "error", {
        piSessionId: prior,
        error: errorSummary(e),
      });
      throw e;
    }
    await transition({ db, docPath }, threadId, "responded", {
      piSessionId: opts.recordSession ? (result.sessionId ?? prior) : prior,
    });
    return result;
  }

  /**
   * Ask the agent to rewrite the highlighted text using the discussion so far.
   * Returns the proposed replacement (not applied — the user reviews a diff first).
   */
  async improve(
    docPath: string,
    threadId: string,
    onToken?: TokenSink,
  ): Promise<{ newText: string; proposalId?: string; applied?: boolean }> {
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

    const context = await buildAgentContext({
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
    //
    // The thread's recorded session id is deliberately left untouched: Improve's session
    // is a one-shot rewrite session (rewrite-only prompt and tool policy), so a later
    // reply() must keep continuing the DISCUSSION session, not this one.
    const { turn } = await this.trackOneShot(docPath, threadId, async () => {
      const started = await runner.start(
        htmlDoc
          ? { ...context, improveMode: true, conversationOnly: false }
          : { ...context, replacementOnly: true, improveMode: true, conversationOnly: false },
        onToken,
      );
      if (htmlDoc && !started.turn.proposal) {
        throw new Error(
          "HTML Improve requires a structured proposal so the edit can be validated before approval",
        );
      }
      return started;
    });
    if (htmlDoc && turn.proposal) {
      const submitted = await this.proposals.submit(docPath, threadId, turn.proposal, onToken);
      return {
        newText: proposalPreview(turn.proposal),
        proposalId: submitted.proposal.id,
        ...(submitted.applied ? { applied: true } : {}),
      };
    }
    const newText = turn.reply.trim();
    const submitted = await this.proposals.submitSpan(docPath, threadId, newText, onToken);
    return { newText, proposalId: submitted.proposal.id, ...(submitted.applied ? { applied: true } : {}) };
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
      const { turn } = await this.trackOneShot(docPath, threadId, async () => ({
        turn: await runner.send(sid, prompt, onToken),
      }));
      return { diagram: turn.reply.trim() };
    }

    // ...otherwise start a fresh session so Visualize works on an un-discussed
    // comment, or one whose session is gone after a sidecar restart / reopen.
    const ann = (await readAnnotations(docPath)).annotations.find((a) => a.id === threadId);
    if (!ann) throw new Error(`annotation not found: ${threadId}`);
    const context = await buildAgentContext({
      docPath,
      ann,
      threadId,
      annotationId: threadId,
      stance: "none",
      comment: prompt,
    });
    // A fresh conversation session: record it, so a follow-up reply() can continue it.
    const { turn } = await this.trackOneShot(
      docPath,
      threadId,
      () => runner.start(context, onToken),
      { recordSession: true },
    );
    return { diagram: turn.reply.trim() };
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
