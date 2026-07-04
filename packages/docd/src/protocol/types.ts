// The wire-visible domain types. This module is an aggregation point only:
// definitions stay in their owning modules; desktop imports from here so the
// two sides of the WebSocket share one source of truth.
export type {
  Annotation,
  AnnotationsFile,
  AnnotationType,
  ThreadTurn,
  ThreadFrontmatter,
  VersionEntry,
  Manifest,
} from "../had/types.js";
export type { Proposal, ProposalStatus } from "../had/proposals.js";
export type { EditHunk, ProposedEdit, ReviewFinding } from "../agent/types.js";
export type { HadSettings } from "../had/settings.js";
export type { ModelConfig } from "../agent/model-registry.js";
export type { ThreadNode } from "../orchestrator/thread-tree.js";
/** Per-doc task-liveness row (state/task-db.ts), as returned by `listTasks`. */
export type { TaskRow } from "../state/task-db.js";
/** Harness descriptor (agent/harness-registry.ts); `listHarnesses` returns it minus `runner`. */
export type { AgentHarness } from "../agent/harness-registry.js";
/** Intermediate streaming frame shape shared by the server's emit and the client's onEvent. */
export type { RpcEvent } from "../rpc/types.js";
export type { AppConfig, HarnessChoice } from "../config/app-config.js";
