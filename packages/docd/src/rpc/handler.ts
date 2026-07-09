import { join } from "node:path";
import { homedir } from "node:os";
import type { AgentRunner, TokenSink } from "../agent/types.js";
import { HarnessRegistry, listModels, saveModels } from "../agent/index.js";
import { readAppConfig, writeAppConfig } from "../config/app-config.js";
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
  saveComment,
  resolveComment,
} from "../had/index.js";
import type { RpcRequest, RpcResponse, RpcEmit } from "./types.js";
import type { RpcMethod, RpcParams } from "../protocol/rpc.js";

/** Single cast point: the wire gives us unknown params; the schema says
 * what each method expects. Compile-time contract, no runtime validation
 * (local-only sidecar — see spec §1). */
function paramsFor<M extends RpcMethod>(_method: M, params: Record<string, unknown>): RpcParams<M> {
  return params as RpcParams<M>;
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

/** pi's default model registry location. */
function defaultModelsPath(): string {
  return join(homedir(), ".pi", "agent", "models.json");
}

interface DocResources {
  db: TaskDB;
  orch: Orchestrator;
}

/**
 * Transport-agnostic dispatch over the backend. The UI (and the future
 * WebSocket server / Tauri IPC) call `handle()`; this owns per-doc resources.
 */
export class RpcHandler {
  private docs = new Map<string, DocResources>();

  constructor(private deps: RpcHandlerDeps) {}

  private resourcesFor(docPath: string): DocResources {
    let r = this.docs.get(docPath);
    if (!r) {
      const db = new TaskDB(hadPaths(docPath).stateDb);
      const orch = new Orchestrator({
        ...(this.deps.registry ? { registry: this.deps.registry } : { runner: this.deps.runner! }),
        db,
        now: this.deps.now,
        author: this.deps.author,
      });
      r = { db, orch };
      this.docs.set(docPath, r);
    }
    return r;
  }

  async handle(req: RpcRequest, emit?: RpcEmit): Promise<RpcResponse> {
    try {
      const result = await this.dispatch(req.method, req.params, emit);
      return { id: req.id, ok: true, result };
    } catch (err) {
      return { id: req.id, ok: false, error: (err as Error).message };
    }
  }

  private async dispatch(
    method: string,
    params: Record<string, unknown>,
    emit?: RpcEmit,
  ): Promise<unknown> {
    switch (method) {
      case "discuss": {
        const p = paramsFor("discuss", params);
        const { orch } = this.resourcesFor(p.docPath);
        await orch.discuss(
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
      }
      case "panel": {
        const p = paramsFor("panel", params);
        const { orch } = this.resourcesFor(p.docPath);
        await orch.panel(
          p.docPath,
          {
            threadId: p.threadId,
            annotationId: p.annotationId,
            stance: p.stance,
            comment: p.comment,
          },
          p.models,
          tokenSink(emit),
        );
        return { ok: true };
      }
      case "listHarnesses":
        return (this.deps.registry ?? HarnessRegistry.single(this.deps.runner!)).list();
      case "reviewDocument": {
        const p = paramsFor("reviewDocument", params);
        const { orch } = this.resourcesFor(p.docPath);
        return orch.review(
          p.docPath,
          {
            stance: p.stance ?? "none",
            rubric: p.rubric,
            modelId: p.modelId,
          },
          tokenSink(emit),
        );
      }
      case "resolveDirectives": {
        const p = paramsFor("resolveDirectives", params);
        const { orch } = this.resourcesFor(p.docPath);
        return orch.resolveDirectives(p.docPath, tokenSink(emit));
      }
      case "reply": {
        const p = paramsFor("reply", params);
        const { orch } = this.resourcesFor(p.docPath);
        await orch.reply(
          p.docPath,
          p.threadId,
          p.message,
          tokenSink(emit),
          p.stance,
          p.modelId,
        );
        return { ok: true };
      }
      case "cancelTurn": {
        const p = paramsFor("cancelTurn", params);
        const { orch } = this.resourcesFor(p.docPath);
        await orch.cancel(p.docPath, p.threadId);
        return { ok: true };
      }
      case "improve": {
        const p = paramsFor("improve", params);
        const { orch } = this.resourcesFor(p.docPath);
        return orch.improve(p.docPath, p.threadId, tokenSink(emit));
      }
      case "visualize": {
        const p = paramsFor("visualize", params);
        const { orch } = this.resourcesFor(p.docPath);
        return orch.visualize(p.docPath, p.threadId, tokenSink(emit));
      }
      case "branchThread": {
        const p = paramsFor("branchThread", params);
        const { orch } = this.resourcesFor(p.docPath);
        return orch.branch(
          p.docPath,
          p.threadId,
          p.atTurnIndex,
          p.message,
          { doc: p.doc ?? "latest", modelId: p.modelId },
          tokenSink(emit),
        );
      }
      case "listProposals": {
        const p = paramsFor("listProposals", params);
        return listProposals(p.docPath, p.threadId);
      }
      case "approveProposal": {
        const p = paramsFor("approveProposal", params);
        const { orch } = this.resourcesFor(p.docPath);
        await orch.approveProposal(p.docPath, p.threadId, p.proposalId);
        return { ok: true };
      }
      case "rejectProposal": {
        const p = paramsFor("rejectProposal", params);
        const { orch } = this.resourcesFor(p.docPath);
        await orch.rejectProposal(p.docPath, p.threadId, p.proposalId);
        return { ok: true };
      }
      case "openDoc": {
        const p = paramsFor("openDoc", params);
        // Crash recovery: a killed sidecar can leave TaskDB rows stuck "running" forever
        // (the process died mid-turn, so nothing ever transitioned them). Reconcile on
        // every open so a reopened doc's Agents panel doesn't show a phantom live task —
        // layering: the handler orchestrates the call, doc-store itself stays
        // orchestrator-free (see Orchestrator.reconcile's doc comment).
        const { orch } = this.resourcesFor(p.docPath);
        await orch.reconcile(p.docPath);
        return openDoc(p.docPath);
      }
      case "importHadz": {
        const p = paramsFor("importHadz", params);
        return importHadz(p.hadzPath, p.destDir);
      }
      case "saveComment": {
        const p = paramsFor("saveComment", params);
        await saveComment(p.docPath, p, this.deps.now());
        return { ok: true };
      }
      case "saveDoc": {
        const p = paramsFor("saveDoc", params);
        return saveDoc(p.docPath, p.text, this.deps.now());
      }
      case "restoreVersion": {
        const p = paramsFor("restoreVersion", params);
        return restoreVersion(p.docPath, p.versionId, this.deps.now());
      }
      case "exportHadz": {
        const p = paramsFor("exportHadz", params);
        return exportHadz(p.docPath, { versionId: p.versionId, outPath: p.outPath });
      }
      case "createAnnotation": {
        const p = paramsFor("createAnnotation", params);
        return createAnnotation(p.docPath, p, { now: this.deps.now(), defaultAuthor: this.deps.author });
      }
      case "resolveComment": {
        const p = paramsFor("resolveComment", params);
        await resolveComment(p.docPath, p.id, p.resolved !== false, this.deps.now());
        return { ok: true };
      }
      case "deleteAnnotation": {
        const p = paramsFor("deleteAnnotation", params);
        await deleteAnnotation(p.docPath, p.id);
        return { ok: true };
      }
      case "listModels":
        return listModels(this.deps.modelsPath ?? defaultModelsPath());
      case "saveModels": {
        const p = paramsFor("saveModels", params);
        await saveModels(this.deps.modelsPath ?? defaultModelsPath(), p.models);
        return { ok: true };
      }
      case "getSettings": {
        const p = paramsFor("getSettings", params);
        return readSettings(p.docPath);
      }
      case "setSettings": {
        const p = paramsFor("setSettings", params);
        await writeSettings(p.docPath, p.settings);
        // Write-through: if the user chose a config-level harness (pi | codex), persist it
        // as the app default so future documents open with the same harness.  "claude-code"
        // is a doc-only value that has no HarnessChoice equivalent in config.toml.
        if (p.settings.harness === "pi" || p.settings.harness === "codex") {
          const cfg = readAppConfig();
          const next = { ...cfg, harness: { default: p.settings.harness } };
          if (p.settings.harness === "pi" && p.settings.model) {
            next.pi = { model: p.settings.model };
          }
          if (cfg.harness?.default !== next.harness.default || cfg.pi?.model !== next.pi?.model) {
            writeAppConfig(next);
          }
        }
        return { ok: true };
      }
      case "getAppConfig": {
        const config = readAppConfig();
        const models = await listModels(this.deps.modelsPath ?? defaultModelsPath()).catch(() => []);
        const piUsable = Boolean(
          config.pi?.model && models.some((m) => m.key === config.pi?.model && m.hasKey),
        );
        const registry = this.deps.registry;
        const codexUsable = Boolean(registry?.list().find((h) => h.id === "codex")?.available);
        return { config, piUsable, codexUsable };
      }
      case "setAppConfig": {
        const p = paramsFor("setAppConfig", params);
        writeAppConfig(p.config);
        return { ok: true };
      }
      case "listAnnotations": {
        const p = paramsFor("listAnnotations", params);
        return (await readAnnotations(p.docPath)).annotations;
      }
      case "getThread": {
        const p = paramsFor("getThread", params);
        return readThread(p.docPath, p.threadId);
      }
      case "listThreads": {
        const p = paramsFor("listThreads", params);
        return listThreadTree(p.docPath);
      }
      case "listVersions": {
        const p = paramsFor("listVersions", params);
        return listVersions(p.docPath);
      }
      case "readVersion": {
        const p = paramsFor("readVersion", params);
        return { content: await readVersion(p.docPath, p.versionId) };
      }
      case "listTasks": {
        const p = paramsFor("listTasks", params);
        const { db } = this.resourcesFor(p.docPath);
        return db.list();
      }
      default:
        throw new Error(`unknown method: ${method}`);
    }
  }

  closeAll(): void {
    for (const { db } of this.docs.values()) db.close();
    this.docs.clear();
  }
}
