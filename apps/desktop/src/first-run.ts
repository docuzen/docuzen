// First-launch harness setup: shown when ~/.docuzen/config.toml names no
// harness. Saving writes the app config over RPC, then (packaged app only)
// bounces the sidecar via the restart_sidecar Tauri command so the choice
// takes effect immediately — rpc.ts auto-reconnects on the same port.
import type { AppConfig } from "@ai-native-doc/docd/protocol";
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

async function restartSidecar(): Promise<void> {
  const tauri = (window as { __TAURI__?: { core?: { invoke?: (cmd: string) => Promise<unknown> } } }).__TAURI__;
  await tauri?.core?.invoke?.("restart_sidecar");
}

export async function maybeShowFirstRun(client: FirstRunClient, log: (line: string) => void): Promise<void> {
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

  const syncRows = () => {
    const codex = harnessSel.value === "codex";
    piRow.hidden = codex;
    hint.textContent = codex
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
      const config: AppConfig =
        harnessSel.value === "codex"
          ? { harness: { default: "codex" } }
          : { harness: { default: "pi" }, pi: modelSel.value ? { model: modelSel.value } : {} };
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
    })();
  });

  wireModal(modal);
  modal.hidden = false;
}
