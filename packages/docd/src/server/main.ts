import { userInfo } from "node:os";
import { startServer } from "./ws-server.js";
import { selectRunner } from "./select-runner.js";
import { setupHarnesses } from "./harness-setup.js";
import { newLaunchToken } from "./access.js";
import { createCodexHarness } from "../agent/codex-runner.js";
import { acpAgentSpecs, claudeAuthStatus, createClaudeHarness } from "../agent/acp-agents.js";
import { AcpRunner, createAcpHarness } from "../agent/acp-runner.js";
import { listModels } from "../agent/index.js";
import { PiRunner } from "../agent/pi-runner.js";
import { appConfigPath, readAppConfig } from "../config/app-config.js";
import { defaultModelsPath } from "../rpc/handler.js";
import { loadShellEnvIfRequested } from "./shell-env.js";

// Wrapped in main() rather than top-level await so esbuild can bundle this
// entrypoint as CJS for the packaged sidecar (see scripts/bundle-sidecar.mjs).
async function main(): Promise<void> {
  const portArg = process.argv.indexOf("--port");
  const port = portArg !== -1 ? Number(process.argv[portArg + 1]) : 0;

  // The launch token: the app shell (or a dev tool) passes the one it gave the webview.
  // Taken out of the environment before anything is spawned — harness CLIs, MCP servers
  // and the login-shell probe have no business holding it.
  const givenToken = process.env.DOCD_TOKEN;
  delete process.env.DOCD_TOKEN;
  const token = givenToken || newLaunchToken();

  // Before anything reads the environment (harness detection, key references).
  await loadShellEnvIfRequested();
  const config = readAppConfig();
  const modelsPath = defaultModelsPath();
  const models = await listModels(modelsPath).catch(() => []);
  // Codex is detected first: an unconfigured install defaults to whichever harness is usable.
  const codexHarness = createCodexHarness({ config: { ...config.codex, modelsPath } });
  const sel = selectRunner({ env: process.env, config, models, codexAvailable: codexHarness.available });
  const acpHarnesses = [createClaudeHarness(), ...acpAgentSpecs(config).map((spec) => createAcpHarness(spec))];
  const { registry, piRunner, piOfflineReason } = await setupHarnesses({
    sel,
    config,
    codex: codexHarness,
    acp: acpHarnesses,
    createPi: (model) => PiRunner.create(model),
  });

  if (process.argv.includes("--doctor-harnesses")) {
    for (const h of registry.list()) {
      const auth = h.id === "claude-code" && h.available ? " · " + claudeAuthStatus() : "";
      console.log(h.label + ": " + (h.unavailableReason ?? h.status ?? "available") + auth);
    }
    return;
  }

  console.log(
    piRunner
      ? `docd: PiRunner (provider=${sel.provider}, model=${sel.modelId}) — ${sel.reason}`
      : `docd: pi offline (FakePiRunner) — ${piOfflineReason} [config: ${appConfigPath()}]`,
  );
  console.log(
    codexHarness.available
      ? `docd: Codex harness available (${codexHarness.status ?? "detected"})`
      : `docd: Codex harness unavailable (${codexHarness.unavailableReason ?? "not detected"})`,
  );
  for (const h of acpHarnesses) {
    console.log(
      h.available
        ? `docd: ${h.label} harness available (${h.status ?? "detected"})`
        : `docd: ${h.label} harness unavailable (${h.unavailableReason ?? "not detected"})`,
    );
  }
  console.log(`docd: default harness = ${registry.defaultId()}`);

  const author = process.env.DOCUZEN_AUTHOR ?? userInfo().username;
  const server = await startServer({
    port,
    registry,
    now: () => new Date().toISOString(),
    author,
    token,
  });

  // A launcher that didn't supply a token reads the generated one from here (always
  // before the port line). A token that came from the environment is never echoed: the
  // packaged app logs this stdout to ~/.docuzen/logs/docd.log.
  if (!givenToken) console.log(`DOCD_TOKEN=${token}`);
  // The launcher reads this line from stdout to discover the chosen port.
  console.log(`DOCD_PORT=${server.port}`);

  const shutdown = () => {
    // ACP agents are long-lived child processes; stop them rather than leave them running.
    for (const h of acpHarnesses) if (h.runner instanceof AcpRunner) h.runner.dispose();
    void server.close().then(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

void main();
