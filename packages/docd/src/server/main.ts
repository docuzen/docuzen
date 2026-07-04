import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { startServer } from "./ws-server.js";
import { selectRunner } from "./select-runner.js";
import { createCodexHarness } from "../agent/codex-runner.js";
import { FakePiRunner } from "../agent/fake-runner.js";
import { HarnessRegistry, PI_CAPABILITIES } from "../agent/harness-registry.js";
import { listModels } from "../agent/index.js";
import { PiRunner } from "../agent/pi-runner.js";
import type { AgentRunner } from "../agent/types.js";
import { appConfigPath, readAppConfig } from "../config/app-config.js";

// Wrapped in main() rather than top-level await so esbuild can bundle this
// entrypoint as CJS for the packaged sidecar (see scripts/bundle-sidecar.mjs).
async function main(): Promise<void> {
  const portArg = process.argv.indexOf("--port");
  const port = portArg !== -1 ? Number(process.argv[portArg + 1]) : 0;

  const config = readAppConfig();
  const models = await listModels(join(homedir(), ".pi", "agent", "models.json")).catch(() => []);
  const sel = selectRunner({ env: process.env, config, models });

  let runner: AgentRunner;
  const registry = new HarnessRegistry(sel.defaultHarness);
  if (sel.live) {
    runner = new PiRunner({ provider: sel.provider, modelId: sel.modelId });
    registry.register({
      id: "pi",
      label: "Pi",
      runner,
      capabilities: PI_CAPABILITIES,
      available: true,
    });
    console.log(`docd: PiRunner (provider=${sel.provider}, model=${sel.modelId}) — ${sel.reason}`);
  } else {
    runner = new FakePiRunner([]);
    registry.register({
      id: "pi",
      label: "Pi (offline fake)",
      runner,
      capabilities: PI_CAPABILITIES,
      available: false,
    });
    console.log(`docd: Discuss disabled (FakePiRunner) — ${sel.reason} [config: ${appConfigPath()}]`);
  }

  const codexHarness = createCodexHarness(config.codex ? { config: config.codex } : undefined);
  registry.register(codexHarness);
  console.log(
    codexHarness.available
      ? `docd: Codex harness available (${codexHarness.status ?? "detected"})`
      : `docd: Codex harness unavailable (${codexHarness.unavailableReason ?? "not detected"})`,
  );

  const author = process.env.DOCUZEN_AUTHOR ?? userInfo().username ?? "you";
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
