// Settings modal (per-doc tool scope, default model + model manager, harness caps,
// stances) + version preview/picker modals + doc actions (Save/Export/Open) + the
// Tauri native-menu wiring + (wave-2) tabs: one editor, many documents, session
// persistence, and the DocSession store's OWNERSHIP FLIP.
//
// OWNERSHIP FLIP (Task 5): main.ts's `DOC_PATH`/`currentFormat` globals are GONE.
// This module's `tabs`/`activeIdx` are now the single, sole source of truth for
// "what document is active" — `getDocPath()`/`getFormat()` derive it live from
// `tabs[activeIdx]` on every call (never cached), and main.ts's `sessionStore`
// delegate (session.ts) reads through these two methods instead of a pair of
// module-level globals. `notifySessionActive` (wired to `sessionStore.setActive`)
// is still called from `activateTab` purely to fire the store's `onChange`
// listeners — the delegate's own setters are now no-ops (this module already
// mutated the real state before calling it), matching this task's brief: "the
// session store becomes sole owner (its delegate closures now read/write
// shell-owned state)".
//
// Wiring pattern: initShell(deps) queries this module's own DOM elements, wires
// their listeners (settings/version/model-manager modals, doc actions, tabs), and
// returns the external surface other modules call: `openVersionPreview` (the chat
// pane's thread-tree 📄 chip), `wireMenu` (called once by main.ts), `activateTab`/
// `openInTab`/`closeTab`/`restoreTabSession`/`showEmptyState`/`reloadActiveDoc`
// (main.ts's bootstrap `init()`, plus `reloadActiveDoc` is also a cross-module dep
// for chat.ts/proposals.ts/surface.ts), `getDocPath`/`getFormat`/`getCurrentMarkdown`/
// `getTabCount` (read accessors — `getDocPath`/`getFormat` back the session store's
// delegate; `getCurrentMarkdown` is also threaded to surface.ts's Visualize quick
// action), plus `versionModal` (main.ts's shared Escape-key handler also closes
// the diff panel — a proposals.ts concern — so that ONE cross-cutting listener
// stays at the composition root rather than reaching back out of this module).
//
// `annoKey`/`proposalKey`/`searchKey` (editor.ts's singleton PluginKeys) cross into
// this module WITHOUT an editor.ts import, per the plan's "modules never import
// each other" rule — the same by-value precedent surface.ts's `searchKey` already
// set. `LoadedAnno`/`ProposalView` are redeclared locally rather than imported
// (the `SearchMeta` precedent from Task 2) — see this file's tabs section.
//
// DOM-query timing: like editor.ts, this module does no module-scope
// `document.querySelector`. All of its elements are queried once, inside
// initShell()'s body, at the same point main.ts used to query them (main.ts calls
// initShell() at the position the old "document actions" section started) — so the
// DOM is parsed by then exactly as before. This keeps the module importable
// without a DOM and matches editor.ts's/surface.ts's choice for this task.

import type { Editor } from "@milkdown/kit/core";
import { editorViewCtx } from "@milkdown/kit/core";
import { replaceAll } from "@milkdown/kit/utils";
import type { EditorView } from "@milkdown/kit/prose/view";
import type { PluginKey } from "@milkdown/kit/prose/state";
import { save, open } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { Annotation, EditHunk } from "@ai-native-doc/docd/protocol";
import { baseHrefForDoc, type HtmlSurface } from "./html-surface.js";
import { el, wireModal, reportError } from "./ui.js";
import {
  buildVersionPickerModel,
  type VersionPickerGraphCell,
  type VersionPickerGraphRow,
  type VersionPickerVersion,
} from "./version-picker-tree.js";
import type { DocdApi } from "./session.js";
import type { AgentHarness, HadSettings, ModelConfig, ThreadNode } from "@ai-native-doc/docd/protocol";
import { initDocPath } from "./status-path.js";

/** Mirrors editor.ts's `LoadedAnno` — see this file's header (same policy as surface.ts). */
type LoadedAnno = Annotation & { body?: string; parent?: string };

/** Mirrors proposals.ts's own `ProposalView` — see that file's header for why it isn't imported. */
interface ProposalView {
  id: string;
  threadId: string;
  rationale: string;
  edits: EditHunk[];
  fullText?: string;
  status?: string;
}

export interface ShellDeps {
  api: DocdApi;
  log: (line: string) => void;
  getEditor: () => Editor | null;
  getHtmlSurface: () => HtmlSurface | null;
  /** The milkdown mount point (`#editor`), shared with editor.ts/surface.ts (same DOM node). */
  rootEl: HTMLDivElement;
  runResolveDirectives: () => Promise<void>;
  refreshThreadModels: () => Promise<void>;
  setDefaultModelKey: (key: string) => void;
  getThreadNodes: () => ThreadNode[];
  refreshThreadTree: () => Promise<void>;
  truncTitle: (s: string, max?: number) => string;
  stripFrontmatter: (s: string) => string;

  // sessionStore — see file header's OWNERSHIP FLIP note.
  notifySessionActive: (docPath: string, format: "markdown" | "html") => void;

  // editor.ts values, passed by reference — see file header.
  annoKey: PluginKey;
  proposalKey: PluginKey;
  searchKey: PluginKey;
  renderLoaded: (annotations: LoadedAnno[]) => void;

  // surface.ts (this task's Step 2)
  clearAnnotationUndo: () => void;
  showHtmlSurface: () => void;
  showMarkdownSurface: () => void;
  setEditToggleVisible: (visible: boolean) => void;
  setHtmlEditMode: (on: boolean) => void;

  // surface.ts's own initSearch() result, threaded through by main.ts.
  clearSearchHighlights: () => void;
  searchIsOpen: () => boolean;
  searchState: { query: string };
  refreshMarkdownSearch: (resetActive?: boolean, scroll?: boolean) => void;

  // proposals.ts
  renderProposal: (p: ProposalView) => void;
  openDiffPanel: (p: ProposalView) => Promise<void>;

