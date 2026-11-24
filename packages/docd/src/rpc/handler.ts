import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { stat } from "node:fs/promises";
import type { AgentRunner, TokenSink } from "../agent/types.js";
import { HarnessRegistry, listModels, saveModels } from "../agent/index.js";
import { isHarnessChoice, readAppConfig, writeAppConfig } from "../config/app-config.js";
import { TaskDB } from "../state/task-db.js";
import { Orchestrator } from "../orchestrator/orchestrator.js";
import { listThreadTree } from "../orchestrator/index.js";
import { hadPaths } from "../had/paths.js";
import {
  readAnnotations,
  createAnnotation,
  deleteAnnotation,
  readThread,
  readSettings,
  writeSettings,
  listVersions,
  readVersion,
  listProposals,
  openDoc,
  saveDoc,
  restoreVersion,
  exportHadz,
  importHadz,
  createDoc,
  saveImage,
  readImage,
  inspectPath,
  saveComment,
  resolveComment,
} from "../had/index.js";
import { parseRpcRequest, rpcRequestId, type RpcResponse, type RpcEmit } from "./types.js";
import type { RpcMethod, RpcParams, RpcResult } from "../protocol/rpc.js";

/** pi's default model registry location. */
export function defaultModelsPath(): string {
  return join(homedir(), ".pi", "agent", "models.json");
}

/** Adapts an agent's streamed token events to the wire's RpcEvent shape.
 * Panel's per-model fan-out tags each event with the producing model
 * (see Orchestrator.panel); forwarded here when present. */
function tokenSink(emit: RpcEmit | undefined): TokenSink | undefined {
  return emit
    ? (e) => emit({ event: e.type, data: e.text, ...(e.model ? { model: e.model } : {}) })
    : undefined;
}

export interface RpcHandlerDeps {
  runner?: AgentRunner;
  registry?: HarnessRegistry;
  now: () => string;
  /** System user name; default author for new comments + human turns. */
  author?: string;
  /** Path to pi's models.json; defaults to ~/.pi/agent/models.json. */
  modelsPath?: string;
}

interface DocResources {
  db: TaskDB;
  orch: Orchestrator;
}

/**
 * One implementation per wire method, typed straight from RpcSchema: the compiler
 * rejects a missing method, a params shape the schema doesn't declare, and a result
 * that doesn't match what the desktop is told it will receive. (The previous `switch`
 * returned `unknown`, so a drifted result shape compiled fine and broke at runtime.)
 */
type RpcHandlers = {
  [M in RpcMethod]: (params: RpcParams<M>, emit?: RpcEmit) => Promise<RpcResult<M>> | RpcResult<M>;
};

/**
 * Transport-agnostic dispatch over the backend. The WebSocket server calls `handle()`;
 * this owns per-doc resources (TaskDB + Orchestrator).
 */
export class RpcHandler {
  private docs = new Map<string, DocResources>();
  private readonly registry: HarnessRegistry;
  private readonly modelsPath: string;
  private readonly handlers: RpcHandlers;

  constructor(private deps: RpcHandlerDeps) {
    if (!deps.registry && !deps.runner) throw new Error("RpcHandler requires a runner or a registry");
    this.registry = deps.registry ?? HarnessRegistry.single(deps.runner!);
    this.modelsPath = deps.modelsPath ?? defaultModelsPath();
    this.handlers = this.buildHandlers();
  }

  private resourcesFor(docPath: string): DocResources {
    let r = this.docs.get(docPath);
    if (!r) {
      const db = new TaskDB(hadPaths(docPath).stateDb);
      const orch = new Orchestrator({
        registry: this.registry,
        db,
        now: this.deps.now,
        author: this.deps.author,
      });
      r = { db, orch };
      this.docs.set(docPath, r);
    }
    return r;
  }

  private orch(docPath: string): Orchestrator {
    return this.resourcesFor(docPath).orch;
  }

