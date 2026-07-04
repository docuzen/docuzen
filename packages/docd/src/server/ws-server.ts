import { WebSocketServer } from "ws";
import type { AgentRunner } from "../agent/types.js";
import type { HarnessRegistry } from "../agent/index.js";
import { RpcHandler } from "../rpc/handler.js";
import type { RpcRequest, RpcResponse } from "../rpc/types.js";

export interface StartServerOptions {
  /** Port to listen on. Use 0 for an OS-assigned ephemeral port. */
  port?: number;
  host?: string;
  runner?: AgentRunner;
  registry?: HarnessRegistry;
  now: () => string;
  /** System user name; default author for new comments + human turns. */
  author?: string;
}

export interface RunningServer {
  port: number;
  close: () => Promise<void>;
}

/**
 * Minimal WebSocket transport over RpcHandler. Each message is one RpcRequest
 * JSON; each reply is one RpcResponse JSON. Malformed input yields an error
 * response rather than crashing the connection.
 */
export function startServer(opts: StartServerOptions): Promise<RunningServer> {
  const handler = new RpcHandler({
    ...(opts.registry ? { registry: opts.registry } : { runner: opts.runner! }),
    now: opts.now,
    author: opts.author,
  });
  const wss = new WebSocketServer({ port: opts.port ?? 0, host: opts.host ?? "127.0.0.1" });

  wss.on("connection", (socket) => {
    socket.on("message", async (data) => {
      let req: RpcRequest | undefined;
      try {
        req = JSON.parse(data.toString()) as RpcRequest;
      } catch {
        const err: RpcResponse = { id: "", ok: false, error: "invalid JSON" };
        socket.send(JSON.stringify(err));
        return;
      }
      // Intermediate streaming frames carry the request id + {event,data};
      // the final RpcResponse carries {ok,...}. The client distinguishes by key.
      const res = await handler.handle(req, (frame) =>
        socket.send(JSON.stringify({ id: req!.id, ...frame })),
      );
      socket.send(JSON.stringify(res));
    });
  });

  return new Promise((resolve, reject) => {
    wss.on("error", reject);
    wss.on("listening", () => {
      const addr = wss.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({
        port,
        close: () =>
          new Promise<void>((res) => {
            handler.closeAll();
            wss.close(() => res());
          }),
      });
    });
  });
}