  // chat.ts
  resetChat: () => void;
  chatTurnWithAction: (label: string, onClick: () => void) => void;
  /** Resolves a configured model key to its display name (chat.ts's `threadModels` cache — see the harness/model badge section). */
  modelName: (key: string) => string;
}

export interface ShellApi {
  openVersionPreview(versionId: string): Promise<void>;
  wireMenu(): void;
  /** Exposed only so main.ts's shared Escape-key handler can also close it (see file header). */
  versionModal: HTMLDivElement;

  // --- tabs (Task 5 wave-2) ---
  activateTab(idx: number): Promise<void>;
  openInTab(path: string): Promise<void>;
  closeTab(idx: number): Promise<void>;
  restoreTabSession(): Promise<boolean>;
  showEmptyState(): void;
  reloadActiveDoc(): Promise<void>;
  getTabCount(): number;
  /** The active tab's docPath/format — backs the session store's delegate (see file header). `undefined`/`"markdown"` when no tab is active. */
  getDocPath(): string | undefined;
  getFormat(): "markdown" | "html";
  getCurrentMarkdown(): string;
  /** Sets the active tab's live markdown text (the markdown-updated listener's tabs write). No-op with no active tab. */
  setActiveTabMarkdown(markdown: string): void;
  /** Marks the active HTML tab dirty (mirrors the iframe's onEdit callback's original guard). No-op unless the active tab is HTML. */
  markActiveHtmlTabDirty(): void;
  /** Clears the active tab's dirty flag regardless of format (mirrors syncDocToDisk's original unconditional clear). */
  clearActiveTabDirty(): void;

  // --- sidebar toggles + harness badge (Phase 11 T1) ---
  /** Exception: opening a conversation always un-collapses the left pane. No-op if already visible. */
  uncollapseLeftPane(): void;
  /** Exception: creating an annotation via the popover's Comment button always un-collapses the right rail. No-op if already visible. */
  uncollapseRightRail(): void;
  /** Refresh the harness/model badge from the live RPCs. Called on boot and after saveSettings — see this section's header comment for why no other trigger exists. */
  refreshHarnessBadge(): Promise<void>;
  /** Drain Tauri's pending-opens queue and route each path (boot drain + open-pending event handler). */
  drainExternalOpens(): Promise<void>;
}

/** IO surface for routing an OS-delivered or dialog-picked document path. */
export interface ExternalOpenIo {
  importHadz(p: { hadzPath: string }): Promise<{ docPath: string }>;
  openInTab(path: string): Promise<void>;
  log(line: string): void;
  reportError(scope: string, e: unknown): void;
}

/** `.hadz` bundles import first, everything else opens directly (spec §3). */
export async function routeExternalPath(path: string, io: ExternalOpenIo): Promise<void> {
  if (path.toLowerCase().endsWith(".hadz")) {
    try {
      const r = await io.importHadz({ hadzPath: path });
      io.log(`imported ${path}`);
      await io.openInTab(r.docPath);
    } catch (e) {
      io.reportError("import .hadz", e);
    }
    return;
  }
  await io.openInTab(path);
}

/** Formats accepted from OS open events; everything else is logged and skipped (spec §4). */
export function filterOpenablePaths(paths: string[], log: (line: string) => void): string[] {
  return paths.filter((p) => {
    const ok = /\.(md|markdown|html|htm|hadz)$/i.test(p);
    if (!ok) log(`ignoring unsupported file from OS open: ${p}`);
    return ok;
  });
}

