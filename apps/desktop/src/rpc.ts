// WebSocket client to the docd sidecar. Auto-reconnects with backoff (500ms
// → ×2 → capped at 5s, forever) until close() is called. This is a deliberate
// behavior CHANGE from the old connect-once client: a dropped sidecar used to
// strand every open tab silently with no way to recover short of a reload.
// Request/response keyed by an auto-incrementing id. Mirrors RpcResponse:
// resolves on ok, rejects with the error string otherwise.

import type { RpcEvent } from "@ai-native-doc/docd/protocol";
/** Intermediate streaming frame (e.g. an agent reply token); re-exported for callers. */
export type { RpcEvent } from "@ai-native-doc/docd/protocol";

const DEFAULT_PORT = 8137;
const INITIAL_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 5000;
/** How long a call issued while disconnected waits for the next reconnect before giving up. */
const QUEUE_GRACE_MS = 10_000;
/** Standard WebSocket.OPEN readyState value — hardcoded so this module never depends on a
 * global `WebSocket` existing (the fake used by rpc-reconnect.test.ts doesn't need to be a
 * real WebSocket subclass, just match this numbering). */
const WS_OPEN = 1;

/** Rejection message for both in-flight calls whose socket dies and queued calls that time out
 * waiting for a reconnect — one message, one meaning: "retry yourself, we're already trying". */
export const LOST_CONNECTION_MESSAGE = "docd connection lost — retrying in background";

export function docdPort(): number {
  // Packaged app: the Rust shell injects the spawned sidecar's port via an
  // initialization script before any frontend code runs.
  const injected = (globalThis as { __DOCD_PORT__?: number }).__DOCD_PORT__;
  if (typeof injected === "number") return injected;
  const q = new URLSearchParams(location.search).get("docdPort");
  if (q) return Number(q);
  const env = (import.meta as { env?: Record<string, string> }).env?.VITE_DOCD_PORT;
  return env ? Number(env) : DEFAULT_PORT;
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  onEvent?: (e: RpcEvent) => void;
}

interface Queued extends Pending {
  method: string;
  params: Record<string, unknown>;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * The minimal WebSocket surface rpc.ts depends on — deliberately smaller than lib.dom's
 * `WebSocket` so rpc-reconnect.test.ts can fake it with a plain class (no jsdom/happy-dom in
 * this package's vitest setup — see ui.test.ts's file header for the same constraint).
 */
export interface MinimalWebSocket {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(type: "open", listener: () => void): void;
  addEventListener(type: "close", listener: () => void): void;
  addEventListener(type: "error", listener: () => void): void;
  addEventListener(type: "message", listener: (ev: { data: unknown }) => void): void;
}

export type WebSocketFactory = (url: string) => MinimalWebSocket;

export interface DocdClient {
  call<T = unknown>(
    method: string,
    params: Record<string, unknown>,
    onEvent?: (e: RpcEvent) => void,
  ): Promise<T>;
  /** Stops reconnecting and closes the current socket. Nothing calls this today — added for
   * hygiene (a `connect()` with no matching teardown is the kind of thing that bites later). */
  close(): void;
}

/**
 * `wsFactory` is the reconnect test's injection seam (smallest one available: everything else
 * about `connect()` — the id counter, the pending/queue maps, the backoff state — lives in this
 * closure and would have to be rebuilt to fake at any higher level). Defaults to the real
 * WebSocket constructor for production use.
 */
export function connect(
  onStatus?: (s: string) => void,
  wsFactory: WebSocketFactory = (url) => new WebSocket(url),
): DocdClient {
  const url = `ws://127.0.0.1:${docdPort()}`;
  const pending = new Map<string, Pending>();
  const queue = new Map<string, Queued>();
  let counter = 0;
  let ws: MinimalWebSocket;
  let backoff = INITIAL_BACKOFF_MS;
  let reconnectAttempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;

  function rejectAllPending(err: Error): void {
    for (const p of pending.values()) p.reject(err);
    pending.clear();
  }

  // Calls issued while disconnected are held here (see `call` below) rather than rejected
  // outright — a short blip shouldn't force every caller to implement their own retry.
  function flushQueue(): void {
    for (const [id, q] of queue) {
      clearTimeout(q.timer);
      queue.delete(id);
      pending.set(id, q);
      ws.send(JSON.stringify({ id, method: q.method, params: q.params }));
    }
  }

  function scheduleReconnect(): void {
    if (closed) return;
    reconnectAttempt += 1;
    onStatus?.(`reconnecting (attempt ${reconnectAttempt})`);
    reconnectTimer = setTimeout(openSocket, backoff);
    backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
  }

  function openSocket(): void {
    ws = wsFactory(url);
    // Guards against both "error" and "close" firing for the same death (real WebSockets
    // commonly fire both) — without it we'd double-schedule the next reconnect attempt and
    // skip an attempt number.
    let downHandled = false;
    const onDown = () => {
      if (closed || downHandled) return;
      downHandled = true;
      rejectAllPending(new Error(LOST_CONNECTION_MESSAGE));
      onStatus?.("disconnected");
      scheduleReconnect();
    };

    ws.addEventListener("open", () => {
      backoff = INITIAL_BACKOFF_MS;
      reconnectAttempt = 0;
      onStatus?.("connected");
      flushQueue();
    });
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data as string) as
        | { id: string; event: string; data: unknown; model?: string }
        | { id: string; ok: true; result: unknown }
        | { id: string; ok: false; error: string };
      const p = pending.get(msg.id);
      if (!p) return;
      if ("event" in msg) {
        // streaming frame; `model` is set for panel fan-out, undefined otherwise
        p.onEvent?.({ event: msg.event, data: msg.data, model: msg.model });
        return;
      }
      pending.delete(msg.id); // final response
      if (msg.ok) p.resolve(msg.result);
      else p.reject(new Error(msg.error));
    });
    ws.addEventListener("error", onDown);
    ws.addEventListener("close", onDown);
  }

  openSocket();

  async function call<T>(
    method: string,
    params: Record<string, unknown>,
    onEvent?: (e: RpcEvent) => void,
  ): Promise<T> {
    const id = `f${++counter}`;
    return new Promise<T>((resolve, reject) => {
      const item = { resolve: resolve as (v: unknown) => void, reject, onEvent };
      if (ws.readyState === WS_OPEN) {
        pending.set(id, item);
        ws.send(JSON.stringify({ id, method, params }));
      } else {
        // Disconnected (or still connecting) right now — hold the call rather than reject
        // immediately; it's sent as soon as the next reconnect succeeds, or rejected if that
        // takes longer than QUEUE_GRACE_MS.
        const timer = setTimeout(() => {
          queue.delete(id);
          reject(new Error(LOST_CONNECTION_MESSAGE));
        }, QUEUE_GRACE_MS);
        queue.set(id, { ...item, method, params, timer });
      }
    });
  }

  function close(): void {
    closed = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    rejectAllPending(new Error(LOST_CONNECTION_MESSAGE));
    for (const q of queue.values()) {
      clearTimeout(q.timer);
      q.reject(new Error(LOST_CONNECTION_MESSAGE));
    }
    queue.clear();
    ws.close();
  }

  return { call, close };
}
