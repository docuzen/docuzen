import { describe, expect, test } from "vitest";
import type { ModelConfig } from "../../src/agent/model-registry.js";
import { selectRunner } from "../../src/server/select-runner.js";

const gpt: ModelConfig = { key: "litellm/gpt-5.5", name: "GPT-5.5", provider: "litellm", modelId: "gpt-5.5", hasKey: true };
const keyless: ModelConfig = { key: "litellm/gpt-5.5", name: "GPT-5.5", provider: "litellm", modelId: "gpt-5.5", hasKey: false };
const other: ModelConfig = { key: "acme/big", name: "Big", provider: "acme", modelId: "big", hasKey: true };

describe("selectRunner — is pi usable?", () => {
  test("LLM_API_KEY env wins (dev override), honoring env provider/model", () => {
    const s = selectRunner({
      env: { LLM_API_KEY: "k", LLM_PROVIDER: "openai", LLM_MODEL: "o5" },
      config: { harness: null },
      models: [],
    });
    expect(s).toMatchObject({ live: true, provider: "openai", modelId: "o5" });
  });

  test("configured pi model with a stored key goes live", () => {
    const s = selectRunner({
      env: {},
      config: { harness: { default: "pi" }, pi: { model: "litellm/gpt-5.5" } },
      models: [gpt],
    });
    expect(s).toMatchObject({ live: true, provider: "litellm", modelId: "gpt-5.5", defaultHarness: "pi" });
  });

  test("configured pi model without a key stays offline, and is never swapped for another model", () => {
    const s = selectRunner({
      env: {},
      config: { harness: { default: "pi" }, pi: { model: "litellm/gpt-5.5" } },
      models: [keyless, other],
    });
    expect(s.live).toBe(false);
    expect(s.reason).toBe("pi model litellm/gpt-5.5 has no usable entry in models.json");
  });

  test("no configured pi model: the first model with a stored key is used", () => {
    const s = selectRunner({ env: {}, config: { harness: { default: "pi" } }, models: [keyless, other] });
    expect(s).toMatchObject({ live: true, provider: "acme", modelId: "big", defaultHarness: "pi" });
  });

  test("no configured pi model and no keyed model: offline with an explanation", () => {
    const s = selectRunner({ env: {}, config: { harness: { default: "pi" } }, models: [keyless] });
    expect(s).toMatchObject({
      live: false,
      defaultHarness: "pi",
      reason: "no pi model is configured and models.json has no model with a stored key",
    });
  });

  test("pi stays usable when codex is the default harness", () => {
    const s = selectRunner({
      env: {},
      config: { harness: { default: "codex" }, pi: { model: "litellm/gpt-5.5" } },
      models: [gpt],
    });
    expect(s).toMatchObject({ live: true, modelId: "gpt-5.5", defaultHarness: "codex" });
  });
});

describe("selectRunner — default harness", () => {
  test("a configured default always wins, usable or not", () => {
    const s = selectRunner({ env: {}, config: { harness: { default: "pi" } }, models: [], codexAvailable: true });
    expect(s).toMatchObject({ live: false, defaultHarness: "pi" });
  });

  test("unconfigured: pi when pi is usable", () => {
    const s = selectRunner({ env: {}, config: { harness: null }, models: [gpt], codexAvailable: true });
    expect(s).toMatchObject({ live: true, defaultHarness: "pi" });
  });

  test("unconfigured: codex when pi is not usable but the codex CLI is present", () => {
    const s = selectRunner({ env: {}, config: { harness: null }, models: [], codexAvailable: true });
    expect(s).toMatchObject({ live: false, defaultHarness: "codex" });
  });

  test("unconfigured and nothing usable: pi, so the error names the missing model", () => {
    const s = selectRunner({ env: {}, config: { harness: null }, models: [], codexAvailable: false });
    expect(s).toMatchObject({ live: false, defaultHarness: "pi" });
  });
});
