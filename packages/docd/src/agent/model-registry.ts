import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * A single model row, flattened from pi's provider-keyed models.json. `key`
 * (`provider/modelId`) is the stable identity the Settings UI edits against.
 */
export interface ModelConfig {
  key: string; // "provider/modelId", unique
  name: string;
  provider: string;
  modelId: string;
  baseUrl?: string;
  reasoningEffort?: "none" | "low" | "medium" | "high" | "xhigh";
  hasKey?: boolean; // listModels only: true when an apiKey is set. Raw key NEVER returned.
  apiKey?: string; // INPUT to saveModels only; never returned by listModels
}

/** Structural view of pi's ~/.pi/agent/models.json on disk. */
interface PiModelDef {
  id: string;
  name?: string;
  reasoningEffort?: ModelConfig["reasoningEffort"];
}
interface PiProvider {
  baseUrl?: string;
  api?: string;
  apiKey?: string;
  models?: PiModelDef[];
}
interface PiModelsFile {
  providers?: Record<string, PiProvider>;
}

async function readFileOrEmpty(path: string): Promise<PiModelsFile> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as PiModelsFile;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
}

/**
 * Read models.json and flatten each provider's models into ModelConfig rows.
 * The raw apiKey is never returned — only `hasKey` reflects whether one is set.
 * Missing file → [].
 */
export async function listModels(path: string): Promise<ModelConfig[]> {
  const file = await readFileOrEmpty(path);
  const providers = file.providers ?? {};
  const rows: ModelConfig[] = [];
  for (const [provider, def] of Object.entries(providers)) {
    const hasKey = Boolean(def.apiKey);
    for (const m of def.models ?? []) {
      rows.push({
        key: `${provider}/${m.id}`,
        name: m.name ?? m.id,
        provider,
        modelId: m.id,
        ...(def.baseUrl !== undefined ? { baseUrl: def.baseUrl } : {}),
        ...(m.reasoningEffort !== undefined ? { reasoningEffort: m.reasoningEffort } : {}),
        hasKey,
      });
    }
  }
  return rows;
}

/**
 * Server-side lookup for runners that must pass the provider credential to an
 * external process. Unlike listModels(), this intentionally returns apiKey and
 * must never be exposed through RPC.
 */
export async function readModelWithKey(path: string, key: string): Promise<ModelConfig | undefined> {
  const file = await readFileOrEmpty(path);
  const providers = file.providers ?? {};
  const slash = key.indexOf("/");
  if (slash < 0) return undefined;
  const providerId = key.slice(0, slash);
  const modelId = key.slice(slash + 1);
  const provider = providers[providerId];
  const model = provider?.models?.find((m) => m.id === modelId);
  if (!provider || !model) return undefined;
  return {
    key,
    name: model.name ?? model.id,
    provider: providerId,
    modelId: model.id,
    ...(provider.baseUrl !== undefined ? { baseUrl: provider.baseUrl } : {}),
    ...(model.reasoningEffort !== undefined ? { reasoningEffort: model.reasoningEffort } : {}),
    hasKey: Boolean(provider.apiKey),
    ...(provider.apiKey !== undefined ? { apiKey: provider.apiKey } : {}),
  };
}

/**
 * Group ModelConfig rows by provider and write pi's models.json shape.
 * Key preservation: a provider/model whose incoming apiKey is blank/undefined
 * keeps the apiKey already stored on disk for that provider, so editing
 * non-secret fields never wipes the credential.
 */
export async function saveModels(path: string, models: ModelConfig[]): Promise<void> {
  const existing = (await readFileOrEmpty(path)).providers ?? {};
  const providers: Record<string, PiProvider> = {};

  for (const m of models) {
    let provider = providers[m.provider];
    if (!provider) {
      const incomingKey = m.apiKey?.trim();
      provider = {
        api: "openai-completions",
        ...(m.baseUrl !== undefined ? { baseUrl: m.baseUrl } : {}),
        apiKey: incomingKey || existing[m.provider]?.apiKey,
        models: [],
      };
      providers[m.provider] = provider;
    }
    provider.models!.push({
      id: m.modelId,
      name: m.name,
      ...(m.reasoningEffort !== undefined ? { reasoningEffort: m.reasoningEffort } : {}),
    });
  }

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify({ providers }, null, 2) + "\n", "utf8");
}
