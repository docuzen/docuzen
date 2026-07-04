import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { startServer } from "../../src/server/ws-server.js";
import { FakePiRunner } from "../../src/agent/fake-runner.js";
import { hadPaths } from "../../src/had/paths.js";

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
    runner: new FakePiRunner([]),
    now: () => "2026-06-13T10:00:00.000Z",
  });
});
afterEach(async () => {
  await server.close();
  await rm(dir, { recursive: true, force: true });
});

/** Send one request over a fresh client and resolve the matching response. */
function rpc(port: number, req: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.on("open", () => ws.send(JSON.stringify(req)));
    ws.on("message", (data) => {
      ws.close();
      resolve(JSON.parse(data.toString()));
    });
    ws.on("error", reject);
  });
}

describe("ws-server", () => {
  it("listens on a real port", () => {
    expect(server.port).toBeGreaterThan(0);
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
      const ws = new WebSocket(`ws://127.0.0.1:${s.port}`);
      ws.on("open", () =>
        ws.send(
          JSON.stringify({
            id: "d",
            method: "discuss",
            params: { docPath, threadId: "t1", annotationId: "c0001", stance: "none", comment: "Why?" },
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
    expect(frames.some((f) => f.event === "token")).toBe(true);
    expect(frames.at(-1).ok).toBe(true);
  });

  it("returns ok:false for malformed JSON rather than crashing", async () => {
    const res = await new Promise<any>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${server.port}`);
      ws.on("open", () => ws.send("not json"));
      ws.on("message", (data) => {
        ws.close();
        resolve(JSON.parse(data.toString()));
      });
      ws.on("error", reject);
    });
    expect(res.ok).toBe(false);
  });
});
