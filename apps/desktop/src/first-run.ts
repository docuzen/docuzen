// First-launch harness setup: shown when ~/.docuzen/config.toml names no
// harness. Saving writes the app config over RPC, then (packaged app only)
// bounces the sidecar via the restart_sidecar Tauri command so the choice
// takes effect immediately — rpc.ts auto-reconnects on the same port.
import type { AppConfig, AgentHarness } from "@ai-native-doc/docd/protocol";
import { wireModal } from "./ui.js";

interface FirstRunClient {
  call(method: string, params: Record<string, unknown>): Promise<unknown>;
}

interface ModelRow {
  key: string;
  name: string;
  hasKey?: boolean;
}

export function shouldShowFirstRun(config: AppConfig): boolean {
  return config.harness === null;
}

/**
 * The config to save for the harness picked in the modal: the existing config with the
 * harness set (and, for pi, the picked model). Sections the user already has, such as a
 * `[codex] command` or a `[pi] model` when no model is picked here, are kept.
 */
export function configWithHarness(current: AppConfig, harness: NonNullable<AppConfig["harness"]>["default"], piModel: string): AppConfig {
  const config: AppConfig = { ...current, harness: { default: harness } };
  if (harness === "pi" && piModel) config.pi = { ...current.pi, model: piModel };
  return config;
}

/** Which harness the setup modal should preselect, given what is usable on this machine. */
export function pickUsableHarness(
  models: { key: string; hasKey?: boolean }[],
  codexUsable: boolean,
): { harness: "pi" | "codex"; model?: string } {
  const keyed = models.find((m) => m.hasKey);
  if (keyed) return { harness: "pi", model: keyed.key };
  return { harness: codexUsable ? "codex" : "pi" };
}

async function restartSidecar(): Promise<void> {
  const tauri = (window as { __TAURI__?: { core?: { invoke?: (cmd: string) => Promise<unknown> } } }).__TAURI__;
  await tauri?.core?.invoke?.("restart_sidecar");
}

export interface FirstRunOptions {
  /** Called once the choice is saved and the sidecar restarted (main.ts refreshes the harness badge). */
  onConfigured?: () => void;
}

export async function maybeShowFirstRun(
  client: FirstRunClient,
  log: (line: string) => void,
  opts: FirstRunOptions = {},
): Promise<void> {
  let state: { config: AppConfig; piUsable: boolean; codexUsable: boolean };
  try {
    state = (await client.call("getAppConfig", {})) as typeof state;
  } catch {
    return; // never block startup on this modal (e.g. older sidecar in dev)
  }
  if (!shouldShowFirstRun(state.config)) return;

  const modal = document.querySelector<HTMLDivElement>("#firstRunModal");
  if (!modal) return;
  const harnessSel = modal.querySelector<HTMLSelectElement>("#firstRunHarness")!;
  const modelSel = modal.querySelector<HTMLSelectElement>("#firstRunModel")!;
  const piRow = modal.querySelector<HTMLDivElement>("#firstRunPiRow")!;
  const hint = modal.querySelector<HTMLDivElement>("#firstRunHint")!;
  const saveBtn = modal.querySelector<HTMLButtonElement>("#firstRunSave")!;
  const skipBtn = modal.querySelector<HTMLButtonElement>("#firstRunSkip")!;

  let models: ModelRow[] = [];
  try {
    models = (await client.call("listModels", {})) as ModelRow[];
  } catch {
    models = [];
  }
  modelSel.innerHTML = "";
  for (const m of models) {
    const opt = document.createElement("option");
    opt.value = m.key;
    opt.textContent = m.hasKey ? `${m.key} — ${m.name}` : `${m.key} — ${m.name} (no API key saved)`;
    modelSel.append(opt);
  }
  if (models.length === 0) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "no models in ~/.pi/agent/models.json — add one in File → Settings";
    modelSel.append(opt);
  }

  // Preselect whatever can work right now, so "Save" on a fresh install is one click:
  // pi when a model already has a stored key (and that model), else codex when its CLI
  // was detected, else pi (the modal then explains what is missing).
  let harnesses: Omit<AgentHarness, "runner">[] = [];
  try {
    harnesses = await client.call("listHarnesses", {}) as typeof harnesses;
  } catch { /* Older sidecars supply only the two built-in options. */ }
  if (harnesses?.length) {
    harnessSel.replaceChildren(...harnesses.map(h => {
      const option = document.createElement("option");
      option.value = h.id;
      option.textContent = h.available ? h.label : h.label + " (unavailable)";
      return option;
    }));
  }
  const usable = pickUsableHarness(models, state.codexUsable);
  harnessSel.value = harnesses?.length && !harnesses.find(h => h.id === usable.harness)?.available
    ? (harnesses.find(h => h.available)?.id ?? usable.harness) : usable.harness;
  if (usable.model) modelSel.value = usable.model;

  const syncRows = () => {
    const codex = harnessSel.value === "codex";
    piRow.hidden = harnessSel.value !== "pi";
    const selected = harnesses?.find(h => h.id === harnessSel.value);
    hint.textContent = selected ? (selected.unavailableReason ?? selected.status ?? "") : codex
      ? state.codexUsable
        ? "codex CLI detected"
        : "codex CLI not found on PATH — install it or pick Pi"
      : "";
  };
  harnessSel.addEventListener("change", syncRows);
  syncRows();

  skipBtn.addEventListener("click", () => {
    modal.hidden = true;
  });

  saveBtn.addEventListener("click", () => {
    void (async () => {
      saveBtn.disabled = true;
      const config = configWithHarness(state.config, harnesses?.find(h => h.id === harnessSel.value)?.id ?? (harnessSel.value === "codex" ? "codex" : "pi"), modelSel.value);
      try {
        await client.call("setAppConfig", { config });
      } catch (e) {
        log(`first-run save failed: ${String(e)}`);
        saveBtn.disabled = false;
        return; // modal stays open; user can retry
      }
      modal.hidden = true;
      log(`harness configured: ${harnessSel.value}`);
      try {
        await restartSidecar();
      } catch (e) {
        log(`sidecar restart failed (config saved — restart the app to apply): ${String(e)}`);
      }
      opts.onConfigured?.();
    })();
  });

  wireModal(modal);
  modal.hidden = false;
}
