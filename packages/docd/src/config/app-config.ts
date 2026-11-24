// App-level configuration at ~/.docuzen/config.toml (per-document settings
// live under the document's .docuzen/ store; this file holds machine-wide defaults).
// Reading is total: a missing or malformed file is "unconfigured", so the
// sidecar can never crash-loop on user-edited config.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parse, stringify } from "smol-toml";

import type { HarnessId } from "../agent/harness-registry.js";

export type HarnessChoice = HarnessId;
export function isHarnessChoice(value: unknown): value is HarnessChoice {
  return value === "pi" || value === "codex" || value === "claude-code" ||
    (typeof value === "string" && /^acp:[a-z0-9][a-z0-9_-]*$/i.test(value));
}

/** An ACP agent the user added as `[acp.<name>]`; registered as harness "acp:<name>". */
export interface AcpAgentConfig {
  command: string;
  args?: string[];
  label?: string;
  env?: Record<string, string>;
  /** The session mode Docuzen switches the agent into (`read_only_mode`). */
  readOnlyMode?: string;
}

export interface AppConfig {
  claude?: { permissionMode: string };
  harness: { default: HarnessChoice } | null;
  pi?: { model?: string };
  codex?: { command?: string };
  /** Read only: Docuzen never writes these, and writeAppConfig keeps them as the user wrote them. */
  acp?: Record<string, AcpAgentConfig>;
}

export function appConfigPath(): string {
  const base = process.env.DOCUZEN_CONFIG_DIR ?? join(homedir(), ".docuzen");
  return join(base, "config.toml");
}

/** A trimmed non-empty string, or undefined: a blank value means "not set", never "run ''". */
function nonBlank(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

export function readAppConfig(): AppConfig {
  try {
    const raw = parse(readFileSync(appConfigPath(), "utf8")) as Record<string, unknown>;
    const def = (raw.harness as { default?: unknown } | undefined)?.default;
    const piModel = nonBlank((raw.pi as { model?: unknown } | undefined)?.model);
    const codexCommand = nonBlank((raw.codex as { command?: unknown } | undefined)?.command);
    const mode = nonBlank((raw.claude as { permission_mode?: unknown } | undefined)?.permission_mode);
    const acp = parseAcpAgents(raw.acp);
    return {
      ...(mode ? { claude: { permissionMode: mode } } : {}),
      harness: isHarnessChoice(def) ? { default: def } : null,
      pi: piModel ? { model: piModel } : undefined,
      codex: codexCommand ? { command: codexCommand } : undefined,
      ...(acp ? { acp } : {}),
    };
  } catch (e) {
    if (existsSync(appConfigPath())) {
      console.warn(`docd: ignoring malformed app config at ${appConfigPath()}: ${String(e)}`);
    }
    return { harness: null };
  }
}

const ACP_AGENT_NAME = /^[a-z0-9][a-z0-9_-]*$/i;

/**
 * The `[acp.<name>]` tables. An entry without a command, or with a name that is not a
 * plain identifier, is skipped with a warning rather than failing the whole file.
 */
function parseAcpAgents(raw: unknown): Record<string, AcpAgentConfig> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const out: Record<string, AcpAgentConfig> = {};
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    const t = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
    const command = nonBlank(t.command);
    if (!ACP_AGENT_NAME.test(name) || !command) {
      console.warn(`docd: ignoring [acp.${name}] in ${appConfigPath()}: it needs a plain name and a command`);
      continue;
    }
    const args = Array.isArray(t.args) && t.args.every((a) => typeof a === "string") ? (t.args as string[]) : undefined;
    const env =
      t.env && typeof t.env === "object" && !Array.isArray(t.env) && Object.values(t.env).every((v) => typeof v === "string")
        ? (t.env as Record<string, string>)
        : undefined;
    const label = nonBlank(t.label);
    const readOnlyMode = nonBlank(t.read_only_mode);
    out[name] = {
      command,
      ...(args ? { args } : {}),
      ...(label ? { label } : {}),
      ...(env ? { env } : {}),
      ...(readOnlyMode ? { readOnlyMode } : {}),
    };
  }
  return Object.keys(out).length ? out : undefined;
}

/** The file as it stands, or {} when it is missing or not valid TOML. */
function readRawConfig(path: string): Record<string, unknown> {
  try {
    return parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Set (or with `undefined`, remove) one key of a table, dropping the table once empty. */
function setKey(doc: Record<string, unknown>, table: string, key: string, value: unknown): void {
  const current = doc[table];
  const t: Record<string, unknown> =
    current && typeof current === "object" && !Array.isArray(current) ? { ...(current as Record<string, unknown>) } : {};
  if (value === undefined) delete t[key];
  else t[key] = value;
  if (Object.keys(t).length) doc[table] = t;
  else delete doc[table];
}

/**
 * Write the settings docuzen manages onto the existing file: sections and keys it does
 * not know about (the user's own) are kept. Comments are not, since the TOML library
 * does not round-trip them.
 */
export function writeAppConfig(config: AppConfig): void {
  const path = appConfigPath();
  mkdirSync(dirname(path), { recursive: true });
  const doc = readRawConfig(path);
  setKey(doc, "claude", "permission_mode", config.claude?.permissionMode);
  setKey(doc, "harness", "default", config.harness?.default);
  setKey(doc, "pi", "model", config.pi?.model);
  setKey(doc, "codex", "command", config.codex?.command);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, stringify(doc) + "\n", "utf8");
  renameSync(tmp, path);
}
