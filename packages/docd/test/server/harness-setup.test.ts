import { describe, expect, test, vi } from "vitest";
import { createCodexHarness } from "../../src/agent/codex-runner.js";
import { FakePiRunner } from "../../src/agent/fake-runner.js";
import type { AppConfig } from "../../src/config/app-config.js";
import { setupHarnesses } from "../../src/server/harness-setup.js";
import { selectRunner } from "../../src/server/select-runner.js";
import type { ModelConfig } from "../../src/agent/model-registry.js";

const keyed: ModelConfig = { key: "litellm/gpt-5.5", name: "GPT-5.5", provider: "litellm", modelId: "gpt-5.5", hasKey: true };
const codex = (available: boolean) =>
  createCodexHarness({
    detect: () => (available ? { available, command: "codex", version: "codex 1.0" } : { available, command: "codex", reason: "codex not found on PATH" }),
    runner: new FakePiRunner([]),
  });

async function setup(config: AppConfig, codexAvailable: boolean, createPi: () => Promise<FakePiRunner>) {
  const codexHarness = codex(codexAvailable);
  const sel = selectRunner({ env: {}, config, models: [keyed], codexAvailable });
  return setupHarnesses({ sel, config, codex: codexHarness, createPi });
}

describe("setupHarnesses — the default is chosen once pi init has settled", () => {
  test("pi looked usable but failed to start: an unconfigured install falls back to codex", async () => {
    const { registry, piOfflineReason } = await setup({ harness: null }, true, () =>
      Promise.reject(new Error("pi model litellm/gpt-5.5 not found")),
    );
    expect(registry.defaultId()).toBe("codex");
    expect(piOfflineReason).toBe("pi model litellm/gpt-5.5 not found");
    expect(registry.list().find((h) => h.id === "pi")).toMatchObject({
      available: false,
      unavailableReason: "pi model litellm/gpt-5.5 not found",
    });
    expect(registry.resolve().id).toBe("codex");
  });

  test("pi failed and codex is missing too: pi stays the default, so the error names pi's problem", async () => {
    const { registry } = await setup({ harness: null }, false, () => Promise.reject(new Error("boom")));
    expect(registry.defaultId()).toBe("pi");
    expect(() => registry.resolve()).toThrow(/pi: boom/);
  });

  test("pi started: pi is the default", async () => {
    const createPi = vi.fn(async () => new FakePiRunner([]));
    const { registry, piOfflineReason } = await setup({ harness: null }, true, createPi);
    expect(createPi).toHaveBeenCalledOnce();
    expect(registry.defaultId()).toBe("pi");
    expect(piOfflineReason).toBeNull();
    expect(registry.resolve().available).toBe(true);
  });

  test("a configured default is kept even when that harness failed to start", async () => {
    const { registry } = await setup({ harness: { default: "pi" } }, true, () => Promise.reject(new Error("boom")));
    expect(registry.defaultId()).toBe("pi");
  });

  test("pi is not constructed when no model is usable", async () => {
    const createPi = vi.fn(async () => new FakePiRunner([]));
    const config: AppConfig = { harness: null };
    const sel = selectRunner({ env: {}, config, models: [], codexAvailable: true });
    const { registry, piOfflineReason } = await setupHarnesses({ sel, config, codex: codex(true), createPi });
    expect(createPi).not.toHaveBeenCalled();
    expect(registry.defaultId()).toBe("codex");
    expect(piOfflineReason).toBe(sel.reason);
  });
});
