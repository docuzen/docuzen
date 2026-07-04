// Typed facade over the raw DocdClient. One method per RPC, typed from the
// shared RpcSchema; docPath is injected from the active-document getter so
// call sites never thread it by hand. (Phase 4 replaces the getter with a
// per-tab DocSession binding.)
import type { RpcMethod, RpcParams, RpcResult } from "@ai-native-doc/docd/protocol";
import type { DocdClient, RpcEvent } from "./rpc.js";

export type DocdApi = {
  [M in RpcMethod]: (
    params: Omit<RpcParams<M>, "docPath"> & { docPath?: string },
    onEvent?: (e: RpcEvent) => void,
  ) => Promise<RpcResult<M>>;
};

const METHODS = [
  "openDoc", "saveDoc", "saveComment", "discuss", "reply", "panel", "branchThread",
  "improve", "visualize", "reviewDocument", "resolveDirectives", "cancelTurn",
  "approveProposal", "rejectProposal", "listProposals",
  "createAnnotation", "deleteAnnotation", "resolveComment", "listAnnotations",
  "listThreads", "getThread", "listVersions", "readVersion", "restoreVersion",
  "listModels", "saveModels", "listHarnesses", "getSettings", "setSettings",
  "listTasks", "exportHadz", "importHadz",
] as const satisfies readonly RpcMethod[];

export function makeApi(client: Pick<DocdClient, "call">, activeDocPath: () => string | undefined): DocdApi {
  const api = {} as Record<string, unknown>;
  for (const method of METHODS) {
    api[method] = (params: Record<string, unknown>, onEvent?: (e: RpcEvent) => void) =>
      client.call(method, { docPath: activeDocPath(), ...params }, onEvent);
  }
  return api as DocdApi;
}

// --- DocSession store ---
// Wave-1: main.ts still owns the DOC_PATH/currentFormat globals (they move here
// only in wave-2, when tabs are extracted). The store never copies their value —
// every read goes through the injected `delegate` getters, and `setActive` writes
// back through the injected setters, so there is exactly one source of truth at
// all times.

/** The active document's session: a live view over the delegate, not a snapshot. */
export interface DocSession {
  readonly docPath: string;
  readonly format: "markdown" | "html";
  readonly api: DocdApi;
  onChange(listener: () => void): () => void;
}

/** Get/set closures over main.ts's existing globals — the wave-1 delegation seam. */
export interface SessionStoreDelegate {
  getDocPath(): string | undefined;
  getFormat(): "markdown" | "html";
  setDocPath(docPath: string): void;
  setFormat(format: "markdown" | "html"): void;
}

export interface SessionStore {
  /** Getter-bound as today (`makeApi(client, () => DOC_PATH)`), just sourced from the delegate. */
  api: DocdApi;
  /** `undefined` when the delegate reports no active doc path. */
  active(): DocSession | undefined;
  /** Writes both fields through the delegate's setters, then notifies listeners. */
  setActive(docPath: string, format: "markdown" | "html"): void;
  onChange(listener: () => void): () => void;
}

export function createSessionStore(
  client: Pick<DocdClient, "call">,
  delegate: SessionStoreDelegate,
): SessionStore {
  const listeners = new Set<() => void>();
  const api = makeApi(client, delegate.getDocPath);

  function onChange(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function active(): DocSession | undefined {
    if (delegate.getDocPath() === undefined) return undefined;
    return {
      // Accessor properties, not fields captured at active()-call time: every
      // read calls back into the delegate, so this object can never drift from
      // the (single) source of truth in main.ts.
      get docPath() {
        return delegate.getDocPath()!;
      },
      get format() {
        return delegate.getFormat();
      },
      api,
      onChange,
    };
  }

  function setActive(docPath: string, format: "markdown" | "html"): void {
    delegate.setDocPath(docPath);
    delegate.setFormat(format);
    for (const listener of [...listeners]) listener();
  }

  return { api, active, setActive, onChange };
}
