import { describe, expect, test } from "vitest";
import type { ModelConfig } from "../../src/agent/model-registry.js";
import { selectRunner } from "../../src/server/select-runner.js";

const gpt: ModelConfig = { key: "litellm/gpt-5.5", name: "GPT-5.5", provider: "litellm", modelId: "gpt-5.5", hasKey: true };
const keyless: ModelConfig = { key: "litellm/gpt-5.5", name: "GPT-5.5", provider: "litellm", modelId: "gpt-5.5", hasKey: false };

describe("selectRunner", () => {
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

  test("configured pi model without a key stays offline", () => {
    const s = selectRunner({
      env: {},
      config: { harness: { default: "pi" }, pi: { model: "litellm/gpt-5.5" } },
      models: [keyless],
    });
    expect(s.live).toBe(false);
  });

  test("codex harness: pi side stays offline but default harness is codex", () => {
    const s = selectRunner({ env: {}, config: { harness: { default: "codex" } }, models: [] });
    expect(s).toMatchObject({ live: false, defaultHarness: "codex" });
  });

  test("unconfigured: offline with pi defaults", () => {
    const s = selectRunner({ env: {}, config: { harness: null }, models: [gpt] });
    expect(s).toMatchObject({ live: false, defaultHarness: "pi", provider: "litellm", modelId: "gpt-5.5" });
  });
});
