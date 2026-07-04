import type { TextQuoteAnchor } from "../anchor/types.js";

export interface Manifest {
  version: number;
  doc: string; // basename of the document
  contentHash: string; // sha256 hex of the doc bytes at last write
}

export type AnnotationType = "comment" | "highlight";
export type AnnotationStatus = "open" | "resolved" | "orphaned";

export interface Annotation {
  id: string;
  type: AnnotationType;
  anchor: TextQuoteAnchor;
  status: AnnotationStatus;
  thread: string; // relative path within .had, e.g. "threads/c0001.md"
  session: string; // relative path, e.g. "sessions/c0001.session.jsonl"
  createdAt: string; // ISO timestamp
  /** Highlight color name (e.g. "yellow"); UI-facing, optional. */
  color?: string;
  /** Who created the comment (defaults to the system user). */
  author?: string;
  /** Where the annotation came from. Absent = human (back-compat). */
  origin?: "human" | "agent";
  /** For agent-review-pass findings: grouping + triage metadata. */
  review?: {
    batchId: string;
    severity?: "info" | "suggestion" | "issue";
    kind?: string;
  };
}

export interface AnnotationsFile {
  version: number;
  annotations: Annotation[];
}

export type VersionCause =
  | "manual-save"
  | "agent-edit"
  | "pre-apply-backup"
  | "external-conflict"
  | "turn-base"
  | "branch-base";

export interface VersionEntry {
  id: string; // e.g. "v0008"
  timestamp: string; // ISO
  cause: VersionCause;
  thread?: string; // thread id that caused it, if any
  note?: string;
}

export interface VersionsFile {
  version: number;
  entries: VersionEntry[];
}

export type ThreadTurnRole = "you" | "agent" | "system";

export interface ThreadTurn {
  role: ThreadTurnRole;
  timestamp: string;
  /** For agent turns: the stance + model label, e.g. "critiquer · claude-fable-5". */
  meta?: string;
  /** For agent turns: the model's streamed reasoning, persisted (hidden in an HTML comment). */
  thinking?: string;
  /** Which doc version snapshot (e.g. "v0003") was active when the turn was made. */
  docVersion?: string;
  body: string;
}

export interface ThreadFrontmatter {
  id: string;
  anchorExact: string;
  stance: string;
  status: string;
  piSession: string;
  /** "provider/modelId" key of the model that answered this thread; survives reopen. */
  model?: string;
  /** Agent harness that owns this thread (e.g. "pi", future "codex"/"claude-code"). */
  harness?: "pi" | "codex" | "claude-code";
  /** For branched threads: the thread id this one forked from. */
  parent?: string;
  /** For branched threads: the turn index in the parent at which the fork occurred. */
  branchFromTurn?: number;
  /** For branched threads: the doc version snapshot the branch is based on. */
  baseVersion?: string;
  /** For branched threads: whether the branch tracks "latest" or the version "at-turn". */
  baseDoc?: "latest" | "at-turn";
}

export interface ThreadFile {
  frontmatter: ThreadFrontmatter;
  turns: ThreadTurn[];
}
