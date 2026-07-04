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
