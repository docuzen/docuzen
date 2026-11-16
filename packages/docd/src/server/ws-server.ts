import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { isAbsolute } from "node:path";
import { WebSocketServer } from "ws";
import { imageMimeType } from "../had/assets.js";
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
 * `GET /image?path=<absolute path>` — the one plain-HTTP route. The webview cannot load
 * `file://` images (its page is not a file origin), so a document's images come through
 * here. Images only, by extension: this is not a general file server. Served so that a
 * direct navigation to it (an SVG, say) can run nothing.
 */
async function serveImage(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const fail = (status: number, message: string): void => {
    res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(message);
  };
  if (req.method !== "GET" && req.method !== "HEAD") return fail(405, "method not allowed");
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (url.pathname !== "/image") return fail(404, "not found");
  const path = url.searchParams.get("path") ?? "";
  const type = imageMimeType(path);
  if (!isAbsolute(path) || !type) return fail(400, "not an image path");
  const info = await stat(path).catch(() => null);
  if (!info?.isFile()) return fail(404, "no such image");
  res.writeHead(200, {
    "Content-Type": type,
    "Content-Length": info.size,
    "Cache-Control": "no-cache",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    "Cross-Origin-Resource-Policy": "cross-origin",
  });
  if (req.method === "HEAD") return void res.end();
  createReadStream(path)
    .on("error", () => res.destroy())
    .pipe(res);
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
  const http = createServer((req, res) => {
    void serveImage(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  const wss = new WebSocketServer({ server: http });

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
    http.on("error", reject);
    http.listen(opts.port ?? 0, opts.host ?? "127.0.0.1", () => {
      const addr = http.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({
        port,
        close: () =>
          new Promise<void>((res) => {
            handler.closeAll();
            for (const client of wss.clients) client.terminate();
            wss.close();
            http.closeAllConnections();
            http.close(() => res());
          }),
      });
    });
  });
}
