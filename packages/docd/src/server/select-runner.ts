// Pure decision: which runner does the sidecar start with? Extracted from
// server/main.ts so packaged-mode gating (config.toml) and the dev override
// (LLM_API_KEY) are unit-testable without spawning anything.
import type { ModelConfig } from "../agent/model-registry.js";
import type { AppConfig, HarnessChoice } from "../config/app-config.js";

export interface RunnerSelection {
  live: boolean;
  provider: string;
  modelId: string;
  defaultHarness: HarnessChoice;
  reason: string;
}

const FALLBACK_PROVIDER = "litellm";
const FALLBACK_MODEL = "gpt-5.5";

export function selectRunner(opts: {
  env: Record<string, string | undefined>;
  config: AppConfig;
  models: ModelConfig[];
}): RunnerSelection {
  const { env, config, models } = opts;
  const defaultHarness: HarnessChoice = config.harness?.default ?? "pi";

  // Dev override: an env key behaves exactly as before packaging existed.
  if (env.LLM_API_KEY) {
    return {
      live: true,
      provider: env.LLM_PROVIDER ?? FALLBACK_PROVIDER,
      modelId: env.LLM_MODEL ?? FALLBACK_MODEL,
      defaultHarness,
      reason: "LLM_API_KEY env override",
    };
  }

  if (config.harness?.default === "pi" && config.pi?.model) {
    const wanted = config.pi.model;
    const found = models.find((m) => m.key === wanted && m.hasKey);
    if (found) {
      return {
        live: true,
        provider: found.provider,
        modelId: found.modelId,
        defaultHarness,
        reason: `configured pi model ${wanted}`,
      };
    }
    const [provider = FALLBACK_PROVIDER, ...rest] = wanted.split("/");
    return {
      live: false,
      provider,
      modelId: rest.join("/") || FALLBACK_MODEL,
      defaultHarness,
      reason: `pi model ${wanted} has no usable entry in models.json`,
    };
  }

  return {
    live: false,
    provider: FALLBACK_PROVIDER,
    modelId: FALLBACK_MODEL,
    defaultHarness,
    reason: config.harness ? "codex harness selected; pi offline" : "no harness configured",
  };
}
