import type { AgentRunner } from "./types.js";

export type HarnessId = "pi" | "codex" | "claude-code";

export interface HarnessCapabilities {
  proposeEdits: boolean;
  directEdit: boolean;
  reviewFindings: boolean;
  webSearch: "docuzen-managed" | "harness-managed" | "none";
  /** Vetted document-type toolchain handling; users do not configure MCP directly. */
  documentTools: "docuzen-managed" | "none";
  thinking: boolean;
  cancel: boolean;
  multiModelPanel: boolean;
}

export interface AgentHarness {
  id: HarnessId;
  label: string;
  runner: AgentRunner;
  capabilities: HarnessCapabilities;
  /** False when the adapter is known but unavailable in the current environment. */
  available: boolean;
  /** Short positive status, e.g. a detected CLI version. */
  status?: string;
  /** Clear reason shown when a known adapter is unavailable. */
  unavailableReason?: string;
}

export const PI_CAPABILITIES: HarnessCapabilities = {
  proposeEdits: true,
  directEdit: true,
  reviewFindings: true,
  webSearch: "docuzen-managed",
  documentTools: "docuzen-managed",
  thinking: true,
  cancel: true,
  multiModelPanel: true,
};

export class HarnessRegistry {
  private items = new Map<HarnessId, AgentHarness>();

  constructor(private fallback: HarnessId = "pi") {}

  static single(runner: AgentRunner): HarnessRegistry {
    const r = new HarnessRegistry("pi");
    r.register({
      id: "pi",
      label: "Pi",
      runner,
      capabilities: PI_CAPABILITIES,
      available: true,
    });
    return r;
  }

  register(harness: AgentHarness): void {
    this.items.set(harness.id, harness);
  }

  defaultId(): HarnessId {
    return this.fallback;
  }

  list(): Omit<AgentHarness, "runner">[] {
    return [...this.items.values()].map(({ runner: _runner, ...rest }) => rest);
  }

  resolve(id?: string): AgentHarness {
    const requested = (id as HarnessId | undefined) ?? this.fallback;
    const harness = this.items.get(requested) ?? this.items.get(this.fallback);
    if (!harness) throw new Error(`no agent harness registered for ${requested}`);
    if (!harness.available) {
      const reason = harness.unavailableReason ? `: ${harness.unavailableReason}` : "";
      throw new Error(`agent harness unavailable: ${harness.id}${reason}`);
    }
    return harness;
  }
}
