import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { createServer, STATUS_CODES, type IncomingMessage, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { isAbsolute } from "node:path";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { imageMimeType } from "../had/assets.js";
import type { AgentRunner } from "../agent/types.js";
import type { HarnessRegistry } from "../agent/index.js";
import { RpcHandler } from "../rpc/handler.js";
import { rpcRequestId, type RpcResponse } from "../rpc/types.js";
import { isAllowedOrigin, tokenMatches } from "./access.js";

export interface StartServerOptions {
  /** Port to listen on. Use 0 for an OS-assigned ephemeral port. */
  port?: number;
  host?: string;
  runner?: AgentRunner;
  registry?: HarnessRegistry;
  now: () => string;
  /** System user name; default author for new comments + human turns. */
  author?: string;
  /**
   * The launch secret. Every WebSocket client and every `/image` request must carry it as
   * `?token=`; nothing is served without it (see access.ts for why loopback is not enough).
   */
  token: string;
}

export interface RunningServer {
  port: number;
  close: () => Promise<void>;
}

/**
 * `GET /image?path=<absolute path>&token=<launch token>` — the one plain-HTTP route. The
 * webview cannot load `file://` images (its page is not a file origin), so a document's
 * images come through here. Images only: the path is resolved through any symlinks first,
 * and the file it really is must have an image extension and be a regular file — this is
 * not a general file server. Served so that a direct navigation to it (an SVG, say) can
 * run nothing.
 *
 * `Cross-Origin-Resource-Policy` stays `cross-origin`: the packaged page is
 * `tauri://localhost` and this server is `http://127.0.0.1:<port>`, a different site, so
 * `same-site` would make the webview block the app's own `<img>` loads. What keeps other
 * pages out is the token, which they cannot know, not CORP.
 */
async function serveImage(req: IncomingMessage, res: ServerResponse, token: string): Promise<void> {
  const fail = (status: number, message: string): void => {
    res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(message);
  };
  if (req.method !== "GET" && req.method !== "HEAD") return fail(405, "method not allowed");
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (url.pathname !== "/image") return fail(404, "not found");
  if (!tokenMatches(url.searchParams.get("token"), token)) return fail(401, "unauthorized");
  const requested = url.searchParams.get("path") ?? "";
  if (!isAbsolute(requested) || !imageMimeType(requested)) return fail(400, "not an image path");
  const path = await realpath(requested).catch(() => null);
  if (!path) return fail(404, "no such image");
  const type = imageMimeType(path);
  if (!type) return fail(400, "not an image path");
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

/** Why a WebSocket upgrade is refused, as an HTTP status, or null to accept it. */
function upgradeRefusal(req: IncomingMessage, token: string): 401 | 403 | null {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (!tokenMatches(url.searchParams.get("token"), token)) return 401;
  // Browsers always send Origin on a WebSocket handshake; node clients (the tools) don't.
  const origin = req.headers.origin;
  if (origin !== undefined && !isAllowedOrigin(origin)) return 403;
  return null;
}

function refuseUpgrade(socket: Duplex, status: 401 | 403): void {
  const body = STATUS_CODES[status] ?? "refused";
  socket.on("error", () => {});
  socket.end(
    `HTTP/1.1 ${status} ${body}\r\nConnection: close\r\nContent-Type: text/plain\r\n` +
      `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
  );
  socket.once("finish", () => socket.destroy());
}

/**
 * Minimal WebSocket transport over RpcHandler. Each message is one RpcRequest
 * JSON; each reply is one RpcResponse JSON. Malformed input — bad JSON, JSON that isn't a
 * request, a broken frame — gets an error response or a closed socket, never a crash:
 * one bad client must not take the sidecar (and every open tab) down with it.
 */
export function startServer(opts: StartServerOptions): Promise<RunningServer> {
  if (!opts.token) return Promise.reject(new Error("startServer needs a launch token"));
  const token = opts.token;
  const handler = new RpcHandler({
    ...(opts.registry ? { registry: opts.registry } : { runner: opts.runner! }),
    now: opts.now,
    author: opts.author,
  });
  const http = createServer((req, res) => {
    void serveImage(req, res, token).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  // noServer: the upgrade is ours to refuse before ws sees it (and the http server's own
  // errors are not re-emitted on a listener-less WebSocketServer).
  const wss = new WebSocketServer({ noServer: true });
  wss.on("error", (e) => console.error(`docd: websocket server error: ${e.message}`));
  http.on("upgrade", (req, socket, head) => {
    const refusal = upgradeRefusal(req, token);
    if (refusal) return refuseUpgrade(socket, refusal);
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  wss.on("connection", (socket) => {
    // A protocol error (an unmasked or oversized frame…) is emitted here and ws closes the
    // socket itself; without a listener it would be an uncaught exception.
    socket.on("error", () => {});
    const send = (msg: unknown): void => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
    };
    const onMessage = async (data: RawData): Promise<void> => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(data.toString());
      } catch {
        const err: RpcResponse = { id: "", ok: false, error: "invalid JSON" };
        return send(err);
      }
      // Intermediate streaming frames carry the request id + {event,data};
      // the final RpcResponse carries {ok,...}. The client distinguishes by key.
      const id = rpcRequestId(parsed);
      send(await handler.handle(parsed, (frame) => send({ id, ...frame })));
    };
    socket.on("message", (data) => {
      onMessage(data).catch((e: unknown) => {
        console.error(`docd: websocket message failed: ${e instanceof Error ? e.message : String(e)}`);
      });
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
