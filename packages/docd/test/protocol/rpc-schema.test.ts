import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { FakePiRunner } from "../../src/agent/fake-runner.js";
import { RpcHandler } from "../../src/rpc/handler.js";

// Type agreement between RpcSchema and the handler is a COMPILE-time guarantee:
// handler.ts's `RpcHandlers` mapped type makes a missing method, a wrong params shape,
// or a wrong result shape a tsc error. What tsc can't see is the runtime lookup, so
// this checks that every method named in the schema source actually dispatches.
const here = dirname(fileURLToPath(import.meta.url));
const schemaSrc = readFileSync(resolve(here, "../../src/protocol/rpc.ts"), "utf8");
const schemaMethods = [...schemaSrc.matchAll(/^  (\w+): \{/gm)].map((m) => m[1]).sort();

let dir: string;
let handler: RpcHandler;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rpc-schema-"));
  process.env.DOCUZEN_CONFIG_DIR = dir;
  handler = new RpcHandler({ runner: new FakePiRunner([]), now: () => "t", modelsPath: join(dir, "models.json") });
});
afterEach(() => {
  handler.closeAll();
  delete process.env.DOCUZEN_CONFIG_DIR;
  rmSync(dir, { recursive: true, force: true });
});

describe("RpcSchema ↔ handler", () => {
  it("lists the wire methods", () => {
    expect(schemaMethods.length).toBeGreaterThanOrEqual(34);
  });

  it("dispatches every schema method (none is reported as unknown)", async () => {
    for (const method of schemaMethods) {
      // Bogus params: each handler may fail on them, but it must be THAT handler failing.
      const res = await handler.handle({ id: method, method, params: { docPath: join(dir, "missing.md") } });
      if (!res.ok) expect(res.error, method).not.toContain("unknown method");
    }
  });

  it("rejects names that only exist on Object.prototype", async () => {
    for (const method of ["constructor", "toString", "__proto__", "hasOwnProperty", ""]) {
      const res = await handler.handle({ id: "x", method, params: {} });
      expect(res).toEqual({ id: "x", ok: false, error: `unknown method: ${method}` });
    }
  });
});
