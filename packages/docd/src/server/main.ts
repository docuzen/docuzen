import { userInfo } from "node:os";
import { startServer } from "./ws-server.js";
import { selectRunner } from "./select-runner.js";
import { createCodexHarness } from "../agent/codex-runner.js";
import { FakePiRunner } from "../agent/fake-runner.js";
import { HarnessRegistry, PI_CAPABILITIES } from "../agent/harness-registry.js";
import { listModels } from "../agent/index.js";
import { PiRunner } from "../agent/pi-runner.js";
import type { AgentRunner } from "../agent/types.js";
import { appConfigPath, readAppConfig } from "../config/app-config.js";
import { defaultModelsPath } from "../rpc/handler.js";
import { loadShellEnvIfRequested } from "./shell-env.js";

// Wrapped in main() rather than top-level await so esbuild can bundle this
// entrypoint as CJS for the packaged sidecar (see scripts/bundle-sidecar.mjs).
async function main(): Promise<void> {
  const portArg = process.argv.indexOf("--port");
  const port = portArg !== -1 ? Number(process.argv[portArg + 1]) : 0;

  // Before anything reads the environment (harness detection, key references).
  await loadShellEnvIfRequested();
  const config = readAppConfig();
  const modelsPath = defaultModelsPath();
  const models = await listModels(modelsPath).catch(() => []);
  // Codex is detected first: an unconfigured install defaults to whichever harness is usable.
  const codexHarness = createCodexHarness({ config: { ...config.codex, modelsPath } });
  const sel = selectRunner({ env: process.env, config, models, codexAvailable: codexHarness.available });

  const registry = new HarnessRegistry(sel.defaultHarness);
  let piRunner: AgentRunner | null = null;
  let piOfflineReason = sel.reason;
  if (sel.live) {
    try {
      piRunner = await PiRunner.create({ provider: sel.provider, modelId: sel.modelId });
    } catch (e) {
      // e.g. LLM_API_KEY is set but the model isn't in pi's registry. Stay up with pi
      // offline (the reason reaches the UI) instead of crashing the whole sidecar.
      piOfflineReason = e instanceof Error ? e.message : String(e);
    }
  }
  if (piRunner) {
    registry.register({
      id: "pi",
      label: "Pi",
      runner: piRunner,
      capabilities: PI_CAPABILITIES,
      available: true,
    });
    console.log(`docd: PiRunner (provider=${sel.provider}, model=${sel.modelId}) — ${sel.reason}`);
  } else {
    registry.register({
      id: "pi",
      label: "Pi",
      runner: new FakePiRunner([]),
      capabilities: PI_CAPABILITIES,
      available: false,
      unavailableReason: piOfflineReason,
    });
    console.log(`docd: pi offline (FakePiRunner) — ${piOfflineReason} [config: ${appConfigPath()}]`);
  }

  registry.register(codexHarness);
  console.log(
    codexHarness.available
      ? `docd: Codex harness available (${codexHarness.status ?? "detected"})`
      : `docd: Codex harness unavailable (${codexHarness.unavailableReason ?? "not detected"})`,
  );
  console.log(`docd: default harness = ${registry.defaultId()}`);

  const author = process.env.DOCUZEN_AUTHOR ?? userInfo().username;
  const server = await startServer({
    port,
    registry,
    now: () => new Date().toISOString(),
    author,
  });

  // The launcher reads this line from stdout to discover the chosen port.
  console.log(`DOCD_PORT=${server.port}`);

  const shutdown = () => {
    void server.close().then(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

void main();
