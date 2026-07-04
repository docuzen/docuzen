import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listModels, saveModels } from "../../src/agent/model-registry.js";

let dir: string;
let p: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "models-"));
  p = join(dir, "models.json");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("model-registry", () => {
  it("round-trips models, never leaking the api key, with hasKey", async () => {
    await saveModels(p, [
      {
        key: "litellm/gpt-5.5",
        name: "GPT-5.5",
        provider: "litellm",
        modelId: "gpt-5.5",
        baseUrl: "https://h/v1",
        reasoningEffort: "medium",
        apiKey: "sk-secret",
      },
    ]);
    const list = await listModels(p);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      key: "litellm/gpt-5.5",
      name: "GPT-5.5",
      provider: "litellm",
      modelId: "gpt-5.5",
      baseUrl: "https://h/v1",
      reasoningEffort: "medium",
      hasKey: true,
    });
    expect((list[0] as unknown as Record<string, unknown>).apiKey).toBeUndefined();
    // file is valid pi shape with the key on disk
    const raw = JSON.parse(await readFile(p, "utf8"));
    expect(raw.providers.litellm.apiKey).toBe("sk-secret");
    expect(raw.providers.litellm.api).toBe("openai-completions");
    expect(raw.providers.litellm.models[0].id).toBe("gpt-5.5");
  });

  it("supports multiple providers + models", async () => {
    await saveModels(p, [
      {
        key: "litellm/gpt-5.5",
        name: "GPT",
        provider: "litellm",
        modelId: "gpt-5.5",
        baseUrl: "https://a/v1",
        apiKey: "k1",
      },
      {
        key: "anthropic/claude",
        name: "Claude",
        provider: "anthropic",
        modelId: "claude",
        baseUrl: "https://b",
        apiKey: "k2",
      },
    ]);
    const list = await listModels(p);
    expect(list.map((m) => m.key).sort()).toEqual([
      "anthropic/claude",
      "litellm/gpt-5.5",
    ]);
  });

  it("preserves an existing api key when a save omits it (edit non-secret fields)", async () => {
    await saveModels(p, [
      {
        key: "litellm/gpt-5.5",
        name: "GPT",
        provider: "litellm",
        modelId: "gpt-5.5",
        apiKey: "sk-keep",
      },
    ]);
    await saveModels(p, [
      {
        key: "litellm/gpt-5.5",
        name: "GPT renamed",
        provider: "litellm",
        modelId: "gpt-5.5",
      },
    ]); // no apiKey
    const raw = JSON.parse(await readFile(p, "utf8"));
    expect(raw.providers.litellm.apiKey).toBe("sk-keep");
    expect(raw.providers.litellm.models[0].name).toBe("GPT renamed");
  });

  it("overwrites the stored api key when a real new key is supplied", async () => {
    await saveModels(p, [
      { key: "litellm/gpt-5.5", name: "GPT", provider: "litellm", modelId: "gpt-5.5", apiKey: "sk-old" },
    ]);
    await saveModels(p, [
      { key: "litellm/gpt-5.5", name: "GPT", provider: "litellm", modelId: "gpt-5.5", apiKey: "sk-new" },
    ]);
    const raw = JSON.parse(await readFile(p, "utf8"));
    expect(raw.providers.litellm.apiKey).toBe("sk-new");
  });

  it("returns [] for a missing file", async () => {
    expect(await listModels(join(dir, "nope.json"))).toEqual([]);
  });
});
