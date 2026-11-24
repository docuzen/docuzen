// The Settings modal (per-document harness, tool scope, edit mode, default model,
// standing instructions, web search), the model manager inside it (pi's models.json,
// keys write-only), and the topbar harness/model badge that summarises the result.
// Split out of shell.ts; it knows nothing about tabs beyond "which document is active". The
// modal belongs to the document it was opened for: it reads and saves that document's
// settings by path, and the shell closes it when another document becomes active.
import type { AgentHarness, HadSettings, ModelConfig } from "@ai-native-doc/docd/protocol";
import type { ShellDeps } from "./shell.js";
import { confirmAction, el, wireModal, reportError } from "./ui.js";

export interface SettingsDeps extends Pick<ShellDeps, "api" | "log" | "modelName" | "refreshThreadModels" | "setDefaultModelKey"> {
  /** Settings are per document: the active one's path, or undefined (the modal and saves are no-ops). */
  activeDocPath: () => string | undefined;
}

export interface SettingsApi {
  openSettings: () => Promise<void>;
  /** Close the modal and let go of its document (the shell calls this when the active document changes). */
  closeSettings: () => void;
  /** Refresh the topbar harness/model badge from the live RPCs. */
  refreshHarnessBadge: () => Promise<void>;
}

export function initSettings(deps: SettingsDeps): SettingsApi {
  // --- Settings modal (per-doc tool scope, default model + model manager, stances) ---
  const settingsModal = document.querySelector<HTMLDivElement>("#settingsModal")!;
  const setHarnessEl = document.querySelector<HTMLSelectElement>("#setHarness")!;
  const harnessCapsEl = document.querySelector<HTMLDivElement>("#harnessCaps")!;
  const modeRow = document.querySelector<HTMLElement>("#permissionModeRow")!;
  const modeSelect = document.querySelector<HTMLSelectElement>("#setPermissionMode")!;
  const modeHint = document.querySelector<HTMLElement>("#permissionModeHint")!;
  let modeQuery = 0;

  async function refreshModes(): Promise<void> {
    const query = ++modeQuery;
    const harness = selectedHarnessInfo();
    const docPath = settingsDocPath;
    modeRow.hidden = !harness?.permissionModes || !harness.available;
    modeSelect.disabled = true;
    modeSelect.replaceChildren();
    if (modeRow.hidden || !docPath || !harness) return;
    modeHint.textContent = "Checking modes…";
    try {
      const result = await deps.api.getHarnessModes({ docPath, harness: harness.id });
      if (query !== modeQuery || settingsDocPath !== docPath) return;
      for (const mode of result.modes) modeSelect.append(el("option", { value: mode.id, textContent: mode.name }));
      modeSelect.value = result.selected;
      modeSelect.disabled = !result.modes.length;
      modeHint.textContent = modeSelect.value ? "Applies to the next turn. Document changes use Docuzen proposals." : "Choose a mode supported by this session.";
    } catch (err) {
      if (query === modeQuery && settingsDocPath === docPath) modeHint.textContent = String(err);
    }
  }
  const setScopeEl = document.querySelector<HTMLSelectElement>("#setScope")!;
  const setAgentEditEl = document.querySelector<HTMLSelectElement>("#setAgentEdit")!;
  const setInstructionsEl = document.querySelector<HTMLTextAreaElement>("#setInstructions")!;
  const setWebSearchEl = document.querySelector<HTMLInputElement>("#setWebSearch")!;
  const setWebProviderEl = document.querySelector<HTMLSelectElement>("#setWebProvider")!;
  const setDefaultModelEl = document.querySelector<HTMLSelectElement>("#setDefaultModel")!;
  const setDefaultModelHintEl = document.querySelector<HTMLSpanElement>("#setDefaultModelHint")!;
  const setWebSearchHintEl = document.querySelector<HTMLSpanElement>("#setWebSearchHint")!;
  const modelListEl = document.querySelector<HTMLDivElement>("#modelList")!;
  const modelAddBtn = document.querySelector<HTMLButtonElement>("#modelAddBtn")!;
  const modelFormEl = document.querySelector<HTMLDivElement>("#modelForm")!;
  const mfNameEl = document.querySelector<HTMLInputElement>("#mfName")!;
  const mfProviderEl = document.querySelector<HTMLInputElement>("#mfProvider")!;
  const mfModelIdEl = document.querySelector<HTMLInputElement>("#mfModelId")!;
  const mfBaseUrlEl = document.querySelector<HTMLInputElement>("#mfBaseUrl")!;
  const mfApiKeyEl = document.querySelector<HTMLInputElement>("#mfApiKey")!;
  const mfReasoningEl = document.querySelector<HTMLSelectElement>("#mfReasoning")!;
  const mfSaveBtn = document.querySelector<HTMLButtonElement>("#mfSave")!;
  const mfCancelBtn = document.querySelector<HTMLButtonElement>("#mfCancel")!;

  // A model as the backend persists/returns it. `apiKey` is write-only: the
  // backend NEVER returns it (see `hasKey`), and we only ever send it when the
  // user types a new key — omitting it preserves the existing key for that provider.
  // (ModelConfig itself is the canonical protocol type, imported above.)

  // listHarnesses never returns `runner` (the server-side adapter instance).
  type HarnessInfo = Omit<AgentHarness, "runner">;
  let harnesses: HarnessInfo[] = [];

  /**
   * Network-only harness fetch, shared by the Settings modal's refreshHarnesses
   * (which also drives the harness <select>) and the topbar badge's
   * refreshHarnessBadge (which must NOT touch the modal's DOM).
   */
  async function loadHarnesses(): Promise<HarnessInfo[]> {
    try {
      harnesses = await deps.api.listHarnesses({});
    } catch (e) {
      reportError("harnesses load", e, deps.log);
      harnesses = [];
    }
    return harnesses;
  }

  function renderHarnessCaps(id: string): void {
    const h = harnesses.find((x) => x.id === id);
    harnessCapsEl.replaceChildren();
    if (!h) return;
    const caps = [
      h.capabilities.proposeEdits ? "Proposals" : "",
      h.capabilities.directEdit ? "Direct edit" : "",
      h.capabilities.reviewFindings ? "Review" : "",
      h.capabilities.webSearch === "docuzen-managed"
        ? "Web: Docuzen"
        : h.capabilities.webSearch === "harness-managed"
          ? "Web: harness"
          : "",
      h.capabilities.documentTools === "docuzen-managed" ? "Doc tools: managed" : "",
      h.id === "codex" ? "Model: Docuzen provider" : h.id !== "pi" ? "Model: harness-managed" : "",
      h.capabilities.thinking ? "Thinking" : "",
      h.capabilities.cancel ? "Cancel" : "",
      h.capabilities.multiModelPanel ? "Panel" : "",
    ].filter(Boolean);
    for (const c of caps) {
      harnessCapsEl.appendChild(el("span", { className: "capchip", textContent: c }));
    }
    if (!h.available) {
      harnessCapsEl.appendChild(
        el("span", {
          className: "capchip unavailable",
          textContent: h.unavailableReason ? `Unavailable: ${h.unavailableReason}` : "Unavailable",
        }),
      );
    } else if (h.status) {
      harnessCapsEl.appendChild(el("span", { className: "capchip", textContent: h.status }));
    }
  }

  async function refreshHarnesses(selected = "pi"): Promise<void> {
    await loadHarnesses();
    setHarnessEl.replaceChildren();
    for (const h of harnesses) {
      setHarnessEl.appendChild(
        el("option", { value: h.id, textContent: h.available ? h.label : `${h.label} (unavailable)` }),
      );
    }
    setHarnessEl.value = selected;
    if (!setHarnessEl.value && selected) {
      setHarnessEl.append(el("option", { value: selected, textContent: selected + " (not configured)" }));
      setHarnessEl.value = selected;
    }
    renderHarnessCaps(setHarnessEl.value || selected);
    syncHarnessManagedControls();
  }

  function selectedHarnessInfo(): HarnessInfo | undefined {
    return harnesses.find((h) => h.id === setHarnessEl.value);
  }

  function syncHarnessManagedControls(): void {
    const h = selectedHarnessInfo();
    const harnessManagedModels = !!h && h.id !== "pi" && h.id !== "codex";
    setDefaultModelEl.disabled = harnessManagedModels;
    modelAddBtn.disabled = harnessManagedModels;
    modelListEl.classList.toggle("disabled", harnessManagedModels);
    for (const btn of modelListEl.querySelectorAll<HTMLButtonElement>("button")) {
      btn.disabled = harnessManagedModels;
    }
    if (harnessManagedModels) {
      setDefaultModelEl.value = "";
      hideModelForm();
    }
    setDefaultModelHintEl.textContent = harnessManagedModels
      ? `${h?.label ?? "This harness"} uses its own model configuration.`
      : h?.id === "codex"
        ? "Select a model row to launch Codex with a Docuzen provider instead of ~/.codex defaults."
      : "";

    const harnessManagedWebSearch = h?.capabilities.webSearch === "harness-managed";
    setWebSearchEl.disabled = harnessManagedWebSearch;
    setWebProviderEl.disabled = harnessManagedWebSearch;
    setWebSearchHintEl.textContent = harnessManagedWebSearch
      ? `${h?.label ?? "This harness"} manages web search itself.`
      : "";
  }
  // Cached list of configured models (from listModels — never carries apiKey).
  let configuredModels: ModelConfig[] = [];

  /** Strip apiKey from a ModelConfig so saveModels preserves the stored key. */
  function withoutKey(m: ModelConfig): ModelConfig {
    const { apiKey: _drop, ...rest } = m;
    return rest;
  }

  /**
   * Re-fetch configured models and rebuild both the model list (with Edit/Remove
   * per row) and the default-model select. Server strings (names, ids) are placed
   * via textContent only — never innerHTML — so user input can't inject markup.
   */
  async function refreshModels(): Promise<void> {
    try {
      configuredModels = await deps.api.listModels({});
    } catch (e) {
      reportError("models load", e, deps.log);
      return;
    }

    modelListEl.innerHTML = "";
    for (const m of configuredModels) {
      const editBtn = el("button", { type: "button", textContent: "Edit" });
      editBtn.addEventListener("click", () => showModelForm(m));

      const removeBtn = el("button", { type: "button", textContent: "Remove" });
      removeBtn.addEventListener("click", () => void removeModel(m.key));

      modelListEl.appendChild(
        el("div", { className: "modelrow" }, [
          el("span", { className: "mname", textContent: m.name }),
          el("span", {
            className: "mmeta",
            textContent: `${m.provider}/${m.modelId} · ${m.reasoningEffort ?? "none"} · ${m.hasKey ? "🔑" : "no key"}`,
          }),
          el("span", { className: "mspace" }),
          editBtn,
          removeBtn,
        ]),
      );
    }
    // Rebuild the default-model select, preserving the current selection if still present.
    const prev = setDefaultModelEl.value;
    setDefaultModelEl.innerHTML = "";
    setDefaultModelEl.appendChild(el("option", { value: "", textContent: "— sidecar default —" }));
    for (const m of configuredModels) {
      setDefaultModelEl.appendChild(el("option", { value: m.key, textContent: m.name }));
    }
    if (prev && configuredModels.some((m) => m.key === prev)) setDefaultModelEl.value = prev;
    syncHarnessManagedControls();
  }

  /** The key of the row the form is editing (Edit mode), or undefined when adding. */
  let editingKey: string | undefined;

  /** Show the add/edit form. `existing` → Edit mode (key left blank = keep); omitted → empty Add. */
  function showModelForm(existing?: ModelConfig): void {
    editingKey = existing?.key;
    mfNameEl.value = existing?.name ?? "";
    mfProviderEl.value = existing?.provider ?? (setHarnessEl.value === "codex" ? "docuzen" : "");
    mfModelIdEl.value = existing?.modelId ?? "";
    mfBaseUrlEl.value = existing?.baseUrl ?? "";
    mfApiKeyEl.value = ""; // never returned — blank means "keep existing key"
    mfReasoningEl.value = existing?.reasoningEffort ?? "none";
    modelFormEl.hidden = false;
  }
  function hideModelForm(): void {
    modelFormEl.hidden = true;
    editingKey = undefined;
  }

  async function saveModelFromForm(): Promise<void> {
    const provider = mfProviderEl.value.trim();
    const modelId = mfModelIdEl.value.trim();
    const name = mfNameEl.value.trim();
    if (!provider || !modelId || !name) return void deps.log("model: name, provider and model id are required");
    const apiKey = mfApiKeyEl.value.trim();
    const edited: ModelConfig = {
      key: `${provider}/${modelId}`,
      name,
      provider,
      modelId,
      baseUrl: mfBaseUrlEl.value.trim() || undefined,
      reasoningEffort: mfReasoningEl.value as ModelConfig["reasoningEffort"],
      ...(apiKey ? { apiKey } : {}),
    };
    // Merge: replace the edited row (found by the key it had when the form opened, so changing
    // its provider or model id renames it instead of adding a second row) or the same-key
    // entry, else append (Add). Unchanged rows are sent WITHOUT apiKey so saveModels
    // preserves their stored keys.
    if (editingKey !== undefined && edited.key !== editingKey && configuredModels.some((m) => m.key === edited.key)) {
      return void deps.log(`model: ${edited.key} already exists — edit that row instead`);
    }
    const idx = configuredModels.findIndex((m) => m.key === (editingKey ?? edited.key));
    const models =
      idx >= 0
        ? configuredModels.map((m, i) => (i === idx ? edited : withoutKey(m)))
        : [...configuredModels.map(withoutKey), edited];
    try {
      await deps.api.saveModels({ models });
      deps.log(`saved model ${edited.key}`);
    } catch (e) {
      return void reportError("save model", e, deps.log);
    }
    hideModelForm();
    await refreshModels();
    await deps.refreshThreadModels(); // keep the thread pickers' cache in sync
  }

  async function removeModel(key: string): Promise<void> {
    if (!(await confirmAction(`Remove model ${key}?`))) return;
    // Send the remainder without apiKey on any row → all surviving keys preserved.
    const models = configuredModels.filter((m) => m.key !== key).map(withoutKey);
    try {
      await deps.api.saveModels({ models });
      deps.log(`removed model ${key}`);
    } catch (e) {
      return void reportError("remove model", e, deps.log);
    }
    await refreshModels();
    await deps.refreshThreadModels(); // keep the thread pickers' cache in sync
  }

  modelAddBtn.addEventListener("click", () => showModelForm());
  mfSaveBtn.addEventListener("click", () => void saveModelFromForm());
  mfCancelBtn.addEventListener("click", () => hideModelForm());

  /** The document the open modal shows and saves; undefined while it is closed or loading. */
  let settingsDocPath: string | undefined;
  /** Bumped by every open and close, so a slow open cannot show the modal after either. */
  let openSeq = 0;

  async function openSettings(): Promise<void> {
    const docPath = deps.activeDocPath();
    if (!docPath) return void deps.log("settings: open a document first");
    closeSettings();
    const seq = ++openSeq;
    // A load the user has moved on from (another document, or Settings closed) stops here.
    const stale = () => seq !== openSeq || deps.activeDocPath() !== docPath;
    try {
      const s = await deps.api.getSettings({ docPath });
      if (stale()) return;
      setScopeEl.value = s.scope ?? "folder";
      await refreshHarnesses(s.harness ?? "pi");
      if (stale()) return;
      setAgentEditEl.value = s.agentEdit ?? "propose";
      setInstructionsEl.value = s.instructions ?? "";
      setWebSearchEl.checked = s.webSearch?.enabled !== false;
      setWebProviderEl.value = s.webSearch?.provider ?? "ddg";
      await refreshModels();
      if (stale()) return;
      setDefaultModelEl.value = s.model ?? "";
      syncHarnessManagedControls();
    } catch (e) {
      // Never show the form without this document's values: it would hold the last
      // document's, and the first change would save them onto this one.
      return void reportError("settings load", e, deps.log);
    }
    settingsDocPath = docPath;
    void refreshModes();
    settingsModal.hidden = false;
  }

  function closeSettings(): void {
    // Instructions save on blur; a keyboard tab switch closes the modal without one, so save
    // what was typed now, to the document it was typed for.
    if (settingsDocPath && document.activeElement === setInstructionsEl) void saveSettings();
    openSeq++;
    settingsDocPath = undefined;
    settingsModal.hidden = true;
    hideModelForm();
  }

  // Settings opens from the native File menu (⌘,) — see the menu-action listener.
  async function saveSettings(permissionMode?: string): Promise<void> {
    const docPath = settingsDocPath;
    if (!docPath) return;
    const harness = selectedHarnessInfo();
    const harnessManagedModels = !!harness && harness.id !== "pi" && harness.id !== "codex";
    const model = harnessManagedModels ? undefined : setDefaultModelEl.value || undefined;
    if (deps.activeDocPath() === docPath) deps.setDefaultModelKey(model ?? ""); // thread pickers default to the new per-doc model
    const instructions = setInstructionsEl.value.trim() || undefined;
    const webSearch = {
      enabled: setWebSearchEl.checked,
      provider: setWebProviderEl.value as "ddg" | "brave" | "tavily",
    };
    try {
      await deps.api.setSettings({
        docPath,
        ...(permissionMode ? { permissionMode } : {}),
        settings: {
          scope: setScopeEl.value as HadSettings["scope"],
          harness: (setHarnessEl.value || "pi") as HadSettings["harness"],
          agentEdit: setAgentEditEl.value as HadSettings["agentEdit"],
          model,
          instructions,
          webSearch,
        },
      });
      deps.log(`settings saved (scope=${setScopeEl.value}, harness=${setHarnessEl.value || "default"}, model=${model ?? "default"})`);
      void refreshHarnessBadge(); // reflect the just-saved harness/model in the topbar chip
    } catch (e) {
      reportError("settings save", e, deps.log);
    }
  }
  modeSelect.addEventListener("change", () => void saveSettings(modeSelect.value));
  setScopeEl.addEventListener("change", () => void saveSettings());
  setHarnessEl.addEventListener("change", () => {
    renderHarnessCaps(setHarnessEl.value);
    syncHarnessManagedControls();
    void refreshModes();
    void saveSettings();
  });
  setAgentEditEl.addEventListener("change", () => void saveSettings());
  setDefaultModelEl.addEventListener("change", () => void saveSettings());
  setInstructionsEl.addEventListener("blur", () => void saveSettings());
  setWebSearchEl.addEventListener("change", () => void saveSettings());
  setWebProviderEl.addEventListener("change", () => void saveSettings());
  document.querySelector("#settingsClose")!.addEventListener("click", () => closeSettings());
  wireModal(settingsModal); // click backdrop to close

  // --- topbar: harness/model badge (Phase 11 T1) ---
  // A persistent chip showing the active harness + its default model, so users
  // always know what agent they're talking to without opening Settings.
  // Sourced from the same RPCs as the Settings modal (listHarnesses/
  // getSettings) via the shared `loadHarnesses`/`harnesses` cache above, but
  // resolves the model KEY to a display NAME through `deps.modelName`
  // (chat.ts's `threadModels` cache) rather than this module's own
  // `configuredModels` — that cache is lazy (only populated once Settings is
  // opened), while chat.ts's is already refreshed at boot by main.ts's
  // `chat.refreshThreadModels()`, so it's the fresher source for a badge that
  // must be right immediately on launch. This reflects the per-doc DEFAULT
  // model only — per-thread overrides still show only in the chat pane's own
  // pickers (unchanged); the tooltip says so explicitly.
  const harnessBadgeEl = document.querySelector<HTMLSpanElement>("#harnessBadge")!;

  function renderHarnessBadge(harness: HarnessInfo | undefined, settings: HadSettings | undefined): void {
    if (!harness) {
      harnessBadgeEl.textContent = "—";
      harnessBadgeEl.title = "No agent harness detected.";
      harnessBadgeEl.classList.remove("unavailable");
      return;
    }
    const harnessManagedModel = harness.id !== "pi" && harness.id !== "codex"; // mirrors syncHarnessManagedControls' own check
    const modelKey = settings?.model;
    const modelPart = harnessManagedModel
      ? "harness-managed" // same vocabulary as this file's own "Model: harness-managed" capchip
      : modelKey
        ? deps.modelName(modelKey)
        : harness.id === "codex"
          ? "Codex config default"
        : "sidecar default"; // same vocabulary as refreshModels' "— sidecar default —" option
    harnessBadgeEl.textContent = `${harness.label} · ${modelPart}`;
    harnessBadgeEl.classList.toggle("unavailable", !harness.available);
    harnessBadgeEl.title = [
      harness.available
        ? `Available${harness.status ? ` (${harness.status})` : ""}`
        : `Unavailable${harness.unavailableReason ? `: ${harness.unavailableReason}` : ""}`,
      "Defaults — per-thread overrides show in the chat pane.",
      "Change in Settings (⌘,).",
    ].join("\n");
  }

  /**
   * Refresh the badge from the live RPCs. Triggers: boot (main.ts, once the
   * initial doc/tab is settled) and after saveSettings above — no other
   * trigger by design (e.g. switching tabs does not re-fetch), matching the
   * plan's explicit refresh contract rather than inventing extra staleness
   * handling.
   */
  async function refreshHarnessBadge(): Promise<void> {
    const list = await loadHarnesses();
    let settings: HadSettings | undefined;
    const docPath = deps.activeDocPath();
    if (docPath) {
      try {
        settings = await deps.api.getSettings({ docPath });
      } catch (e) {
        reportError("badge settings load", e, deps.log);
      }
    }
    const harnessId = settings?.harness ?? "pi";
    renderHarnessBadge(list.find((h) => h.id === harnessId), settings);
  }

  return { openSettings, closeSettings, refreshHarnessBadge };
}
