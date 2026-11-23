import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  listModels,
  readModelWithKey,
  saveModels,
  type ModelConfig,
} from "../../src/agent/model-registry.js";

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
        reasoningEffort: "xhigh",
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
      reasoningEffort: "xhigh",
      hasKey: true,
    });
    expect((list[0] as unknown as Record<string, unknown>).apiKey).toBeUndefined();
    // file is valid pi shape with the key on disk
    const raw = JSON.parse(await readFile(p, "utf8"));
    expect(raw.providers.litellm.apiKey).toBe("sk-secret");
    expect(raw.providers.litellm.api).toBe("openai-completions");
    expect(raw.providers.litellm.models[0].id).toBe("gpt-5.5");
  });

  it("can read one model with its key for server-side runner launch only", async () => {
    await saveModels(p, [
      {
        key: "docuzen/gpt-5.5",
        name: "GPT-5.5",
        provider: "docuzen",
        modelId: "gpt-5.5",
        baseUrl: "https://h/v1",
        reasoningEffort: "xhigh",
        apiKey: "sk-secret",
      },
    ]);
    await expect(readModelWithKey(p, "docuzen/gpt-5.5")).resolves.toMatchObject({
      key: "docuzen/gpt-5.5",
      modelId: "gpt-5.5",
      baseUrl: "https://h/v1",
      reasoningEffort: "xhigh",
      apiKey: "sk-secret",
      hasKey: true,
    });
    await expect(readModelWithKey(p, "missing/gpt-5.5")).resolves.toBeUndefined();
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

  /** What the Settings form sends: every listed row without its key, the edited row in place. */
  async function saveEdited(edit: (row: ModelConfig) => ModelConfig | null): Promise<void> {
    const rows = (await listModels(p)).map(({ hasKey: _hasKey, ...row }) => row);
    await saveModels(p, rows.flatMap((row) => edit(row) ?? []));
  }

  it("keeps everything Settings doesn't manage when one model is edited", async () => {
    const original = {
      $schema: "https://example.test/models.schema.json",
      providers: {
        // A built-in provider's key, with no models: Settings lists no row for it.
        openai: { apiKey: "sk-openai" },
        anthropic: {
          api: "anthropic-messages",
          apiKey: "sk-ant",
          headers: { "x-team": "docs" },
          modelOverrides: { "claude-opus": { contextWindow: 500000 } },
          models: [
            {
              id: "claude-custom",
              name: "Claude custom",
              reasoning: true,
              contextWindow: 200000,
              maxTokens: 64000,
              cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
            },
            { id: "claude-small", name: "Claude small" },
          ],
        },
        gateway: {
          api: "openai-responses",
          baseUrl: "https://gw/v1",
          apiKey: "sk-gw",
          authHeader: true,
          compat: { supportsDeveloperRole: false },
          models: [{ id: "gpt-5.5", name: "GPT", reasoningEffort: "high", input: ["text", "image"] }],
        },
      },
    };
    await writeFile(p, JSON.stringify(original));

    await saveEdited((row) => (row.key === "anthropic/claude-custom" ? { ...row, name: "Claude (renamed)" } : row));

    const raw = JSON.parse(await readFile(p, "utf8"));
    const expected = structuredClone(original);
    expected.providers.anthropic.models[0].name = "Claude (renamed)";
    expect(raw).toEqual(expected);
  });

  it("adds a model to an existing provider without changing its api, and defaults api only for a new provider", async () => {
    await writeFile(
      p,
      JSON.stringify({
        providers: {
          anthropic: { api: "anthropic-messages", apiKey: "sk-ant", models: [{ id: "a", name: "A" }] },
        },
      }),
    );
    const rows = (await listModels(p)).map(({ hasKey: _hasKey, ...row }) => row);
    await saveModels(p, [
      ...rows,
      { key: "anthropic/b", name: "B", provider: "anthropic", modelId: "b" },
      { key: "local/m", name: "M", provider: "local", modelId: "m", baseUrl: "http://localhost:4000/v1", apiKey: "k" },
    ]);
    const raw = JSON.parse(await readFile(p, "utf8"));
    expect(raw.providers.anthropic).toEqual({
      api: "anthropic-messages",
      apiKey: "sk-ant",
      models: [
        { id: "a", name: "A" },
        { id: "b", name: "B" },
      ],
    });
    expect(raw.providers.local).toEqual({
      api: "openai-completions",
      baseUrl: "http://localhost:4000/v1",
      apiKey: "k",
      models: [{ id: "m", name: "M" }],
    });
  });

  it("a new key or base URL on any model row updates that model's provider", async () => {
    await saveModels(p, [
      { key: "gw/one", name: "One", provider: "gw", modelId: "one", baseUrl: "https://old/v1", apiKey: "sk-old" },
      { key: "gw/two", name: "Two", provider: "gw", modelId: "two" },
    ]);

    // Rotate the key from the provider's SECOND row.
    await saveEdited((row) => (row.key === "gw/two" ? { ...row, apiKey: "sk-new" } : row));
    let raw = JSON.parse(await readFile(p, "utf8"));
    expect(raw.providers.gw.apiKey).toBe("sk-new");

    // Move the provider from its FIRST row; the second row still carries the old URL.
    await saveEdited((row) => (row.key === "gw/one" ? { ...row, baseUrl: "https://new/v1" } : row));
    raw = JSON.parse(await readFile(p, "utf8"));
    expect(raw.providers.gw.baseUrl).toBe("https://new/v1");

    // ...and from its second row.
    await saveEdited((row) => (row.key === "gw/two" ? { ...row, baseUrl: "https://newer/v1" } : row));
    raw = JSON.parse(await readFile(p, "utf8"));
    expect(raw.providers.gw.baseUrl).toBe("https://newer/v1");
    expect(raw.providers.gw.apiKey).toBe("sk-new");
  });

  it("removing a model keeps the provider's other models and settings; removing its last model removes it", async () => {
    await writeFile(
      p,
      JSON.stringify({
        providers: {
          gw: {
            api: "openai-completions",
            baseUrl: "https://gw/v1",
            apiKey: "sk",
            headers: { "x-a": "1" },
            models: [
              { id: "one", name: "One", contextWindow: 1000 },
              { id: "two", name: "Two" },
            ],
          },
        },
      }),
    );
    await saveEdited((row) => (row.key === "gw/two" ? null : row));
    let raw = JSON.parse(await readFile(p, "utf8"));
    expect(raw.providers.gw).toEqual({
      api: "openai-completions",
      baseUrl: "https://gw/v1",
      apiKey: "sk",
      headers: { "x-a": "1" },
      models: [{ id: "one", name: "One", contextWindow: 1000 }],
    });

    await saveEdited(() => null);
    raw = JSON.parse(await readFile(p, "utf8"));
    expect(raw.providers).toEqual({});
  });
});
