// The Settings modal (per-document harness, tool scope, edit mode, default model,
// standing instructions, web search), the model manager inside it (pi's models.json,
// keys write-only), and the active document’s harness in the status bar.
// Split out of shell.ts; it knows nothing about tabs beyond "which document is active". The
// modal belongs to the document it was opened for: it reads and saves that document's
// settings by path, and the shell closes it when another document becomes active.
import type { AgentHarness, HadSettings, ModelConfig } from "@ai-native-doc/docd/protocol";
import type { ShellDeps } from "./shell.js";
import { confirmAction, el, wireModal, reportError } from "./ui.js";

export interface SettingsDeps extends Pick<ShellDeps, "api" | "log" | "modelName" | "refreshThreadModels" | "setDefaultModelKey" | "setHarnessContext"> {
  /** Settings are per document: the active one's path, or undefined (the modal and saves are no-ops). */
  activeDocPath: () => string | undefined;
}

export interface SettingsApi {
  openSettings: () => Promise<void>;
  /** Close the modal and let go of its document (the shell calls this when the active document changes). */
  closeSettings: () => void;
  /** Refresh the active document’s harness and model from the sidecar. */
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
  const providersEl = document.querySelector<HTMLDetailsElement>("#modelProviders")!;
  const countEl = document.querySelector<HTMLElement>("#modelCount")!;
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

  async function loadHarnesses(): Promise<HarnessInfo[]> {
    try {
      return (await deps.api.listHarnesses({})) ?? [];
    } catch (e) {
      reportError("harnesses load", e, deps.log);
      return [];
    }
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
    harnesses = await loadHarnesses();
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
    providersEl.hidden = harnessManagedModels;
    if (harnessManagedModels) providersEl.open = false;
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

    countEl.textContent = "(" + configuredModels.length + ")";
    modelListEl.innerHTML = "";
    for (const m of configuredModels) {
      const editBtn = el("button", { type: "button", textContent: "Edit" });
      editBtn.addEventListener("click", () => showModelForm(m));

      const removeBtn = el("button", { type: "button", textContent: "Remove" });
      removeBtn.addEventListener("click", () => void removeModel(m.key));

      modelListEl.appendChild(
        el("div", { className: "modelrow" }, [
          el("div", { className: "modelinfo" }, [
            el("span", { className: "mname", textContent: m.name }),
            el("span", { className: "mmeta", textContent: [
              m.key, m.reasoningEffort && m.reasoningEffort !== "none" ? m.reasoningEffort + " reasoning" : "",
              m.hasKey ? "" : "No API key",
            ].filter(Boolean).join(" · ") }),
          ]),
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
    mfNameEl.focus();
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
    providersEl.open = false;
    settingsModal.querySelector(".settings-scroll")!.scrollTop = 0;
    void refreshModes();
    settingsModal.hidden = false;
    setHarnessEl.focus();
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
      void refreshHarnessBadge();
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
  wireModal(settingsModal, closeSettings);

  const harnessBadgeEl = document.querySelector<HTMLButtonElement>("#harnessBadge")!;
  harnessBadgeEl.addEventListener("click", () => void openSettings());
  let badgeQuery = 0;
  let badgeDoc: string | undefined;

  // getSettings resolves the same document/app/registry default that starts a discussion.
  // Replies to saved threads use their own harness; chat shows that choice at the composer.
  async function refreshHarnessBadge(): Promise<void> {
    const query = ++badgeQuery;
    const docPath = deps.activeDocPath();
    harnessBadgeEl.disabled = !docPath;
    if (!docPath || docPath !== badgeDoc) {
      badgeDoc = docPath;
      harnessBadgeEl.textContent = docPath ? "Document harness: Loading…" : "Document harness: No document";
      harnessBadgeEl.classList.remove("unavailable");
      harnessBadgeEl.title = docPath ? "Open document harness settings" : "Open a document to choose its harness.";
      deps.setHarnessContext(undefined, []);
    }
    if (!docPath) return;
    const [list, settings] = await Promise.all([
      loadHarnesses(),
      deps.api.getSettings({ docPath }).catch((e) => {
        reportError("document settings", e, deps.log);
        return undefined;
      }),
    ]);
    if (query !== badgeQuery || deps.activeDocPath() !== docPath) return;
    const id = settings?.harness;
    const h = list.find(item => item.id === id);
    const modelKey = settings?.model;
    const model = modelKey && (id === "pi" || id === "codex") ? deps.modelName(modelKey) : "";
    const unavailable = !!id && list.length > 0 && !h?.available;
    harnessBadgeEl.textContent = "Document harness: " + (h?.label ?? id ?? "Unknown") +
      (unavailable ? " (unavailable)" : model ? " · " + model : "");
    harnessBadgeEl.classList.toggle("unavailable", unavailable);
    harnessBadgeEl.title = [h?.unavailableReason ?? h?.status, "Used for new discussions. Click to change in Settings."].filter(Boolean).join("\n");
    deps.setDefaultModelKey(modelKey ?? "");
    deps.setHarnessContext(id, list);
  }

  return { openSettings, closeSettings, refreshHarnessBadge };
}
