// Pure decision: which runner does the sidecar start with, and which harness is the
// default for documents that don't name one? Extracted from server/main.ts so the
// gating (config.toml, models.json, codex detection) and the dev override (LLM_API_KEY)
// are unit-testable without spawning anything.
//
// Two independent questions, deliberately not coupled:
//  1. Is pi usable?  Yes whenever a model with a stored key can be resolved — the
//     configured one, or failing that the first keyed model in models.json. It does NOT
//     depend on which harness is the default: a document can pick pi while the app
//     default is codex, and that must work.
//  2. Which harness is the default?  The configured one if config.toml names it;
//     otherwise the first usable one (pi, then codex), so a fresh install with only the
//     codex CLI present works without any setup.
import type { ModelConfig } from "../agent/model-registry.js";
import type { AppConfig, HarnessChoice } from "../config/app-config.js";

export interface RunnerSelection {
  /** Whether pi can answer (a live PiRunner should be constructed). */
  live: boolean;
  provider: string;
  modelId: string;
  defaultHarness: HarnessChoice;
  /** Why pi is live or offline — logged, and shown when a turn hits an offline pi. */
  reason: string;
}

const FALLBACK_PROVIDER = "litellm";
const FALLBACK_MODEL = "gpt-5.5";

function splitKey(key: string): { provider: string; modelId: string } {
  const [provider = FALLBACK_PROVIDER, ...rest] = key.split("/");
  return { provider, modelId: rest.join("/") || FALLBACK_MODEL };
}

export function selectRunner(opts: {
  env: Record<string, string | undefined>;
  config: AppConfig;
  models: ModelConfig[];
  /** Whether the codex CLI was detected; only consulted when no default is configured. */
  codexAvailable?: boolean;
}): RunnerSelection {
  const { env, config, models } = opts;
  const pi = selectPi(env, config, models);
  const defaultHarness: HarnessChoice =
    config.harness?.default ?? (pi.live ? "pi" : opts.codexAvailable ? "codex" : "pi");
  return { ...pi, defaultHarness };
}

function selectPi(
  env: Record<string, string | undefined>,
  config: AppConfig,
  models: ModelConfig[],
): Omit<RunnerSelection, "defaultHarness"> {
  // Dev override: an env key behaves exactly as before packaging existed.
  if (env.LLM_API_KEY) {
    return {
      live: true,
      provider: env.LLM_PROVIDER ?? FALLBACK_PROVIDER,
      modelId: env.LLM_MODEL ?? FALLBACK_MODEL,
      reason: "LLM_API_KEY env override",
    };
  }

  const wanted = config.pi?.model;
  if (wanted) {
    const found = models.find((m) => m.key === wanted && m.hasKey);
    if (found) {
      return {
        live: true,
        provider: found.provider,
        modelId: found.modelId,
        reason: `configured pi model ${wanted}`,
      };
    }
    // An explicitly configured model that can't be used is reported, never silently
    // swapped for a different one.
    return {
      live: false,
      ...splitKey(wanted),
      reason: `pi model ${wanted} has no usable entry in models.json`,
    };
  }

  const firstKeyed = models.find((m) => m.hasKey);
  if (firstKeyed) {
    return {
      live: true,
      provider: firstKeyed.provider,
      modelId: firstKeyed.modelId,
      reason: `no pi model configured; using ${firstKeyed.key} (first model with a stored key)`,
    };
  }
  return {
    live: false,
    provider: FALLBACK_PROVIDER,
    modelId: FALLBACK_MODEL,
    reason: "no pi model is configured and models.json has no model with a stored key",
  };
}