  /**
   * Never throws: `req` is whatever came off the wire (null, a number, an array…), and
   * anything that is not a request object with a string method is answered with an error.
   */
  async handle(req: unknown, emit?: RpcEmit): Promise<RpcResponse> {
    const parsed = parseRpcRequest(req);
    if (!parsed.ok) return { id: rpcRequestId(req), ok: false, error: parsed.error };
    const { id, method, params } = parsed.req;
    try {
      // The single cast point: the wire gives us an unknown method name and params; the
      // schema says what each method expects. The envelope is checked above; params
      // themselves are a compile-time contract (local-only sidecar — see spec §1).
      // (hasOwn, not `in`: a method named "constructor" or "toString" must be unknown.)
      if (!Object.hasOwn(this.handlers, method)) throw new Error(`unknown method: ${method}`);
      const handler = (this.handlers as Record<string, (p: unknown, e?: RpcEmit) => unknown>)[method];
      const result = await handler(params, emit);
      return { id, ok: true, result };
    } catch (err) {
      return { id, ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private buildHandlers(): RpcHandlers {
    const now = () => this.deps.now();
    return {
      // ---- document lifecycle ----
      openDoc: async (p) => {
        // A tab restored for a file that has since moved or been deleted fails here,
        // before anything is created for it: the per-doc TaskDB below would otherwise
        // leave a stray .docuzen/<name>.had/state.db (and an open handle) behind.
        if (!(await stat(p.docPath)).isFile()) throw new Error(`not a document file: ${p.docPath}`);
        // Crash recovery: a killed sidecar can leave TaskDB rows stuck "running" forever
        // (the process died mid-turn, so nothing ever transitioned them). Reconcile on
        // every open so a reopened doc's Agents panel doesn't show a phantom live task —
        // turns still running in this process are left alone. Layering: the handler
        // orchestrates the call, doc-store itself stays orchestrator-free (see
        // Orchestrator.reconcile's doc comment).
        await this.orch(p.docPath).reconcile(p.docPath);
        return openDoc(p.docPath);
      },
      saveDoc: (p) => saveDoc(p.docPath, p.text, now()),
      restoreVersion: (p) => restoreVersion(p.docPath, p.versionId, now()),
      listVersions: (p) => listVersions(p.docPath),
      readVersion: async (p) => ({ content: await readVersion(p.docPath, p.versionId) }),
      exportHadz: (p) => {
        // The bundle copies state.db but not its -wal file, so rows still in the log
        // would be left out; fold them in first.
        this.docs.get(p.docPath)?.db.checkpoint();
        return exportHadz(p.docPath, { versionId: p.versionId, outPath: p.outPath });
      },
      // The import replaces the target's review folder, state.db included: close any open
      // task database in it first, so the next request opens the imported one instead of
      // reading (and writing) the deleted file through a stale handle.
      importHadz: (p) =>
        importHadz(p.hadzPath, p.destDir, {
          releaseHadDir: (hadDir) => {
            for (const [docPath, r] of this.docs) {
              if (hadPaths(docPath).dir !== hadDir) continue;
              r.db.close();
              this.docs.delete(docPath);
            }
          },
        }),
      createDoc: (p) => createDoc(p.docPath),
      readImage: (p) => readImage(p.path),
      saveImage: (p) => saveImage(p.docPath, { name: p.name, dataBase64: p.dataBase64, sourcePath: p.sourcePath }),
      inspectPath: (p) => inspectPath(p.path),

      // ---- annotations + comments ----
      createAnnotation: (p) => createAnnotation(p.docPath, p, { now: now(), defaultAuthor: this.deps.author }),
      deleteAnnotation: async (p) => {
        // Stop the comment's running turn and drop its task first (cancel reads the
        // thread file for its harness, so this must precede deleting the files).
        await this.orch(p.docPath).discardThread(p.docPath, p.id);
        await deleteAnnotation(p.docPath, p.id);
        return { ok: true };
      },
      listAnnotations: async (p) => (await readAnnotations(p.docPath)).annotations,
      saveComment: async (p) => {
        await saveComment(p.docPath, p, now());
        return { ok: true };
      },
      resolveComment: async (p) => {
        await resolveComment(p.docPath, p.id, p.resolved !== false, now());
        return { ok: true };
      },

      // ---- threads ----
      listThreads: (p) => listThreadTree(p.docPath),
      getThread: (p) => readThread(p.docPath, p.threadId),
      listTasks: (p) => this.resourcesFor(p.docPath).db.list(),

      // ---- agent turns (streaming) ----
      discuss: async (p, emit) => {
        await this.orch(p.docPath).discuss(
          p.docPath,
          {
            threadId: p.threadId,
            annotationId: p.annotationId,
            stance: p.stance,
            comment: p.comment,
            modelId: p.modelId,
          },
          tokenSink(emit),
        );
        return { ok: true };
      },
      reply: async (p, emit) => {
        await this.orch(p.docPath).reply(p.docPath, p.threadId, p.message, tokenSink(emit), p.stance, p.modelId);
        return { ok: true };
      },
      panel: async (p, emit) => {
        await this.orch(p.docPath).panel(
          p.docPath,
          { threadId: p.threadId, annotationId: p.annotationId, stance: p.stance, comment: p.comment },
          p.models,
          tokenSink(emit),
        );
        return { ok: true };
      },
      branchThread: (p, emit) =>
        this.orch(p.docPath).branch(
          p.docPath,
          p.threadId,
          p.atTurnIndex,
          p.message,
          { doc: p.doc ?? "latest", modelId: p.modelId },
          tokenSink(emit),
        ),
      improve: (p, emit) => this.orch(p.docPath).improve(p.docPath, p.threadId, tokenSink(emit)),
      visualize: (p, emit) => this.orch(p.docPath).visualize(p.docPath, p.threadId, tokenSink(emit)),
      reviewDocument: (p, emit) =>
        this.orch(p.docPath).review(
          p.docPath,
          { stance: p.stance ?? "none", rubric: p.rubric, modelId: p.modelId },
          tokenSink(emit),
        ),
      resolveDirectives: (p, emit) => this.orch(p.docPath).resolveDirectives(p.docPath, tokenSink(emit)),
      cancelTurn: async (p) => {
        await this.orch(p.docPath).cancel(p.docPath, p.threadId);
        return { ok: true };
      },

      // ---- proposals ----
      listProposals: (p) => listProposals(p.docPath, p.threadId),
      approveProposal: async (p) => {
        await this.orch(p.docPath).approveProposal(p.docPath, p.threadId, p.proposalId);
        return { ok: true };
      },
      rejectProposal: async (p) => {
        await this.orch(p.docPath).rejectProposal(p.docPath, p.threadId, p.proposalId);
        return { ok: true };
      },

      // ---- models, harnesses, settings ----
      listModels: () => listModels(this.modelsPath),
      saveModels: async (p) => {
        await saveModels(this.modelsPath, p.models);
        return { ok: true };
      },
      listHarnesses: () => this.registry.list(),
      getHarnessModes: async (p) => {
        const h = this.registry.resolve(p.harness);
        if (!h.permissionModes || !h.runner.permissionModes) throw new Error("No permission modes for this harness.");
        return h.runner.permissionModes(dirname(p.docPath));
      },
      answerHarnessPermission: (p) => ({ ok: this.answerPermission(p.harness, p.requestId, p.allow === true) }),
      getSettings: async (p) => {
        const settings = await readSettings(p.docPath);
        // A doc that names no harness (and no app default) runs on the registry default —
        // report that, so the UI shows the harness turns will actually use.
        return { ...settings, harness: settings.harness ?? this.registry.defaultId() };
      },
      setSettings: async (p) => {
        await writeSettings(p.docPath, p.settings);
        if (isHarnessChoice(p.settings.harness)) {
          const cfg = readAppConfig();
          const next = { ...cfg, harness: { default: p.settings.harness } };
          if (p.settings.harness === "claude-code" && typeof p.permissionMode === "string" && p.permissionMode) {
            next.claude = { permissionMode: p.permissionMode };
          }
          if (p.settings.harness === "pi" && p.settings.model) {
            next.pi = { model: p.settings.model };
          }
          if (cfg.harness?.default !== next.harness.default || cfg.pi?.model !== next.pi?.model || cfg.claude?.permissionMode !== next.claude?.permissionMode) {
            writeAppConfig(next);
          }
        }
        return { ok: true };
      },
      getAppConfig: async () => {
        const config = readAppConfig();
        const models = await listModels(this.modelsPath).catch(() => []);
        // Same rule as server/select-runner.ts (minus the LLM_API_KEY dev override): the
        // configured model must have a stored key, or — with none configured — any model does.
        const wanted = config.pi?.model;
        const piUsable = wanted
          ? models.some((m) => m.key === wanted && m.hasKey)
          : models.some((m) => m.hasKey);
        const codexUsable = Boolean(this.registry.list().find((h) => h.id === "codex")?.available);
        // Local launch overrides may contain environment credentials. Setup only edits defaults.
        const { acp: _localLaunchSpecs, ...publicConfig } = config;
        return { config: publicConfig, piUsable, codexUsable };
      },
      setAppConfig: (p) => {
        writeAppConfig(p.config);
        return { ok: true };
      },
    };
  }

  answerPermission(harness: string, requestId: string, allow: boolean): boolean {
    return this.registry.resolve(harness).runner.answerPermission?.(requestId, allow) ?? false;
  }

  closeAll(): void {
    for (const { db } of this.docs.values()) db.close();
    this.docs.clear();
  }
}
