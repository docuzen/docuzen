import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakePiRunner } from "../../src/agent/fake-runner.js";
import { HarnessRegistry } from "../../src/agent/harness-registry.js";
import { readAppConfig } from "../../src/config/app-config.js";
import { RpcHandler } from "../../src/rpc/handler.js";

let handler: RpcHandler;

beforeEach(() => {
  process.env.DOCUZEN_CONFIG_DIR = mkdtempSync(join(tmpdir(), "docuzen-rpc-config-"));
  handler = new RpcHandler({
    registry: HarnessRegistry.single(new FakePiRunner([])),
    modelsPath: join(process.env.DOCUZEN_CONFIG_DIR, "models.json"),
  });
});

afterEach(() => {
  delete process.env.DOCUZEN_CONFIG_DIR;
});

describe("app config over RPC", () => {
  test("getAppConfig on a fresh machine: unconfigured, nothing usable", async () => {
    const res = await handler.handle({ id: "1", method: "getAppConfig", params: {} });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.result).toMatchObject({ config: { harness: null }, piUsable: false });
  });

  test("setAppConfig persists and getAppConfig reflects it", async () => {
    const config = { harness: { default: "pi" as const }, pi: { model: "litellm/gpt-5.5" } };
    const set = await handler.handle({ id: "2", method: "setAppConfig", params: { config } });
    expect(set.ok).toBe(true);
    expect(readAppConfig().harness).toEqual({ default: "pi" });
    const get = await handler.handle({ id: "3", method: "getAppConfig", params: {} });
    expect(get.ok).toBe(true);
    if (!get.ok) return;
    // configured, but the temp models.json is empty -> pi not usable yet
    expect(get.result).toMatchObject({ config, piUsable: false });
  });
});
