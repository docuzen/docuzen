// Built-in Claude uses the bundled ACP adapter with the user's installed CLI.
// Other trusted local agents can be registered as [acp.<name>] in config.toml.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { readAppConfig, type AppConfig } from "../config/app-config.js";
import { createAcpHarness, spawnAcpAgent, type AcpAgentSpec } from "./acp-runner.js";

export const CLAUDE_CODE_AGENT: AcpAgentSpec = {
  id: "claude-code",
  label: "Claude Code",
  command: "claude",
  installHint: "install Claude Code and sign in with its CLI",
  selectedMode: () => readAppConfig().claude?.permissionMode ?? "default",
  // Keep native writing tools, shell, subagents, plugins and user/project MCP servers
  // out of the session even when a mode auto-approves tools. Docuzen applies edits.
  sessionMeta: { claudeCode: { options: {
    tools: ["Read", "Glob", "Grep", "WebFetch", "WebSearch"],
    strictMcpConfig: true, settingSources: [], plugins: [],
    settings: { disableAllHooks: true },
    extraArgs: { "disable-slash-commands": null },
  } } },
};

export function createClaudeHarness() {
  const harness = createAcpHarness(CLAUDE_CODE_AGENT, {
    launch(spec) {
      // The packaged Node and adapter live together. Development uses the pinned npm entry.
      const packaged = join(dirname(process.execPath), "claude-agent-acp.mjs");
      const entry = existsSync(packaged) ? packaged : join(dirname(
        createRequire(import.meta.url).resolve("@agentclientprotocol/claude-agent-acp/package.json"),
      ), "dist/index.js");
      return spawnAcpAgent({ ...spec, command: process.execPath, args: [entry],
        env: { CLAUDE_CODE_EXECUTABLE: spec.command, CLAUDE_AGENT_ACP_PROTOCOL: "v1" } });
    },
  });
  if (harness.available) {
    const version = spawnSync(CLAUDE_CODE_AGENT.command, ["--version"], { encoding: "utf8", timeout: 2500 });
    if (version.status !== 0) {
      harness.available = false;
      harness.unavailableReason = "Claude Code was found, but its version check failed. Run claude --version.";
      delete harness.status;
    } else {
      harness.status = version.stdout.trim().split("\n")[0] + " · bundled ACP adapter";
    }
  }
  return harness;
}

/** Return only readiness, never identity or credential details from the CLI. */
export function claudeAuthStatus(): string {
  const probe = spawnSync(CLAUDE_CODE_AGENT.command, ["auth", "status", "--json"], { encoding: "utf8", timeout: 4000 });
  try {
    const status = JSON.parse(probe.stdout);
    if (status.loggedIn === true) return "signed in";
    if (status.loggedIn === false) return "signed out (run claude auth login or configure a provider)";
  } catch { /* Older CLIs may not implement this probe. */ }
  return "authentication status unavailable (check claude auth status)";
}

/** Additional user-configured ACP agents. */
export function acpAgentSpecs(config: AppConfig): AcpAgentSpec[] {
  const configured = Object.entries(config.acp ?? {}).map(
    ([name, agent]): AcpAgentSpec => ({
      id: `acp:${name}`,
      label: agent.label ?? name,
      command: agent.command,
      ...(agent.args ? { args: agent.args } : {}),
      ...(agent.env ? { env: agent.env } : {}),
      ...(agent.readOnlyMode ? { readOnlyMode: agent.readOnlyMode } : {}),
    }),
  );
  return configured;
}
