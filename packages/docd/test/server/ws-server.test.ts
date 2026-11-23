import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, access, symlink } from "node:fs/promises";
import { connect as tcpConnect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { startServer } from "../../src/server/ws-server.js";
import { FakePiRunner } from "../../src/agent/fake-runner.js";
import { hadPaths } from "../../src/had/paths.js";

const TOKEN = "test-launch-token-0123456789abcdef";
let dir: string;
let docPath: string;
let server: { port: number; close: () => Promise<void> };
const DOC = "We store limits in Redis with a TTL.\n";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ws-"));
  docPath = join(dir, "plan.md");
  await writeFile(docPath, DOC, "utf8");
  server = await startServer({
    port: 0,
    token: TOKEN,
    runner: new FakePiRunner([]),
    now: () => "2026-06-13T10:00:00.000Z",
  });
});
afterEach(async () => {
  await server.close();
  await rm(dir, { recursive: true, force: true });
});

const wsUrl = (port: number, token: string | null = TOKEN) =>
  token === null ? `ws://127.0.0.1:${port}` : `ws://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`;

/** Send one raw frame over a fresh authorised client and resolve the first reply. */
function rawRpc(port: number, frame: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl(port));
    ws.on("open", () => ws.send(frame));
    ws.on("message", (data) => {
      ws.close();
      resolve(JSON.parse(data.toString()));
    });
    ws.on("error", reject);
  });
}

/** Send one request over a fresh client and resolve the matching response. */
const rpc = (port: number, req: unknown): Promise<any> => rawRpc(port, JSON.stringify(req));

/** "open" when the upgrade is accepted, otherwise the HTTP status the server refused it with. */
function upgradeOutcome(url: string, origin?: string): Promise<"open" | number> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, origin ? { origin } : {});
    ws.on("open", () => {
      ws.close();
      resolve("open");
    });
    ws.on("unexpected-response", (_req, res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    ws.on("error", reject);
  });
}

