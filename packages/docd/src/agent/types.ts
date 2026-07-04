import type { DocToolchain } from "./mcp.js";

export interface EditHunk {
  /** Verbatim run from the CURRENT doc body to replace. "" means a pure insertion. */
  oldText: string;
  /** Replacement text. "" means a pure deletion. */
  newText: string;
}
export interface ProposedEdit {
  rationale: string;
  /** Targeted search/replace hunks (agent-provided). */
  hunks?: EditHunk[];
  /** New full document body — diffed for display, written verbatim on apply. */
  fullRewrite?: string;
}

export type ReviewSeverity = "info" | "suggestion" | "issue";

/**
 * One finding from a document-wide Agent Review Pass: an anchored comment, plus an
 * OPTIONAL edit the reviewer can approve. The agent never writes the doc directly;
 * each finding becomes a comment annotation (its own thread) and, if it carries an
 * edit, a pending proposal on that thread reviewed through the normal approve path.
 */
export interface ReviewFinding {
  /** Verbatim run from the doc body the finding is anchored to (located to build a text-quote anchor). */
  anchorText: string;
  /** Reviewer-facing note explaining the finding. */
  comment: string;
  /** Optional triage hints surfaced as chips in the UI. */
  severity?: ReviewSeverity;
  kind?: string;
  /** Optional targeted edits for this finding (same shape as a ProposedEdit's hunks). */
  edits?: EditHunk[];
  /** Optional full-document rewrite this finding proposes. */
  fullRewrite?: string;
}

export interface AgentContext {
  /** Full document body (frontmatter-stripped), budgeted to a token cap. */
  docText: string;
  anchorExact: string;
  surrounding: string;
  comment: string;
  stancePrompt: string;
  /** Absolute path to the doc — runners use it (or its dir) as the tool scope. */
  docPath?: string;
  /** Directory the agent's file tools are scoped to (from per-doc settings). */
  scopeDir?: string;
  /** Digest of the OTHER highlights/comments + their discussions on this doc. */
  annotationsDigest?: string;
  /** Per-doc standing instructions (AGENTS.md-style), injected into every prompt. */
  instructions?: string;
  /** Web-search capability for this turn (provider + on/off). */
  webSearch?: { enabled?: boolean; provider?: "ddg" | "brave" | "tavily" };
  /** Internal vetted document toolchain selected from the document type. */
  docToolchain?: DocToolchain;
  /** When true, the agent may edit the document directly (write tools). */
  allowEdit?: boolean;
  /**
   * When true, this turn wants ONLY raw replacement text for the highlighted
   * passage (the Improve flow). Runners must NOT offer the propose_edit tool or
   * the propose/direct edit policy for it, so the agent doesn't get told to use
   * a tool while also being asked to reply with the replacement inline.
   */
  replacementOnly?: boolean;
  /**
   * Improve asks for a focused rewrite. Markdown uses replacementOnly text for the
   * highlighted span; HTML uses structured proposal mode so raw-source validation can
   * run before approval.
   */
  improveMode?: boolean;
  /**
   * When true, this is a document-wide Agent Review Pass: the agent reads the whole
   * doc and emits findings via the add_review_finding tool instead of discussing one
   * passage. No direct edit/write tools and no propose_edit (findings carry edits).
   */
  reviewMode?: boolean;
  /**
   * Phase 10: true for conversation turns — discuss, reply (including annotation-less
   * threads: directive/review-umbrella chat), panel, and branch. The agent may read the
   * document and discuss it, but must never propose or apply an edit from these turns —
   * `allowEdit` is forced false and `propose_edit`/the codex edit contract are withheld
   * REGARDLESS of `settings.agentEdit` (see Orchestrator.buildContext, which is the sole
   * place this flag is computed). Edits come only from the explicit flows —
   * resolveDirectives, Improve, Review findings — none of which set this true (Improve
   * explicitly forces it back to false after buildContext's anchored default).
   * tool-policy.ts, pi-runner.ts, and codex-runner.ts all gate their propose/edit
   * narration on this single flag so conversation turns stay editorially inert everywhere.
   */
  conversationOnly?: boolean;
  /** True for .html/.htm docs; runners can offer HTML-source-specific validation help. */
  htmlMode?: boolean;
  /** "provider/modelId" key selecting which configured model answers; falls back to the runner default. */
  modelId?: string;
  /** Opaque key the runner indexes the live session by, so cancel() can abort it; set to docPath#threadId by the orchestrator. */
  cancelKey?: string;
  /**
   * Prior conversation turns to replay into a fresh session's first prompt. Used to
   * resume a thread whose live session is gone (reopen) or to seed a branched thread.
   */
  history?: { role: "you" | "agent"; body: string }[];
}

export interface AgentTurn {
  reply: string;
  /** The model's reasoning for this turn, if any (persisted with the turn). */
  thinking?: string;
  proposal?: ProposedEdit;
  /** Findings emitted via add_review_finding during a review pass, if any. */
  findings?: ReviewFinding[];
}

/** A streamed event from the agent: reply text, reasoning, or tool activity. */
export interface AgentEvent {
  type: "token" | "thinking" | "tool" | "docChanged" | "proposal" | "finding";
  text: string;
  /** Set by panel fan-out to tag which model produced this event; unset otherwise. */
  model?: string;
}
/** Called with each streamed agent event, in order. */
export type TokenSink = (event: AgentEvent) => void;

/** Abstraction over the agent harness. Injected into the Orchestrator. */
export interface AgentRunner {
  start(
    ctx: AgentContext,
    onToken?: TokenSink,
  ): Promise<{ sessionId: string; turn: AgentTurn }>;
  send(sessionId: string, message: string, onToken?: TokenSink): Promise<AgentTurn>;
  /** Abort the live session indexed by `cancelKey`, if one exists. Optional: not all runners support cancellation. */
  cancel?(cancelKey: string): Promise<void>;
  /** Whether the runner still holds this live session; false after a restart. Optional. */
  hasSession?(sessionId: string): boolean;
}