export function initShell(deps: ShellDeps): ShellApi {
  // --- document actions, driven by the native File menu (see src-tauri menu) ---
  async function doSave(): Promise<void> {
    if (activeIdx < 0) return void deps.log("save: no doc open");
    // For HTML, the editable content lives in the iframe DOM — serialize it back.
    const tab = tabs[activeIdx];
    const currentText = tab.format === "html" ? deps.getHtmlSurface()?.getHtml() ?? "" : tab.markdown;
    const sel = await openVersionPicker("Save selected");
    if (!sel) return void deps.log("save canceled");
    try {
      if (sel === "current") {
        const r = await deps.api.saveDoc({ text: currentText });
        // Mirrors the pre-refactor `onSavedCurrent` update after an HTML save.
        if (activeIdx >= 0 && tabs[activeIdx].format === "html") {
          tabs[activeIdx].markdown = currentText;
          tabs[activeIdx].dirty = false;
        }
        deps.log(`saved ✅ (snapshot ${r.version})`);
      } else {
        await deps.api.restoreVersion({ versionId: sel });
        await reloadActiveDoc();
        deps.log(`restored ${sel} as current ✅`);
      }
    } catch (e) {
      deps.log(`save FAILED: ${String(e)}`);
    }
  }

  async function doExport(): Promise<void> {
    if (activeIdx < 0) return void deps.log("export: no doc open");
    const sel = await openVersionPicker("Export selected");
    if (!sel) return void deps.log("export canceled");
    const base = (tabs[activeIdx].docPath.split("/").pop() ?? "document").replace(/\.[^.]+$/, "");
    let outPath: string | null;
    try {
      outPath = await save({
        title: "Export .hadz bundle",
        defaultPath: `${base}.hadz`,
        filters: [{ name: "HAD bundle", extensions: ["hadz"] }],
      });
    } catch (e) {
      return void reportError("export dialog", e, deps.log);
    }
    if (!outPath) return void deps.log("export canceled");
    try {
      const params: { outPath: string; versionId?: string } = { outPath };
      if (sel !== "current") params.versionId = sel;
      const r = await deps.api.exportHadz(params);
      deps.log(`exported ✅ → ${r.path}`);
    } catch (e) {
      deps.log(`export FAILED: ${String(e)}`);
    }
  }

  async function doOpen(): Promise<void> {
    let picked: string | string[] | null;
    try {
      picked = await open({
        title: "Open a document",
        multiple: false,
        filters: [
          { name: "Documents", extensions: ["md", "markdown", "html", "htm", "hadz"] },
        ],
      });
    } catch (e) {
      return void reportError("open dialog", e, deps.log);
    }
    const path = Array.isArray(picked) ? picked[0] : picked;
    if (!path) return void deps.log("open canceled");
    await routeExternalPath(path, externalOpenIo);
  }

  const externalOpenIo: ExternalOpenIo = {
    importHadz: (p) => deps.api.importHadz(p),
    openInTab,
    log: deps.log,
    reportError: (scope, e) => reportError(scope, e, deps.log),
  };

  async function takePendingOpens(): Promise<string[]> {
    const tauri = (window as { __TAURI__?: { core?: { invoke?: (cmd: string) => Promise<unknown> } } }).__TAURI__;
    if (!tauri?.core?.invoke) return []; // plain-Vite dev: no-op
    try {
      return ((await tauri.core.invoke("take_pending_opens")) as string[]) ?? [];
    } catch (e) {
      deps.log(`take_pending_opens failed: ${String(e)}`);
      return [];
    }
  }

  async function drainExternalOpens(): Promise<void> {
    // Editor still mounting: leave paths queued — the boot drain runs after
    // mount and collects them. Draining now would hand them to openInTab's
    // silent not-ready return and lose them forever (drain is exactly-once).
    if (!deps.getEditor()) return;
    for (const path of filterOpenablePaths(await takePendingOpens(), deps.log)) {
      await routeExternalPath(path, externalOpenIo);
    }
  }

  function wireMenu(): void {
    // File-menu clicks (and their accelerators ⌘O / ⌘S / ⇧⌘E / ⌘W) arrive as events.
    void listen<string>("menu-action", (e) => {
      if (e.payload === "open") void doOpen();
      else if (e.payload === "save") void doSave();
      else if (e.payload === "export") void doExport();
      else if (e.payload === "close") void closeTab(activeIdx);
      else if (e.payload === "settings") void openSettings();
      else if (e.payload === "reload") void reloadActiveDoc();
      else if (e.payload === "shortcuts") openShortcuts();
      else if (e.payload === "resolve-directives") void deps.runResolveDirectives();
    });
    // OS-delivered file opens: the Rust shell stashes paths in a drain
    // queue and signals; collecting via the drain makes duplicates
    // impossible (cold-launch paths are collected by the boot drain).
    void listen("open-pending", () => void drainExternalOpens());
  }

  // --- topbar: sidebar toggles (Phase 11 T1) ---
  // Two independent panes can be hidden to give the document canvas more room:
  // the left "Agent discussion" pane (.chatpane) and the right "Review rail"
  // (.panel). Collapsing sets `display: none` on the pane via a `.collapsed`
  // class — `.doc`'s `flex: 1` (see styles.css's `.layout`) then fills the
  // freed space with no other layout math needed. State persists per-app (not
  // per-doc), so the chrome preference survives switching documents and
  // restarting.
  //
  // NO magic auto-open beyond the two exceptions the plan calls out by name:
  // opening a conversation (chat.ts's activateChatPane/openThreadById, via
  // `uncollapseLeftPane`) un-collapses the left pane; creating an annotation
  // via the selection popover's Comment button (surface.ts, via
  // `uncollapseRightRail`) un-collapses the right rail. Nothing else — closing
  // a pane stays closed across every other flow (tab switches, agent replies,
  // proposals, etc).
  const chatPaneEl = document.querySelector<HTMLElement>(".chatpane")!;
  const panelEl = document.querySelector<HTMLElement>(".panel")!;
  const toggleLeftBtn = document.querySelector<HTMLButtonElement>("#toggleLeftBtn")!;
  const toggleRightBtn = document.querySelector<HTMLButtonElement>("#toggleRightBtn")!;
  const SIDEBAR_STATE_KEY = "docuzen:sidebars:v1";

  interface SidebarState {
    left: boolean; // true = collapsed
    right: boolean;
  }

  function loadSidebarState(): SidebarState {
    try {
      const raw = localStorage.getItem(SIDEBAR_STATE_KEY);
      if (!raw) return { left: false, right: false };
      const parsed = JSON.parse(raw) as Partial<SidebarState>;
      return { left: parsed.left === true, right: parsed.right === true };
    } catch {
      return { left: false, right: false };
    }
  }

  const sidebarState = loadSidebarState();

  function saveSidebarState(): void {
    try {
      localStorage.setItem(SIDEBAR_STATE_KEY, JSON.stringify(sidebarState));
    } catch {
      // Storage can be unavailable in unusual webview modes; failing to persist is non-fatal.
    }
  }

  function applySidebarState(): void {
    chatPaneEl.classList.toggle("collapsed", sidebarState.left);
    panelEl.classList.toggle("collapsed", sidebarState.right);
    toggleLeftBtn.classList.toggle("collapsed", sidebarState.left);
    toggleRightBtn.classList.toggle("collapsed", sidebarState.right);
    toggleLeftBtn.title = `${sidebarState.left ? "Show" : "Hide"} Agent discussion pane (⌘⇧L)`;
    toggleRightBtn.title = `${sidebarState.right ? "Show" : "Hide"} Review rail (⌘⇧R)`;
    toggleLeftBtn.setAttribute("aria-pressed", String(sidebarState.left));
    toggleRightBtn.setAttribute("aria-pressed", String(sidebarState.right));
  }
  applySidebarState(); // apply the restored (or default) state before first paint

  function toggleLeftPane(): void {
    sidebarState.left = !sidebarState.left;
    applySidebarState();
    saveSidebarState();
  }
  function toggleRightPane(): void {
    sidebarState.right = !sidebarState.right;
    applySidebarState();
    saveSidebarState();
  }
  /** Exception 1 (see section header) — no-op if the pane is already visible. */
  function uncollapseLeftPane(): void {
    if (!sidebarState.left) return;
    sidebarState.left = false;
    applySidebarState();
    saveSidebarState();
  }
  /** Exception 2 (see section header) — no-op if the pane is already visible. */
  function uncollapseRightRail(): void {
    if (!sidebarState.right) return;
    sidebarState.right = false;
    applySidebarState();
    saveSidebarState();
  }
  toggleLeftBtn.addEventListener("click", toggleLeftPane);
  toggleRightBtn.addEventListener("click", toggleRightPane);
  // ⌘⇧L / ⌘⇧R — checked against the shortcuts modal + src-tauri's native menu
  // accelerators (⌘O, ⌘S, ⌘⇧E, ⌘W, ⌘,, ⌘⇧D, ⌘R, ⌘⇧H): neither combo collides,
  // in either place. Same "(meta||ctrl)+shift+key" shape as chat.ts's ⌘⇧D resolve
  // shortcut, capture phase so it fires regardless of what has focus.
  window.addEventListener(
    "keydown",
    (e) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === "l" || e.key === "L")) {
        e.preventDefault();
        toggleLeftPane();
      } else if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === "r" || e.key === "R")) {
        e.preventDefault();
        toggleRightPane();
      }
    },
    true,
  );

  // --- Settings modal (per-doc tool scope, default model + model manager, stances) ---
  const settingsModal = document.querySelector<HTMLDivElement>("#settingsModal")!;
  const setHarnessEl = document.querySelector<HTMLSelectElement>("#setHarness")!;
  const harnessCapsEl = document.querySelector<HTMLDivElement>("#harnessCaps")!;
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
    if (!setHarnessEl.value && harnesses.length) setHarnessEl.value = harnesses[0].id;
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

  /** Show the add/edit form. `existing` → Edit mode (key left blank = keep); omitted → empty Add. */
  function showModelForm(existing?: ModelConfig): void {
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
    // Merge: replace the same-key entry (Edit) or append (Add). Unchanged rows are
    // sent WITHOUT apiKey so saveModels preserves their stored keys.
    const idx = configuredModels.findIndex((m) => m.key === edited.key);
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
    if (!window.confirm(`Remove model ${key}?`)) return;
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

  async function openSettings(): Promise<void> {
    if (activeIdx < 0) return void deps.log("settings: open a document first");
    hideModelForm();
    try {
      const s = await deps.api.getSettings({});
      setScopeEl.value = s.scope ?? "folder";
      await refreshHarnesses(s.harness ?? "pi");
      setAgentEditEl.value = s.agentEdit ?? "propose";
      setInstructionsEl.value = s.instructions ?? "";
      setWebSearchEl.checked = s.webSearch?.enabled !== false;
      setWebProviderEl.value = s.webSearch?.provider ?? "ddg";
      await refreshModels();
      setDefaultModelEl.value = s.model ?? "";
      syncHarnessManagedControls();
    } catch (e) {
      reportError("settings load", e, deps.log);
    }
    settingsModal.hidden = false;
  }
  // Settings opens from the native File menu (⌘,) — see the menu-action listener.
  async function saveSettings(): Promise<void> {
    if (activeIdx < 0) return;
    const harness = selectedHarnessInfo();
    const harnessManagedModels = !!harness && harness.id !== "pi" && harness.id !== "codex";
    const model = harnessManagedModels ? undefined : setDefaultModelEl.value || undefined;
    deps.setDefaultModelKey(model ?? ""); // thread pickers default to the new per-doc model
    const instructions = setInstructionsEl.value.trim() || undefined;
    const webSearch = {
      enabled: setWebSearchEl.checked,
      provider: setWebProviderEl.value as "ddg" | "brave" | "tavily",
    };
    try {
      await deps.api.setSettings({
        settings: {
          scope: setScopeEl.value as HadSettings["scope"],
          harness: (setHarnessEl.value || "pi") as HadSettings["harness"],
          agentEdit: setAgentEditEl.value as HadSettings["agentEdit"],
          model,
          instructions,
          webSearch,
        },
      });
      deps.log(`settings saved (scope=${setScopeEl.value}, agentEdit=${setAgentEditEl.value}, model=${model ?? "default"})`);
      void refreshHarnessBadge(); // reflect the just-saved harness/model in the topbar chip
    } catch (e) {
      reportError("settings save", e, deps.log);
    }
  }
  setScopeEl.addEventListener("change", () => void saveSettings());
  setHarnessEl.addEventListener("change", () => {
    renderHarnessCaps(setHarnessEl.value);
    syncHarnessManagedControls();
    void saveSettings();
  });
  setAgentEditEl.addEventListener("change", () => void saveSettings());
  setDefaultModelEl.addEventListener("change", () => void saveSettings());
  setInstructionsEl.addEventListener("blur", () => void saveSettings());
  setWebSearchEl.addEventListener("change", () => void saveSettings());
  setWebProviderEl.addEventListener("change", () => void saveSettings());
  document.querySelector("#settingsClose")!.addEventListener("click", () => {
    settingsModal.hidden = true;
  });
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
    if (activeIdx >= 0) {
      try {
        settings = await deps.api.getSettings({});
      } catch (e) {
        reportError("badge settings load", e, deps.log);
      }
    }
    const harnessId = settings?.harness ?? "pi";
    renderHarnessBadge(list.find((h) => h.id === harnessId) ?? list[0], settings);
  }

  // --- Version preview modal (read-only doc-at-version + "Edit from here") ---
  const versionModal = document.querySelector<HTMLDivElement>("#versionModal")!;
  const versionModalTitle = document.querySelector<HTMLHeadingElement>("#versionModalTitle")!;
  const versionModalBody = document.querySelector<HTMLPreElement>("#versionModalBody")!;
  const versionEditBtn = document.querySelector<HTMLButtonElement>("#versionEditBtn")!;
  document.querySelector("#versionClose")!.addEventListener("click", () => {
    versionModal.hidden = true;
  });
  wireModal(versionModal); // click backdrop to close

  /**
   * Open the read-only version-preview modal for `versionId`. Fetches the full
   * version file via `readVersion`, strips its frontmatter, and shows the body in a
   * `<pre>` (via textContent — no innerHTML of version data). The footer's
   * "✎ Edit from here" loads that body into the current editor (revert-then-edit).
   */
  async function openVersionPreview(versionId: string): Promise<void> {
    if (activeIdx < 0) return;
    try {
      const { content } = await deps.api.readVersion({ versionId });
      const body = deps.stripFrontmatter(content);
      versionModalTitle.textContent = `📄 Document @ ${versionId}`;
      versionModalBody.textContent = body; // read-only, textContent (no XSS)
      versionEditBtn.onclick = () => void editFromVersion(versionId, body);
      versionModal.hidden = false;
    } catch (e) {
      deps.log(`preview ${versionId} failed: ${String(e)}`);
    }
  }

  /**
   * Load a previewed version's body into the CURRENT editor tab (revert-then-edit).
   * Replaces the working copy only — disk is untouched until the user Saves.
   * `activateTab` re-renders the editor and re-anchors annotations (orphans logged).
   */
  async function editFromVersion(versionId: string, body: string): Promise<void> {
    if (activeIdx < 0) return;
    versionModal.hidden = true;
    tabs[activeIdx].markdown = body; // replace the current working copy (not yet on disk)
    await activateTab(activeIdx); // re-renders editor + re-anchors annotations
    deps.log(`editing from ${versionId} — Save to keep it`);
  }

  // --- Version picker modal (Save → restore, Export → bundle a version) ---
  const versionPickerModal = document.querySelector<HTMLDivElement>("#versionPickerModal")!;
  const versionPickerList = document.querySelector<HTMLDivElement>("#versionPickerList")!;
  const versionPickerConfirm = document.querySelector<HTMLButtonElement>("#versionPickerConfirm")!;

  // Resolves to "current", a version id, or null (cancel). Only one picker open at a time.
  let versionPickerResolve: ((v: string | null) => void) | null = null;

  function pickerSection(title: string, hint?: string): HTMLDivElement {
    const section = document.createElement("div");
    section.className = "vpick-section";

    const header = document.createElement("div");
    header.className = "vpick-section-title";
    header.textContent = title;
    section.appendChild(header);

    if (hint) {
      const help = document.createElement("div");
      help.className = "vpick-section-hint";
      help.textContent = hint;
      section.appendChild(help);
    }

    return section;
  }

  function pickerRadio(value: string, checked = false): HTMLInputElement {
    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = "vpick";
    radio.value = value;
    radio.checked = checked;
    return radio;
  }

  function appendVersionCopy(
    parent: HTMLElement,
    version: VersionPickerVersion,
    title = version.id,
  ): void {
    const copy = document.createElement("span");
    copy.className = "vpick-copy";

    const line = document.createElement("span");
    line.className = "vpick-titleline";

    const id = document.createElement("span");
    id.className = "vpick-versionid";
    id.textContent = title;
    line.appendChild(id);

    const cause = document.createElement("span");
    cause.className = "vpick-cause";
    cause.textContent = version.cause;
    line.appendChild(cause);

    copy.appendChild(line);
    parent.appendChild(copy);
  }

  function threadRowMeta(row: VersionPickerGraphRow): string {
    const parts: string[] = [];
    if (row.title) parts.push(deps.truncTitle(row.title, 64));
    if (row.thread) parts.push(`thread ${row.thread}`);
    if (row.turnCount !== undefined) parts.push(`${row.turnCount} turn${row.turnCount === 1 ? "" : "s"}`);
    if (row.branchFromTurn !== undefined) parts.push(`fork after turn ${row.branchFromTurn + 1}`);
    if (row.baseDoc) parts.push(row.baseDoc === "at-turn" ? "anchored at turn" : "anchored to latest");
    if (row.status && row.status !== "open") parts.push(row.status);
    if (row.baseVersion) parts.push(`based on ${row.baseVersion.id}`);
    else if (row.missingBaseVersion) parts.push(`based on missing ${row.missingBaseVersion}`);
    if (row.branchTargets.length) {
      const branches = row.branchTargets
        .map((target) => {
          const turn = target.branchFromTurn !== undefined ? ` after turn ${target.branchFromTurn + 1}` : "";
          return `${deps.truncTitle(target.title, 28)}${turn}`;
        })
        .join(", ");
      parts.push(`branches: ${branches}`);
    }
    return parts.join(" · ");
  }

  function appendRevisionGraphCell(parent: HTMLElement, cell: VersionPickerGraphCell): void {
    const lane = document.createElement("span");
    lane.className = "vpick-lane";
    if (cell.hasLine) lane.classList.add("line");
    if (cell.hasHorizontal) lane.classList.add("hline");
    if (cell.hasNode) lane.classList.add("node");
    if (cell.branchToLanes.length > 0) lane.classList.add("fork");
    if (cell.incomingFromLane !== undefined) lane.classList.add("incoming");
    lane.dataset.lane = String(cell.lane + 1);
    if (cell.branchToLanes.length > 0) {
      lane.title = `Branches to lane${cell.branchToLanes.length === 1 ? "" : "s"} ${cell.branchToLanes
        .map((targetLane) => targetLane + 1)
        .join(", ")}`;
    } else if (cell.incomingFromLane !== undefined) {
      lane.title = `Forked from lane ${cell.incomingFromLane + 1}`;
    }
    lane.appendChild(document.createElement("span")).className = "vpick-line-v";
    lane.appendChild(document.createElement("span")).className = "vpick-line-h";
    lane.appendChild(document.createElement("span")).className = "vpick-dot";
    parent.appendChild(lane);
  }

  function appendRevisionPickerRow(section: HTMLElement, row: VersionPickerGraphRow): void {
    const shell = document.createElement("label");
    shell.className = "vpick-row vpick-graph-row";
    shell.appendChild(pickerRadio(row.id));

    const graph = document.createElement("span");
    graph.className = "vpick-graph";
    graph.style.setProperty("--vpick-lanes", String(row.laneCount));
    graph.setAttribute("aria-hidden", "true");
    for (const cell of row.graphCells) appendRevisionGraphCell(graph, cell);
    shell.appendChild(graph);

    const copy = document.createElement("span");
    copy.className = "vpick-copy";

    const titleLine = document.createElement("span");
    titleLine.className = "vpick-titleline";

    const title = document.createElement("span");
    title.className = "vpick-versionid";
    title.textContent = row.version.id;
    titleLine.appendChild(title);

    const cause = document.createElement("span");
    cause.className = "vpick-cause";
    cause.textContent = row.version.cause;
    titleLine.appendChild(cause);

    copy.appendChild(titleLine);

    const meta = document.createElement("span");
    meta.className = "vpick-meta";
    meta.textContent = threadRowMeta(row);
    if (meta.textContent) copy.appendChild(meta);

    shell.appendChild(copy);
    section.appendChild(shell);
  }

  function appendTimelinePickerRow(section: HTMLElement, version: VersionPickerVersion): void {
    const row = document.createElement("label");
    row.className = "vpick-row";
    row.appendChild(pickerRadio(version.id));
    appendVersionCopy(row, version);
    section.appendChild(row);
  }

  function renderVersionPicker(versions: VersionPickerVersion[]): void {
    versionPickerList.replaceChildren();

    const current = pickerSection("Current");
    const currentRow = document.createElement("label");
    currentRow.className = "vpick-row vpick-current";
    currentRow.appendChild(pickerRadio("current", true));
    appendVersionCopy(currentRow, { id: "Current working copy", cause: "unsaved editor contents" });
    current.appendChild(currentRow);
    versionPickerList.appendChild(current);

    const model = buildVersionPickerModel(versions, deps.getThreadNodes());
    if (model.graphRows.length > 0) {
      const revisions = pickerSection(
        "Revisions",
        "Newest first. Every saved revision is selectable; lanes and connectors show inferred branch divergence where available.",
      );
      for (const row of model.graphRows) appendRevisionPickerRow(revisions, row);
      versionPickerList.appendChild(revisions);
    }

    if (model.unthreadedVersions.length > 0) {
      const timeline = pickerSection("Other versions", "Newest first; these snapshots are not pinned to a branch row above.");
      for (const row of model.unthreadedVersions) appendTimelinePickerRow(timeline, row.version);
      versionPickerList.appendChild(timeline);
    }
  }

  async function openVersionPicker(confirmLabel: string): Promise<string | null> {
    if (activeIdx < 0) return null;
    let versions: VersionPickerVersion[] = [];
    try {
      versions = await deps.api.listVersions({});
    } catch (e) {
      reportError("versions", e, deps.log);
      return null;
    }
    await deps.refreshThreadTree();
    renderVersionPicker(versions);
    versionPickerConfirm.textContent = confirmLabel;
    versionPickerModal.hidden = false;
    return new Promise((resolve) => {
      versionPickerResolve = resolve;
    });
  }
  function closeVersionPicker(result: string | null): void {
    versionPickerModal.hidden = true;
    const r = versionPickerResolve;
    versionPickerResolve = null;
    r?.(result);
  }
  versionPickerConfirm.addEventListener("click", () => {
    const sel =
      versionPickerList.querySelector<HTMLInputElement>('input[name="vpick"]:checked')?.value ??
      "current";
    closeVersionPicker(sel);
  });
  document
    .querySelector("#versionPickerCancel")!
    .addEventListener("click", () => closeVersionPicker(null));
  versionPickerModal.addEventListener("click", (e) => {
    if (e.target === versionPickerModal) closeVersionPicker(null);
  });

  // --- Keyboard shortcuts modal ---
  const shortcutsModal = document.querySelector<HTMLDivElement>("#shortcutsModal")!;
  function openShortcuts(): void {
    shortcutsModal.hidden = false;
  }
  document.querySelector("#shortcutsClose")!.addEventListener("click", () => {
    shortcutsModal.hidden = true;
  });
  wireModal(shortcutsModal);

  // --- tabs: one editor, many documents; content swaps on activation ---
  // Task 5 wave-2 move — see file header's OWNERSHIP FLIP note. `tabs`/`activeIdx`
  // are now the ONLY record of "what document is active"; main.ts's old
  // `DOC_PATH`/`currentFormat` globals are gone.
  interface Tab {
    docPath: string;
    name: string;
    format: "markdown" | "html";
    markdown: string; // live content (markdown body, or raw HTML for html tabs)
    dirty?: boolean; // html tabs: unsaved edits live in the iframe DOM until captured
  }
  const tabs: Tab[] = [];
  let activeIdx = -1;
  let activationSeq = 0;
  const tabsEl = document.querySelector<HTMLDivElement>("#tabs")!;
  const docEl = document.querySelector<HTMLElement>(".doc")!;
  const { setDocPath, clearDocPath } = initDocPath({ log: deps.log });
  const TAB_SESSION_KEY = "docuzen:tabs:v1";

  /** Native window title mirrors the active document (empty state: just the
   * product name). The in-app topbar no longer shows a separate filename
   * subtitle — the tab strip is the one place that names the active doc — so
   * this is the only remaining "docname" surface, and it lives on the OS
   * window chrome instead of duplicating the tab strip in-app.
   *
   * Tauri v2 does NOT sync `document.title` to the native title bar
   * automatically (confirmed against the window-customization docs/tauri
   * upstream issues — the static `windows[0].title` in tauri.conf.json only
   * sets the title at window creation); `getCurrentWindow().setTitle()` is
   * required. `document.title` is still assigned unconditionally so plain-
   * browser dev mode (`vite dev` without `tauri dev`) and this module's tests
   * keep working without a Tauri runtime. `getCurrentWindow()` reads
   * `window.__TAURI_INTERNALS__` synchronously, which doesn't exist outside a
   * real Tauri webview, so it's gated behind that check rather than a
   * try/catch around the call itself. */
  function setWindowTitle(title: string): void {
    document.title = title;
    if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
      void getCurrentWindow()
        .setTitle(title)
        .catch(() => {
          // Best-effort: a failed native title sync should never block tab activation.
        });
    }
  }

  interface SavedTab {
    docPath: string;
    name?: string;
    format?: "markdown" | "html";
  }

  interface TabSession {
    tabs: SavedTab[];
    activeIdx: number;
  }

  function loadTabSession(): TabSession | null {
    try {
      const raw = localStorage.getItem(TAB_SESSION_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as Partial<TabSession>;
      if (!Array.isArray(parsed.tabs)) return null;
      const seen = new Set<string>();
      const savedTabs: SavedTab[] = [];
      for (const t of parsed.tabs) {
        if (!t || typeof t.docPath !== "string" || !t.docPath || seen.has(t.docPath)) continue;
        seen.add(t.docPath);
        savedTabs.push({
          docPath: t.docPath,
          name: typeof t.name === "string" ? t.name : undefined,
          format: t.format === "html" ? "html" : t.format === "markdown" ? "markdown" : undefined,
        });
      }
      if (!savedTabs.length) return null;
      const requestedIdx = Number.isInteger(parsed.activeIdx) ? parsed.activeIdx! : 0;
      return {
        tabs: savedTabs,
        activeIdx: Math.max(0, Math.min(requestedIdx, savedTabs.length - 1)),
      };
    } catch {
      return null;
    }
  }

  function saveTabSession(): void {
    try {
      if (!tabs.length) {
        localStorage.removeItem(TAB_SESSION_KEY);
        return;
      }
      const session: TabSession = {
        activeIdx: Math.max(0, Math.min(activeIdx, tabs.length - 1)),
        tabs: tabs.map((t) => ({ docPath: t.docPath, name: t.name, format: t.format })),
      };
      localStorage.setItem(TAB_SESSION_KEY, JSON.stringify(session));
    } catch {
      // Storage can be unavailable in unusual webview modes; failing to persist is non-fatal.
    }
  }
  window.addEventListener("beforeunload", saveTabSession);

  function isCurrentActivation(seq: number, idx: number, docPath: string): boolean {
    return seq === activationSeq && activeIdx === idx && tabs[activeIdx]?.docPath === docPath;
  }

  function renderTabBar(): void {
    tabsEl.innerHTML = "";
    tabs.forEach((tab, i) => {
      const row = document.createElement("div");
      row.className = `tab${i === activeIdx ? " active" : ""}`;
      row.innerHTML = `<span class="tname">${tab.name}</span><button class="tclose" title="Close">×</button>`;
      row.querySelector(".tname")!.addEventListener("click", () => void activateTab(i));
      row.querySelector(".tclose")!.addEventListener("click", (ev) => {
        ev.stopPropagation();
        void closeTab(i);
      });
      tabsEl.appendChild(row);
    });
  }

  function resetDocumentViewport(): void {
    docEl.scrollTop = 0;
    deps.rootEl.scrollTop = 0;
    requestAnimationFrame(() => {
      docEl.scrollTop = 0;
      deps.rootEl.scrollTop = 0;
    });
  }

  /** Persist the active html tab's in-iframe edits back into its tab before switching. */
  function captureActiveHtmlEdits(): void {
    if (activeIdx < 0) return;
    const tab = tabs[activeIdx];
    if (tab?.format !== "html") return;
    const html = deps.getHtmlSurface()?.getHtml();
    if (html) tab.markdown = html;
  }

  // Document content is stored verbatim per tab: markdown bodies feed Milkdown; HTML
  // is rendered faithfully in the iframe surface (no lossy markdown conversion).
  function tabContent(text: string, _format: string): string {
    return text;
  }

  function showEmptyState(): void {
    activeIdx = -1;
    clearDocPath();
    deps.clearSearchHighlights();
    deps.setEditToggleVisible(false);
    deps.showMarkdownSurface();
    setWindowTitle("docuzen");
    deps.resetChat(); // clears the comment registry, chat pane, AND the #comments margin list
    deps.getEditor()?.action(replaceAll("# No document open\n\nUse File → Open (⌘O).\n"));
    deps.getEditor()?.action((ctx) => {
      const view: EditorView = ctx.get(editorViewCtx);
      view.dispatch(view.state.tr.setMeta(deps.annoKey, "clear"));
      view.dispatch(view.state.tr.setMeta(deps.proposalKey, "clear"));
    });
    renderTabBar();
    saveTabSession();
  }

  async function activateTab(idx: number): Promise<void> {
    if (idx < 0 || idx >= tabs.length || !deps.getEditor()) return;
    captureActiveHtmlEdits(); // persist outgoing html tab edits before switching
    deps.clearAnnotationUndo(); // annotation-undo doesn't carry across document switches
    deps.clearSearchHighlights(); // search overlays are per rendered document, not persisted tab state
    const seq = ++activationSeq;
    activeIdx = idx;
    const tab = tabs[idx];
    deps.notifySessionActive(tab.docPath, tab.format); // keeps the store's view/listeners in sync
    setWindowTitle(`${tab.name} — docuzen`);
    setDocPath(tab.docPath);
    deps.resetChat(); // clears the comment registry, chat pane, AND the #comments margin list
    if (tab.format === "html") {
      deps.showHtmlSurface();
      deps.setEditToggleVisible(true);
      deps.setHtmlEditMode(false); // open HTML docs in review mode so links/clicks work
      deps.getHtmlSurface()?.load(tab.markdown, baseHrefForDoc(tab.docPath));
    } else {
      deps.setEditToggleVisible(false);
      deps.showMarkdownSurface();
      const editor = deps.getEditor()!;
      editor.action(replaceAll(tab.markdown));
      editor.action((ctx) => {
        const view: EditorView = ctx.get(editorViewCtx);
        view.dispatch(view.state.tr.setMeta(deps.annoKey, "clear"));
        view.dispatch(view.state.tr.setMeta(deps.proposalKey, "clear"));
        view.dispatch(view.state.tr.setMeta(deps.searchKey, "clear"));
      });
      if (deps.searchIsOpen() && deps.searchState.query.trim()) deps.refreshMarkdownSearch(false, false);
    }
    renderTabBar();
    saveTabSession();
    // Read this doc's default model BEFORE rendering cards so their pickers default
    // to it. Failure is non-fatal — defaultModelKey falls back to "" (sidecar default).
    const modelKey = await readDocDefaultModel(tab.docPath);
    if (!isCurrentActivation(seq, idx, tab.docPath)) return;
    deps.setDefaultModelKey(modelKey);
    // Phase 1: annotations/proposals render on the markdown surface only. The HTML
    // surface gets its own annotation layer in Phase 2; skip the editor-projection
    // path here so it doesn't run against the wrong surface.
    if (tab.format === "html") {
      resetDocumentViewport();
      return;
    }
    // annotations persist on the backend; re-fetch + render for the active doc
    try {
      const opened = await deps.api.openDoc({ docPath: tab.docPath });
      if (!isCurrentActivation(seq, idx, tab.docPath)) return;
      if (opened.annotations.length) deps.renderLoaded(opened.annotations);
    } catch (e) {
      if (!isCurrentActivation(seq, idx, tab.docPath)) return;
      reportError("load annotations", e, deps.log);
    }
    // Re-render any pending proposals as inline diffs (approved/rejected excluded).
    // Hunks carry their own `oldText`, so renderProposal re-locates them — no anchor
    // recovery needed. Full rewrites route to the chat note (panel is the next task).
    try {
      const props = await deps.api.listProposals({ docPath: tab.docPath });
      if (!isCurrentActivation(seq, idx, tab.docPath)) return;
      for (const p of props) {
        if (p.status !== "pending") continue;
        if (p.fullText !== undefined) {
          // Don't auto-pop the modal on load — leave a clickable affordance instead.
          const pv: ProposalView = {
            id: p.id,
            threadId: p.threadId,
            rationale: p.rationale,
            edits: p.edits,
            fullText: p.fullText,
            status: p.status,
          };
          deps.chatTurnWithAction("✦ pending full rewrite —", () => void deps.openDiffPanel(pv));
          continue;
        }
        if (!p.edits) continue; // legacy single-region proposal (rare) — skip, don't crash
        deps.renderProposal({
          id: p.id,
          threadId: p.threadId,
          rationale: p.rationale,
          edits: p.edits,
          status: p.status,
        });
      }
    } catch (e) {
      if (!isCurrentActivation(seq, idx, tab.docPath)) return;
      reportError("load proposals", e, deps.log);
    }
    resetDocumentViewport();
  }

  /** Read the per-doc default model key from getSettings().model. */
  async function readDocDefaultModel(docPath: string): Promise<string> {
    try {
      const s = await deps.api.getSettings({ docPath });
      return s.model ?? "";
    } catch {
      return "";
    }
  }

  /** Open a document in a tab (activating an existing tab if already open). */
  async function openInTab(path: string): Promise<void> {
    if (!deps.getEditor()) return;
    const existing = tabs.findIndex((t) => t.docPath === path);
    if (existing >= 0) return void activateTab(existing);
    try {
      const opened = await deps.api.openDoc({ docPath: path });
      const format = opened.format === "html" ? "html" : "markdown";
      tabs.push({
        docPath: path,
        name: path.split("/").pop() ?? path,
        format,
        markdown: tabContent(opened.text, format),
      });
      deps.log(`opened ${path}`);
      await activateTab(tabs.length - 1);
      saveTabSession();
    } catch (e) {
      reportError("open", e, deps.log);
    }
  }

  async function closeTab(idx: number): Promise<void> {
    if (idx < 0 || idx >= tabs.length) return;
    const [closed] = tabs.splice(idx, 1);
    deps.log(`closed ${closed.name}`);
    if (tabs.length === 0) {
      saveTabSession();
      return void showEmptyState();
    }
    await activateTab(Math.min(idx, tabs.length - 1));
    saveTabSession();
  }

  async function restoreTabSession(): Promise<boolean> {
    const session = loadTabSession();
    if (!session) return false;
    const activeDocPath = session.tabs[session.activeIdx]?.docPath;
    for (const tab of session.tabs) {
      await openInTab(tab.docPath);
    }
    if (!tabs.length) {
      saveTabSession();
      return false;
    }
    const restoredActiveIdx = activeDocPath ? tabs.findIndex((t) => t.docPath === activeDocPath) : -1;
    await activateTab(restoredActiveIdx >= 0 ? restoredActiveIdx : Math.min(session.activeIdx, tabs.length - 1));
    saveTabSession();
    return true;
  }

  /** Re-fetch the active doc from disk and re-render (after an applied edit). */
  async function reloadActiveDoc(): Promise<void> {
    if (activeIdx < 0) return;
    const idx = activeIdx;
    const tab = tabs[idx];
    if (!tab) return;
    const docPath = tab.docPath;
    try {
      const opened = await deps.api.openDoc({ docPath });
      if (activeIdx !== idx || tabs[idx]?.docPath !== docPath) return;
      const format = opened.format === "html" ? "html" : "markdown";
      tabs[idx].format = format;
      tabs[idx].markdown = tabContent(opened.text, format);
      tabs[idx].dirty = false;
      await activateTab(idx);
      saveTabSession();
    } catch (e) {
      reportError("reload", e, deps.log);
    }
  }

  function getDocPath(): string | undefined {
    return tabs[activeIdx]?.docPath;
  }
  function getFormat(): "markdown" | "html" {
    return tabs[activeIdx]?.format ?? "markdown";
  }
  function getCurrentMarkdown(): string {
    return tabs[activeIdx]?.markdown ?? "";
  }
  function setActiveTabMarkdown(markdown: string): void {
    if (activeIdx >= 0) tabs[activeIdx].markdown = markdown;
  }
  function markActiveHtmlTabDirty(): void {
    if (activeIdx >= 0 && tabs[activeIdx].format === "html") tabs[activeIdx].dirty = true;
  }
  function clearActiveTabDirty(): void {
    if (activeIdx >= 0) tabs[activeIdx].dirty = false;
  }

  return {
    openVersionPreview,
    wireMenu,
    versionModal,
    activateTab,
    openInTab,
    closeTab,
    restoreTabSession,
    showEmptyState,
    reloadActiveDoc,
    getTabCount: () => tabs.length,
    getDocPath,
    getFormat,
    getCurrentMarkdown,
    setActiveTabMarkdown,
    markActiveHtmlTabDirty,
    clearActiveTabDirty,
    uncollapseLeftPane,
    uncollapseRightRail,
    refreshHarnessBadge,
    drainExternalOpens,
  };
}