describe("ws-server", () => {
  it("listens on a real port", () => {
    expect(server.port).toBeGreaterThan(0);
  });

  it("refuses to start without a token", async () => {
    await expect(startServer({ port: 0, token: "", runner: new FakePiRunner([]), now: () => "t" })).rejects.toThrow(
      /token/,
    );
  });

  it("dispatches openDoc and echoes the request id", async () => {
    const res = await rpc(server.port, { id: "r1", method: "openDoc", params: { docPath } });
    expect(res.id).toBe("r1");
    expect(res.ok).toBe(true);
    expect(res.result.text).toContain("Redis");
  });

  it("createAnnotation over the socket persists to annotations.json on disk", async () => {
    await rpc(server.port, {
      id: "r2",
      method: "createAnnotation",
      params: {
        docPath,
        kind: "highlight",
        anchor: { exact: "Redis", prefix: "in ", suffix: " with" },
        color: "blue",
      },
    });
    await expect(access(hadPaths(docPath).annotations)).resolves.toBeUndefined();
    const list = await rpc(server.port, { id: "r3", method: "listAnnotations", params: { docPath } });
    expect(list.result).toHaveLength(1);
    expect(list.result[0].color).toBe("blue");
  });

  it("streams discuss token frames then a final ok response", async () => {
    const s = await startServer({
      port: 0,
      token: TOKEN,
      runner: new FakePiRunner([{ reply: "hello there" }]),
      now: () => "t",
    });
    await rpc(s.port, {
      id: "a",
      method: "createAnnotation",
      params: { docPath, kind: "comment", anchor: { exact: "Redis", prefix: "", suffix: "" }, color: "pink" },
    });

    const frames = await new Promise<any[]>((resolve, reject) => {
      const got: any[] = [];
      const ws = new WebSocket(wsUrl(s.port));
      ws.on("open", () =>
        ws.send(
          JSON.stringify({
            id: "d",
            method: "discuss",
            params: { docPath, threadId: "c0001", annotationId: "c0001", stance: "none", comment: "Why?" },
          }),
        ),
      );
      ws.on("message", (data) => {
        const msg = JSON.parse(data.toString());
        got.push(msg);
        if ("ok" in msg) {
          ws.close();
          resolve(got);
        }
      });
      ws.on("error", reject);
    });

    await s.close();
    expect(frames.some((f) => f.event === "token" && f.id === "d")).toBe(true);
    expect(frames.at(-1).ok).toBe(true);
  });

  it("returns ok:false for malformed JSON rather than crashing", async () => {
    const res = await rawRpc(server.port, "not json");
    expect(res.ok).toBe(false);
  });

  it("answers non-request JSON with an error and stays up", async () => {
    for (const frame of ["null", "42", '"openDoc"', "[]", '[{"id":"x","method":"openDoc"}]', "{}", '{"id":"m","method":5}']) {
      const res = await rawRpc(server.port, frame);
      expect(res, frame).toMatchObject({ ok: false });
      expect(typeof res.error, frame).toBe("string");
    }
    // An id is echoed whenever the frame carried a string one, so the client can settle that call.
    expect(await rawRpc(server.port, '{"id":"m","method":5}')).toMatchObject({ id: "m", ok: false });
    expect(await rawRpc(server.port, '{"id":"p","method":"openDoc","params":7}')).toMatchObject({ id: "p", ok: false });
    const res = await rpc(server.port, { id: "after", method: "openDoc", params: { docPath } });
    expect(res).toMatchObject({ id: "after", ok: true });
  });

  it("survives a client that sends an invalid WebSocket frame", async () => {
    // Speak the handshake by hand, then send a frame a browser never could: client frames
    // must be masked, so this one is a protocol error on the server side.
    await new Promise<void>((resolve, reject) => {
      const sock = tcpConnect(server.port, "127.0.0.1", () => {
        sock.write(
          `GET /?token=${TOKEN} HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
            "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n",
        );
      });
      let upgraded = false;
      sock.on("data", (d) => {
        if (!upgraded && d.toString().startsWith("HTTP/1.1 101")) {
          upgraded = true;
          sock.write(Buffer.from([0x81, 0x05, 0x68, 0x65, 0x6c, 0x6c, 0x6f])); // unmasked "hello"
        }
      });
      sock.on("close", () => (upgraded ? resolve() : reject(new Error("upgrade refused"))));
      sock.on("error", () => {});
    });
    const res = await rpc(server.port, { id: "alive", method: "openDoc", params: { docPath } });
    expect(res).toMatchObject({ id: "alive", ok: true });
  });

  describe("who may connect", () => {
    it("refuses a client with no token or the wrong token, before upgrading", async () => {
      expect(await upgradeOutcome(wsUrl(server.port, null))).toBe(401);
      expect(await upgradeOutcome(wsUrl(server.port, ""))).toBe(401);
      expect(await upgradeOutcome(wsUrl(server.port, "wrong"))).toBe(401);
      expect(await upgradeOutcome(wsUrl(server.port, `${TOKEN}x`))).toBe(401);
      expect(await upgradeOutcome(wsUrl(server.port, TOKEN.slice(0, -1)))).toBe(401);
    });

    it("accepts the right token without an Origin header (node tools)", async () => {
      expect(await upgradeOutcome(wsUrl(server.port))).toBe("open");
    });

    it("accepts the app's webview origins and loopback dev servers", async () => {
      for (const origin of [
        "tauri://localhost",
        "http://tauri.localhost",
        "https://tauri.localhost",
        "http://localhost:1420",
        "http://127.0.0.1:4610",
        "http://[::1]:1420",
      ]) {
        expect(await upgradeOutcome(wsUrl(server.port), origin), origin).toBe("open");
      }
    });

    it("refuses a foreign Origin even with the right token", async () => {
      for (const origin of [
        "https://evil.example",
        "http://evil.example",
        "null",
        "file://",
        "https://localhost:1420",
        "http://localhost.evil.example",
        "http://127.0.0.1.nip.io:1420",
        "tauri://evil",
      ]) {
        expect(await upgradeOutcome(wsUrl(server.port), origin), origin).toBe(403);
      }
    });

    it("a refused page learns nothing: no RPC reaches the handler", async () => {
      const outcome = await upgradeOutcome(wsUrl(server.port), "https://evil.example");
      expect(outcome).toBe(403);
      await expect(access(hadPaths(docPath).annotations)).rejects.toThrow();
    });
  });

  describe("GET /image", () => {
    const image = (path: string, token: string | null = TOKEN, init?: RequestInit) =>
      fetch(
        `http://127.0.0.1:${server.port}/image?path=${encodeURIComponent(path)}` +
          (token === null ? "" : `&token=${encodeURIComponent(token)}`),
        init,
      );

    it("serves a document's images over HTTP, and nothing else", async () => {
      const png = join(dir, "pic one.png");
      await writeFile(png, Buffer.from([1, 2, 3]));
      const ok = await image(png);
      expect(ok.status).toBe(200);
      expect(ok.headers.get("content-type")).toBe("image/png");
      expect(new Uint8Array(await ok.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
      // Not an image: the markdown document itself is never served.
      expect((await image(docPath)).status).toBe(400);
      expect((await image(join(dir, "missing.png"))).status).toBe(404);
      expect((await image("relative.png")).status).toBe(400);
      expect((await fetch(`http://127.0.0.1:${server.port}/other?token=${TOKEN}`)).status).toBe(404);
      expect((await image(png, TOKEN, { method: "POST" })).status).toBe(405);
    });

    it("requires the launch token", async () => {
      const png = join(dir, "pic.png");
      await writeFile(png, Buffer.from([1, 2, 3]));
      expect((await image(png, null)).status).toBe(401);
      expect((await image(png, "")).status).toBe(401);
      expect((await image(png, "wrong")).status).toBe(401);
      expect((await image(png, TOKEN)).status).toBe(200);
    });

    it("judges the file a symlink points at, not the link's name", async () => {
      const png = join(dir, "real.png");
      await writeFile(png, Buffer.from([4, 5, 6]));
      const disguised = join(dir, "secret.png");
      await symlink(docPath, disguised); // looks like an image, is the markdown file
      expect((await image(disguised)).status).toBe(400);
      const alias = join(dir, "alias.png");
      await symlink(png, alias); // an image reached through a link is still an image
      const res = await image(alias);
      expect(res.status).toBe(200);
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([4, 5, 6]));
    });

    it("refuses directories that look like images", async () => {
      const fake = join(dir, "folder.png");
      await import("node:fs/promises").then((fs) => fs.mkdir(fake));
      expect((await image(fake)).status).toBe(404);
    });
  });
});
