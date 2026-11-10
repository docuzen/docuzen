import { hadPaths } from "./paths.js";
import { readJsonFile, withFileLock, writeJsonFile } from "./io.js";
import { readAppConfig } from "../config/app-config.js";

/** Tool/agent scope for a document. "folder" = the doc's directory (+ .had);
 *  "repo" = up to the nearest repo root. */
export type Scope = "folder" | "repo";

/** How agent edits reach the document: Suggesting ("propose") or Editing ("direct"). */
export type AgentEdit = "propose" | "direct";

export interface HadSettings {
  scope: Scope;
  /**
   * Which agent harness handles new agent turns for this document. Absent when neither
   * this document nor ~/.docuzen/config.toml names one — the sidecar then uses its
   * registry default (the first usable harness; see server/select-runner.ts).
   */
  harness?: "pi" | "codex" | "claude-code";
  /** Optional per-doc model override (provider/model resolution is the sidecar's). */
  model?: string;
  /**
   * How agent edits reach the document — the same two modes as a shared doc editor:
   *  - "propose" (Suggesting, default): every edit is a pending proposal the reviewer
   *    approves or rejects.
   *  - "direct" (Editing): edits from the explicit edit flows (Improve, Resolve [[ ]],
   *    Review findings) are applied as soon as the agent produces them.
   * Either way the agent has no write tools and every applied edit is a recorded
   * proposal with a restorable pre-apply version (see orchestrator/proposal-service.ts).
   * Conversation turns (discuss/reply/panel) never edit in either mode.
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
  agentEdit: "propose",
  webSearch: { enabled: true, provider: "ddg" },
};

export async function readSettings(docPath: string): Promise<HadSettings> {
  // Resolve the default harness from the app config at call-time so that a
  // change to ~/.docuzen/config.toml (e.g. via the first-run modal) takes
  // effect for new documents without a sidecar restart.
  const configured = readAppConfig().harness?.default;
  const defaults: HadSettings = { ...DEFAULTS, ...(configured ? { harness: configured } : {}) };
  const settings = await readJsonFile<Partial<HadSettings>>(hadPaths(docPath).settings, () => ({}));
  return { ...defaults, ...settings };
}

export async function writeSettings(docPath: string, settings: HadSettings): Promise<void> {
  const path = hadPaths(docPath).settings;
  await withFileLock(path, () => writeJsonFile(path, settings));
}
