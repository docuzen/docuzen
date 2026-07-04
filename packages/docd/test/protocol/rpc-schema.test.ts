import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// The schema is types-only, so runtime assertions are limited; what we CAN
// verify mechanically is name parity: every handler case appears in the
// schema source and vice versa. Type agreement is enforced by Task 4's
// typed dispatch (a schema/handler mismatch becomes a tsc error there).
const here = dirname(fileURLToPath(import.meta.url));
const handlerSrc = readFileSync(resolve(here, "../../src/rpc/handler.ts"), "utf8");
const schemaSrc = readFileSync(resolve(here, "../../src/protocol/rpc.ts"), "utf8");

const handlerMethods = [...handlerSrc.matchAll(/case "(\w+)"/g)].map((m) => m[1]).sort();
const schemaMethods = [...schemaSrc.matchAll(/^  (\w+): \{/gm)].map((m) => m[1]).sort();

describe("RpcSchema", () => {
  it("covers exactly the handler's methods", () => {
    expect(schemaMethods).toEqual(handlerMethods);
  });
});
