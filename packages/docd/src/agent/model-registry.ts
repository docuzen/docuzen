import { readJsonFile, withFileLock, writeJsonFile } from "../had/io.js";

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

/**
 * Structural view of pi's ~/.pi/agent/models.json on disk. Settings manages only the
 * fields named here; everything else (a provider's `headers`, `compat`, `modelOverrides`,
 * a model's `contextWindow`, `cost`, ...) is pi configuration that saves carry over as is.
 */
interface PiModelDef {
  id: string;
  name?: string;
  reasoningEffort?: ModelConfig["reasoningEffort"];
  [field: string]: unknown;
}
interface PiProvider {
  baseUrl?: string;
  api?: string;
  apiKey?: string;
  models?: PiModelDef[];
  [field: string]: unknown;
}
interface PiModelsFile {
  providers?: Record<string, PiProvider>;
  [field: string]: unknown;
}

async function readFileOrEmpty(path: string): Promise<PiModelsFile> {
  return readJsonFile<PiModelsFile>(path, () => ({}));
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
 * Write the Settings model list (every row, as listModels returned it, with edits) into
 * pi's models.json, merged onto what is on disk:
 *  - each provider and model keeps the fields Settings doesn't manage; `api` defaults to
 *    "openai-completions" only for a provider this save creates;
 *  - a provider with no models (e.g. a key for one of pi's built-in providers) has no row,
 *    so it is kept; a provider whose last model row was removed is removed;
 *  - a non-empty apiKey on any row sets that row's provider's key; a blank one keeps the
 *    stored key, so editing non-secret fields never wipes the credential;
 *  - every row carries its provider's baseUrl, so a non-empty one that differs from the
 *    stored URL is the edit and moves the provider; a blank one keeps the stored URL.
 */
export function saveModels(path: string, models: ModelConfig[]): Promise<void> {
  // Locked: the stored apiKey is carried over from the file being replaced, so two
  // overlapping saves must not interleave their read and write. Atomic: this file holds
  // credentials, and a torn write would lose every provider's key.
  return withFileLock(path, () => saveModelsUnlocked(path, models));
}

async function saveModelsUnlocked(path: string, models: ModelConfig[]): Promise<void> {
  const file = await readFileOrEmpty(path);
  const existing = file.providers ?? {};
  const providers: Record<string, PiProvider> = {};
  for (const [id, def] of Object.entries(existing)) {
    if (!def.models?.length) providers[id] = { ...def };
  }

  for (const m of models) {
    const prior = existing[m.provider];
    let provider = providers[m.provider];
    if (!provider) {
      provider = prior ? { ...prior, models: [] } : { api: "openai-completions", models: [] };
      providers[m.provider] = provider;
    }
    const apiKey = m.apiKey?.trim();
    if (apiKey) provider.apiKey = apiKey;
    const baseUrl = m.baseUrl?.trim();
    if (baseUrl && baseUrl !== prior?.baseUrl) provider.baseUrl = baseUrl;
    const { reasoningEffort: _managed, ...kept } = prior?.models?.find((d) => d.id === m.modelId) ?? {};
    (provider.models ??= []).push({
      ...kept,
      id: m.modelId,
      name: m.name,
      ...(m.reasoningEffort !== undefined ? { reasoningEffort: m.reasoningEffort } : {}),
    });
  }

  await writeJsonFile(path, { ...file, providers }, { mode: 0o600 }); // holds API keys: owner-only
}
