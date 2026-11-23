// App-level configuration at ~/.docuzen/config.toml (per-document settings
// live under the document's .docuzen/ store; this file holds machine-wide defaults).
// Reading is total: a missing or malformed file is "unconfigured", so the
// sidecar can never crash-loop on user-edited config.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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
    return {
      harness: def === "pi" || def === "codex" ? { default: def } : null,
      pi: piModel ? { model: piModel } : undefined,
      codex: codexCommand ? { command: codexCommand } : undefined,
    };
  } catch (e) {
    if (existsSync(appConfigPath())) {
      console.warn(`docd: ignoring malformed app config at ${appConfigPath()}: ${String(e)}`);
    }
    return { harness: null };
  }
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
  setKey(doc, "harness", "default", config.harness?.default);
  setKey(doc, "pi", "model", config.pi?.model);
  setKey(doc, "codex", "command", config.codex?.command);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, stringify(doc) + "\n", "utf8");
  renameSync(tmp, path);
}
