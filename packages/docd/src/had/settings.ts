import { mkdir, readFile, writeFile } from "node:fs/promises";
import { hadPaths } from "./paths.js";
import { readAppConfig } from "../config/app-config.js";

/** Tool/agent scope for a document. "folder" = the doc's directory (+ .had);
 *  "repo" = up to the nearest repo root. */
export type Scope = "folder" | "repo";

/** How the agent changes the document: propose a diff vs. edit the file directly. */
export type AgentEdit = "propose" | "direct";

export interface HadSettings {
  scope: Scope;
  /** Which agent harness handles new agent turns for this document. */
  harness?: "pi" | "codex" | "claude-code";
  /** Optional per-doc model override (provider/model resolution is the sidecar's). */
  model?: string;
  /**
   * Whether the agent proposes edits (default) or writes the doc directly.
   *
   * Phase 10 (RECORD): this setting no longer governs discuss/reply/panel — those
   * conversation turns never edit or propose an edit now, under either value (see
   * Orchestrator.buildContext's `conversationOnly`, forced regardless of this field).
   * Its only remaining conceptual scope is the explicit edit flows (resolveDirectives,
   * Improve — apply-directly vs propose), but as of Phase 10 neither of those reads it
   * either (both always propose), so this field currently has NO live effect anywhere in
   * docd. It is kept for forward-compat and the desktop settings UI, which still persists
   * it as a per-doc setting.
   */
  agentEdit?: AgentEdit;
  /**
   * Standing instructions for this document (AGENTS.md-style): persistent guidance —
   * voice, style rules, constraints — injected into EVERY agent edit/discussion/review
   * prompt. Distinct from a one-off review rubric.
   */
  instructions?: string;
  /**
   * Agent web-search capability. Default: enabled, keyless DuckDuckGo. Brave/Tavily are
   * opt-in and read their key from the environment (never stored here, since settings can
   * travel in a .hadz export).
   */
  webSearch?: { enabled?: boolean; provider?: "ddg" | "brave" | "tavily" };
}

const DEFAULTS: HadSettings = {
  scope: "folder",
  harness: "pi",
  agentEdit: "propose",
  webSearch: { enabled: true, provider: "ddg" },
};

export async function readSettings(docPath: string): Promise<HadSettings> {
  // Resolve the default harness from the app config at call-time so that a
  // change to ~/.docuzen/config.toml (e.g. via the first-run modal) takes
  // effect for new documents without a sidecar restart.
  const defaultHarness: HadSettings["harness"] = readAppConfig().harness?.default ?? "pi";
  const defaults: HadSettings = { ...DEFAULTS, harness: defaultHarness };
  try {
    const raw = await readFile(hadPaths(docPath).settings, "utf8");
    const settings = JSON.parse(raw) as Partial<HadSettings>;
    return { ...defaults, ...settings };
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { ...defaults };
    throw err;
  }
}

export async function writeSettings(docPath: string, settings: HadSettings): Promise<void> {
  const p = hadPaths(docPath);
  await mkdir(p.dir, { recursive: true });
  await writeFile(p.settings, JSON.stringify(settings, null, 2) + "\n", "utf8");
}
