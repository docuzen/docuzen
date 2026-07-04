import type {
  Annotation,
  AnnotationType,
  ThreadTurn,
  ThreadFrontmatter,
  VersionEntry,
  Proposal,
  ModelConfig,
  HadSettings,
  ThreadNode,
  TaskRow,
  AgentHarness,
} from "./types.js";
import type { AppConfig } from "../config/app-config.js";
// TextQuoteAnchor already has its own public subpath (`@ai-native-doc/docd/anchor`),
// so it's imported directly here rather than re-exported through protocol/types.ts.
import type { TextQuoteAnchor } from "../anchor/types.js";

/** One entry per RPC method. `params` is what the client sends (docPath
 * included where the handler reads it); `result` is what the handler
 * returns; `event: true` marks streaming methods (frames via onEvent). */
export interface RpcSchema {
  openDoc: {
    params: { docPath: string };
    result: {
      text: string;
      format: "markdown" | "html";
      annotations: Array<Annotation & { body?: string; parent?: string }>;
    };
  };
  saveDoc: {
    params: { docPath: string; text: string };
    result: { saved: boolean; version: string };
  };
  saveComment: {
    params: { docPath: string; id: string; anchorExact?: string; body?: string };
    result: { ok: boolean };
  };
  discuss: {
    params: {
      docPath: string;
      threadId: string;
      annotationId: string;
      stance: string;
      comment: string;
      modelId?: string;
    };
    result: { ok: boolean };
    event: true;
  };
  reply: {
    params: {
      docPath: string;
      threadId: string;
      message: string;
      stance?: string;
      modelId?: string;
    };
    result: { ok: boolean };
    event: true;
  };
  panel: {
    params: {
      docPath: string;
      threadId: string;
      annotationId: string;
      stance: string;
      comment: string;
      models: string[];
    };
    result: { ok: boolean };
    event: true;
  };
  branchThread: {
    params: {
      docPath: string;
      threadId: string;
      atTurnIndex: number;
      message: string;
      doc?: "latest" | "at-turn";
      modelId?: string;
    };
    result: { branchThreadId: string };
    event: true;
  };
  improve: {
    params: { docPath: string; threadId: string };
    result: { newText: string; proposalId?: string };
    event: true;
  };
  visualize: {
    params: { docPath: string; threadId: string };
    result: { diagram: string };
    event: true;
  };
  reviewDocument: {
    params: { docPath: string; stance?: string; rubric?: string; modelId?: string };
    result: {
      batchId: string;
      // Materialized shape from Orchestrator.review(); orchestrator.ts isn't one of
      // this module's re-export sources, so it's inlined rather than imported.
      findings: Array<{
        annotationId: string;
        status: string;
        severity?: string;
        kind?: string;
        proposalId?: string;
      }>;
    };
    event: true;
  };
  resolveDirectives: {
    params: { docPath: string };
    result: { count: number; proposed: boolean; reply: string };
    event: true;
  };
  cancelTurn: {
    params: { docPath: string; threadId: string };
    result: { ok: boolean };
  };
  approveProposal: {
    params: { docPath: string; threadId: string; proposalId: string };
    result: { ok: boolean };
  };
  rejectProposal: {
    params: { docPath: string; threadId: string; proposalId: string };
    result: { ok: boolean };
  };
  listProposals: {
    params: { docPath: string; threadId?: string };
    result: Proposal[];
  };
  createAnnotation: {
    params: {
      docPath: string;
      kind: AnnotationType;
      anchor: TextQuoteAnchor;
      color?: string;
      author?: string;
    };
    result: Annotation;
  };
  deleteAnnotation: {
    params: { docPath: string; id: string };
    result: { ok: boolean };
  };
  resolveComment: {
    params: { docPath: string; id: string; resolved?: boolean };
    result: { ok: boolean };
  };
  listAnnotations: {
    params: { docPath: string };
    result: Annotation[];
  };
  listThreads: {
    params: { docPath: string };
    result: ThreadNode[];
  };
  getThread: {
    params: { docPath: string; threadId: string };
    result: { frontmatter: ThreadFrontmatter; turns: ThreadTurn[] };
  };
  listVersions: {
    params: { docPath: string };
    result: VersionEntry[];
  };
  readVersion: {
    params: { docPath: string; versionId: string };
    result: { content: string };
  };
  restoreVersion: {
    params: { docPath: string; versionId: string };
    result: { restored: boolean; version: string };
  };
  listModels: {
    params: Record<string, never>;
    result: ModelConfig[];
  };
  saveModels: {
    params: { models: ModelConfig[] };
    result: { ok: boolean };
  };
  listHarnesses: {
    params: Record<string, never>;
    result: Array<Omit<AgentHarness, "runner">>;
  };
  getSettings: {
    params: { docPath: string };
    result: HadSettings;
  };
  setSettings: {
    params: { docPath: string; settings: HadSettings };
    result: { ok: boolean };
  };
  getAppConfig: {
    params: Record<string, never>;
    result: { config: AppConfig; piUsable: boolean; codexUsable: boolean };
  };
  setAppConfig: {
    params: { config: AppConfig };
    result: { ok: boolean };
  };
  listTasks: {
    params: { docPath: string };
    result: TaskRow[];
  };
  exportHadz: {
    params: { docPath: string; versionId?: string; outPath?: string };
    result: { path: string };
  };
  importHadz: {
    params: { hadzPath: string; destDir?: string };
    result: { docPath: string };
  };
}

export type RpcMethod = keyof RpcSchema;
export type RpcParams<M extends RpcMethod> = RpcSchema[M]["params"];
export type RpcResult<M extends RpcMethod> = RpcSchema[M]["result"];
