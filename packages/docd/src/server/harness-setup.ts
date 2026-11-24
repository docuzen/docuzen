// Builds the sidecar's harness registry. Split from server/main.ts so the order of
// decisions is testable: pi is constructed first, and only then is the default harness
// chosen — `selectRunner` can only say pi *looks* usable (a keyed model exists), while
// `PiRunner.create` can still fail (the model isn't in pi's registry, say). Choosing the
// default before that settled left an unconfigured install defaulting to a dead pi even
// with the codex CLI right there.
import type { AgentHarness } from "../agent/harness-registry.js";
import { HarnessRegistry, PI_CAPABILITIES } from "../agent/harness-registry.js";
import { FakePiRunner } from "../agent/fake-runner.js";
import type { AgentRunner } from "../agent/types.js";
import type { AppConfig } from "../config/app-config.js";
import { chooseDefaultHarness, type RunnerSelection } from "./select-runner.js";

export interface HarnessSetup {
  registry: HarnessRegistry;
  /** The live pi runner, or null when pi is offline. */
  piRunner: AgentRunner | null;
  /** Why pi is offline (shown when a turn reaches it), or null when it is live. */
  piOfflineReason: string | null;
}

export async function setupHarnesses(opts: {
  sel: RunnerSelection;
  config: AppConfig;
  codex: AgentHarness;
  /** ACP agents (Claude Code, config.toml's [acp.*]); each is registered, usable or not. */
  acp?: AgentHarness[];
  createPi: (model: { provider: string; modelId: string }) => Promise<AgentRunner>;
}): Promise<HarnessSetup> {
  const { sel, config, codex } = opts;
  let piRunner: AgentRunner | null = null;
  let piOfflineReason = sel.reason;
  if (sel.live) {
    try {
      piRunner = await opts.createPi({ provider: sel.provider, modelId: sel.modelId });
    } catch (e) {
      // e.g. LLM_API_KEY is set but the model isn't in pi's registry. Stay up with pi
      // offline (the reason reaches the UI) instead of crashing the whole sidecar.
      piOfflineReason = e instanceof Error ? e.message : String(e);
    }
  }

  const registry = new HarnessRegistry(chooseDefaultHarness(config, piRunner !== null, codex.available, opts.acp?.find((h) => h.available)?.id));
  registry.register(
    piRunner
      ? { id: "pi", label: "Pi", runner: piRunner, capabilities: PI_CAPABILITIES, available: true }
      : {
          id: "pi",
          label: "Pi",
          runner: new FakePiRunner([]),
          capabilities: PI_CAPABILITIES,
          available: false,
          unavailableReason: piOfflineReason,
        },
  );
  registry.register(codex);
  // Registered even when the agent is missing, so a thread or document that names it
  // gets "unavailable: <reason>" instead of quietly falling back to the default harness.
  for (const harness of opts.acp ?? []) registry.register(harness);
  return { registry, piRunner, piOfflineReason: piRunner ? null : piOfflineReason };
}
