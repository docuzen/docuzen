export interface RpcRequest {
  id: string;
  method: string;
  params: Record<string, unknown>;
}

export type RpcResponse =
  | { id: string; ok: true; result: unknown }
  | { id: string; ok: false; error: string };

/** An intermediate streaming frame emitted before the final RpcResponse. */
export interface RpcEvent {
  event: string;
  data: unknown;
  /** Set by panel fan-out to tag which model produced this frame; unset otherwise. */
  model?: string;
}
export type RpcEmit = (e: RpcEvent) => void;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The id to answer a wire frame with: its own string `id`, or "" when it has none. */
export function rpcRequestId(value: unknown): string {
  return isPlainObject(value) && typeof value.id === "string" ? value.id : "";
}

/**
 * Narrow a parsed wire frame to an RpcRequest, or say why it isn't one. The frame comes
 * off a socket, so anything JSON can express arrives here: null, numbers, arrays.
 * Missing `params` is read as `{}` (a method that takes none needs none sent).
 */
export function parseRpcRequest(value: unknown): { ok: true; req: RpcRequest } | { ok: false; error: string } {
  if (!isPlainObject(value)) return { ok: false, error: "invalid request: expected a JSON object" };
  if (typeof value.method !== "string") return { ok: false, error: "invalid request: method must be a string" };
  const params = value.params ?? {};
  if (!isPlainObject(params)) return { ok: false, error: "invalid request: params must be an object" };
  return { ok: true, req: { id: rpcRequestId(value), method: value.method, params } };
}
