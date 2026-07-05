// App-level configuration at ~/.docuzen/config.toml (per-document settings
// live under the document's .docuzen/ store; this file holds machine-wide defaults).
// Reading is total: a missing or malformed file is "unconfigured", so the
// sidecar can never crash-loop on user-edited config.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parse, stringify } from "smol-toml";

export type HarnessChoice = "pi" | "codex";

export interface AppConfig {
  harness: { default: HarnessChoice } | null;
  pi?: { model?: string };
  codex?: { command?: string };
}

export function appConfigPath(): string {
  const base = process.env.DOCUZEN_CONFIG_DIR ?? join(homedir(), ".docuzen");
  return join(base, "config.toml");
}

export function readAppConfig(): AppConfig {
  try {
    const raw = parse(readFileSync(appConfigPath(), "utf8")) as Record<string, unknown>;
    const def = (raw.harness as { default?: unknown } | undefined)?.default;
    const piModel = (raw.pi as { model?: unknown } | undefined)?.model;
    const codexCommand = (raw.codex as { command?: unknown } | undefined)?.command;
    return {
      harness: def === "pi" || def === "codex" ? { default: def } : null,
      pi: typeof piModel === "string" ? { model: piModel } : undefined,
      codex: typeof codexCommand === "string" ? { command: codexCommand } : undefined,
    };
  } catch (e) {
    if (existsSync(appConfigPath())) {
      console.warn(`docd: ignoring malformed app config at ${appConfigPath()}: ${String(e)}`);
    }
    return { harness: null };
  }
}

export function writeAppConfig(config: AppConfig): void {
  const path = appConfigPath();
  mkdirSync(dirname(path), { recursive: true });
  const doc: Record<string, unknown> = {};
  if (config.harness) doc.harness = config.harness;
  if (config.pi) doc.pi = config.pi;
  if (config.codex) doc.codex = config.codex;
  writeFileSync(path, stringify(doc) + "\n", "utf8");
}
