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
import { getMarkdown, replaceAll } from "@milkdown/kit/utils";
import type { EditorView } from "@milkdown/kit/prose/view";
import type { PluginKey } from "@milkdown/kit/prose/state";
import { save, open } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { Annotation, EditHunk, RpcResult } from "@ai-native-doc/docd/protocol";
import { baseHrefForDoc, type HtmlSurface } from "./html-surface.js";
import { wireModal, reportError } from "./ui.js";
import type { DocdApi } from "./session.js";
import type { ThreadNode } from "@ai-native-doc/docd/protocol";
import { initDocPath } from "./status-path.js";
import { initSettings } from "./shell-settings.js";
import { initVersions } from "./shell-versions.js";
import { activeIndexAfterClose } from "./tab-model.js";
import { LOST_CONNECTION_MESSAGE } from "./rpc.js";

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
  setHarnessContext: (id: string | undefined, list: RpcResult<"listHarnesses">) => void;
  getThreadNodes: () => ThreadNode[];
  refreshThreadTree: () => Promise<void>;
  truncTitle: (s: string, max?: number) => string;

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

  // doc-images.ts
  /** Store images picked from disk and insert them at the caret. */
  addImagePaths: (paths: string[]) => Promise<void>;
  /** Whether the active document can take an image now (tells the user why when it cannot). */
  canInsertImage: () => boolean;

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
  /** The active tab's text as the user sees it now (read from the editor/iframe, not a debounced copy). */
  getCurrentMarkdown(): string;
  /** Milkdown's markdownUpdated listener (debounced 200 ms): keeps the active markdown tab's stored text current. */
  onEditorMarkdownUpdated(markdown: string, prev: string): void;
  /** An edit landed in the active HTML tab's iframe without an input event (an inserted image). No-op unless the active tab is HTML. */
  markActiveHtmlTabDirty(): void;
  /** Save the active document's current text, so a document-wide agent pass reads what the user sees. */
  syncActiveDocToDisk(): Promise<void>;

  // --- sidebar toggles + harness badge (Phase 11 T1) ---
  /** Exception: opening a conversation always un-collapses the left pane. No-op if already visible. */
  uncollapseLeftPane(): void;
  /** Exception: creating an annotation via the popover's Comment button always un-collapses the right rail. No-op if already visible. */
  uncollapseRightRail(): void;
  /** Refresh the harness/model badge from the live RPCs. Called on boot and after saveSettings — see this section's header comment for why no other trigger exists. */
  refreshHarnessBadge(): Promise<void>;
  /**
   * Drain Tauri's pending-opens queue and route each path. The open-pending event handler is a
   * no-op until main.ts's boot drain (`{ boot: true }`, right after session restore) has run.
   */
  drainExternalOpens(opts?: { boot?: boolean }): Promise<void>;
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

/** Path for a new document: markdown unless the chosen name is already .md/.markdown/.html/.htm. */
export function newDocPath(picked: string): string {
  return /\.(md|markdown|html|htm)$/i.test(picked) ? picked : `${picked}.md`;
}

export function initShell(deps: ShellDeps): ShellApi {
  // --- document actions, driven by the native File menu (see src-tauri menu) ---
  // Save and Export are pinned to the document they started on: every RPC names it explicitly
  // (never "whatever is active by the time this await returns"), and the version picker closes
  // when the active document changes (closeDocModals), which cancels the action.
  async function doSave(): Promise<void> {
    const tab = tabs[activeIdx];
    if (!tab) return void deps.log("save: no doc open");
    const docPath = tab.docPath;
    const sel = await openVersionPicker("Save selected");
    if (!sel) return void deps.log("save canceled");
    if (tabs[activeIdx] !== tab) return void deps.log("save canceled — another document is active");
    try {
      if (sel === "current") {
        captureActiveEdits(); // the editor/iframe as it is now, not the 200 ms-late listener's copy
        const r = await deps.api.saveDoc({ docPath, text: tab.markdown });
        deps.log(`saved ✅ (snapshot ${r.version})`);
      } else {
        await deps.api.restoreVersion({ docPath, versionId: sel });
        await reloadTab(tab);
        deps.log(`restored ${sel} as current ✅`);
      }
    } catch (e) {
      deps.log(`save FAILED: ${String(e)}`);
    }
  }

  async function doExport(): Promise<void> {
    const tab = tabs[activeIdx];
    if (!tab) return void deps.log("export: no doc open");
    const docPath = tab.docPath;
    // A bundle zips the file on disk, so exporting the working copy saves it first (the sidecar
    // keeps no new version when nothing changed). Saving rather than passing the text keeps
    // the bundle's document and its .had history (versions, anchors) describing the same file.
    const sel = await openVersionPicker("Export selected", "editor contents — saved, then exported");
    if (!sel) return void deps.log("export canceled");
    if (tabs[activeIdx] !== tab) return void deps.log("export canceled — another document is active");
    if (sel === "current") captureActiveEdits(); // while this tab's surface still shows it
    const text = tab.markdown;
    const base = (docPath.split("/").pop() ?? "document").replace(/\.[^.]+$/, "");
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
      const params: { docPath: string; outPath: string; versionId?: string } = { docPath, outPath };
      if (sel === "current") await deps.api.saveDoc({ docPath, text });
      else params.versionId = sel;
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

  /** File ▸ New Document: pick where it lives, create it (markdown unless named .html), open it. */
  async function doNew(): Promise<void> {
    let picked: string | null;
    try {
      picked = await save({
        title: "New document",
        defaultPath: "Untitled.md",
        filters: [
          { name: "Markdown", extensions: ["md"] },
          { name: "HTML", extensions: ["html"] },
        ],
      });
    } catch (e) {
      return void reportError("new document dialog", e, deps.log);
    }
    if (!picked) return void deps.log("new document canceled");
    const docPath = newDocPath(picked);
    try {
      await deps.api.createDoc({ docPath });
    } catch (e) {
      return void reportError("new document", e, deps.log);
    }
    deps.log(`created ${docPath}`);
    // Replacing a file that is already open: show the new content in its tab.
    const existing = tabs.findIndex((t) => t.docPath === docPath);
    if (existing >= 0) {
      await activateTab(existing);
      return void (await reloadActiveDoc());
    }
    await openInTab(docPath);
  }

  /** File ▸ Insert Image: the same result as dropping the files, placed at the caret. */
  async function doInsertImage(): Promise<void> {
    if (activeIdx < 0) return void deps.log("insert image: no doc open");
    if (!deps.canInsertImage()) return; // review mode: say so before opening a file picker
    let picked: string | string[] | null;
    try {
      picked = await open({
        title: "Insert image",
        multiple: true,
        filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp", "svg", "avif", "bmp"] }],
      });
    } catch (e) {
      return void reportError("insert image dialog", e, deps.log);
    }
    const paths = picked === null ? [] : Array.isArray(picked) ? picked : [picked];
    if (!paths.length) return void deps.log("insert image canceled");
    await deps.addImagePaths(paths);
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

  /** Set by main.ts's boot drain, which runs once the editor is mounted and the session restored. */
  let booted = false;

  async function drainExternalOpens(opts: { boot?: boolean } = {}): Promise<void> {
    if (opts.boot) booted = true;
    // Before the boot drain (editor still mounting, saved tabs still restoring): leave paths
    // queued — the boot drain collects them. Draining earlier would hand them to openInTab's
    // silent not-ready return and lose them forever (drain is exactly-once), or open them in
    // the middle of the restore, which then takes focus back to the saved active tab.
    if (!booted || !deps.getEditor()) return;
    for (const path of filterOpenablePaths(await takePendingOpens(), deps.log)) {
      await routeExternalPath(path, externalOpenIo);
    }
  }

  function wireMenu(): void {
    // File-menu clicks (and their accelerators ⌘O / ⌘S / ⇧⌘E / ⌘W) arrive as events.
    void listen<string>("menu-action", (e) => {
      if (e.payload === "open") void doOpen();
      else if (e.payload === "new") void doNew();
      else if (e.payload === "insert-image") void doInsertImage();
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

  // --- Settings modal, model manager, harness badge (shell-settings.ts) ---
  const { openSettings, closeSettings, refreshHarnessBadge } = initSettings({
    api: deps.api,
    log: deps.log,
    setDefaultModelKey: deps.setDefaultModelKey,
    setHarnessContext: deps.setHarnessContext,
    refreshThreadModels: deps.refreshThreadModels,
    modelName: deps.modelName,
    activeDocPath: () => tabs[activeIdx]?.docPath,
  });

  // --- Version preview + version picker modals (shell-versions.ts) ---
  const { openVersionPreview, openVersionPicker, closeVersionModals, versionModal } = initVersions({
    api: deps.api,
    log: deps.log,
    getThreadNodes: deps.getThreadNodes,
    refreshThreadTree: deps.refreshThreadTree,
    truncTitle: deps.truncTitle,
    activeDocPath: () => tabs[activeIdx]?.docPath,
    onEditFromVersion: (versionId, body, docPath) => editFromVersion(versionId, body, docPath),
  });

  /** Settings and the version modals describe one document: they close when another becomes active. */
  function closeDocModals(): void {
    closeSettings();
    closeVersionModals();
  }

  /**
   * Load a previewed version's body into its document's tab (revert-then-edit), if that
   * document is still the active one. Replaces the working copy only — disk is untouched
   * until the user Saves. `activateTab` re-renders and re-anchors annotations (orphans logged).
   */
  async function editFromVersion(versionId: string, body: string, docPath: string): Promise<void> {
    const tab = tabs[activeIdx];
    if (!tab || tab.docPath !== docPath) return void deps.log(`edit from ${versionId} skipped — ${docPath} is not the active document`);
    tab.markdown = body; // replace the current working copy (not yet on disk)
    await activateTab(activeIdx, false); // the surfaces still show the old body; don't capture it back
    deps.log(`editing from ${versionId} — Save to keep it`);
  }

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
    /**
     * The tab's text (markdown body, or raw HTML for html tabs) as last loaded, saved or
     * captured from its surface. While the tab is shown, the surface may be ahead of it:
     * read it through `liveText`.
     */
    markdown: string;
  }
  const tabs: Tab[] = [];
  let activeIdx = -1;
  let activationSeq = 0;
  /**
   * The document the surfaces were last given (the editor's buffer or the iframe's page);
   * undefined in the empty state. Only when it is the active tab's document do the surfaces
   * hold that tab's text.
   */
  let shownDocPath: string | undefined;
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

  /** While true the stored session is the one being restored: a reload now must find it whole. */
  let restoring = false;
  /**
   * Saved tabs the restore could not reopen because the sidecar was unreachable. They stay in
   * the stored session (after the open tabs) so the next launch tries them again.
   */
  let unrestoredTabs: SavedTab[] = [];

  function saveTabSession(): void {
    if (restoring) return;
    try {
      const kept = unrestoredTabs.filter((s) => !tabs.some((t) => t.docPath === s.docPath));
      if (!tabs.length && !kept.length) {
        localStorage.removeItem(TAB_SESSION_KEY);
        return;
      }
      const session: TabSession = {
        activeIdx: Math.max(0, Math.min(activeIdx, tabs.length - 1)),
        tabs: [...tabs.map((t) => ({ docPath: t.docPath, name: t.name, format: t.format })), ...kept],
      };
      localStorage.setItem(TAB_SESSION_KEY, JSON.stringify(session));
    } catch {
      // Storage can be unavailable in unusual webview modes; failing to persist is non-fatal.
    }
  }
  window.addEventListener("beforeunload", saveTabSession);

  /** Keyed on the tab itself, not its index: closing a tab before it shifts the index only. */
  function isCurrentActivation(seq: number, tab: Tab): boolean {
    return seq === activationSeq && tabs[activeIdx] === tab;
  }

  function renderTabBar(): void {
    tabsEl.innerHTML = "";
    tabs.forEach((tab, i) => {
      const row = document.createElement("div");
      row.className = `tab${i === activeIdx ? " active" : ""}`;
      const name = document.createElement("span");
      name.className = "tname";
      name.textContent = tab.name; // textContent, not innerHTML: file names are untrusted
      const close = document.createElement("button");
      close.className = "tclose";
      close.title = "Close";
      close.textContent = "×";
      row.append(name, close);
      name.addEventListener("click", () => void activateTab(i));
      close.addEventListener("click", (ev) => {
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

  /**
   * The active tab's text as the user sees it now. Markdown: read the editor synchronously —
   * its markdownUpdated listener reports 200 ms late, so a switch or ⌘S right after typing
   * would otherwise lose the last keystrokes. HTML: serialize the iframe only when it holds
   * this tab's finished load and the user edited it; otherwise the stored text is the
   * document (a load in flight still shows about:blank or the previous tab's page, and in
   * review mode the page's own scripts may have changed its DOM, which is not an edit).
   */
  function liveText(tab: Tab): string {
    if (tab !== tabs[activeIdx] || shownDocPath !== tab.docPath) return tab.markdown;
    if (tab.format === "html") return deps.getHtmlSurface()?.editedHtmlFor(tab.docPath) ?? tab.markdown;
    const md: unknown = deps.getEditor()?.action(getMarkdown());
    return typeof md === "string" ? md : tab.markdown;
  }

  /** Store the active tab's live text in it (before its surface is reused, saved or exported). */
  function captureActiveEdits(): void {
    const tab = tabs[activeIdx];
    if (tab) tab.markdown = liveText(tab);
  }

  // Document content is stored verbatim per tab: markdown bodies feed Milkdown; HTML
  // is rendered faithfully in the iframe surface (no lossy markdown conversion).
  function tabContent(text: string, _format: string): string {
    return text;
  }

  // Not persisted here: closeTab saves the (empty) session itself, and at boot an empty strip
  // after a restore that reached nothing must not erase the saved tabs.
  function showEmptyState(): void {
    activeIdx = -1;
    shownDocPath = undefined;
    closeDocModals();
    clearDocPath();
    void refreshHarnessBadge();
    deps.clearSearchHighlights();
    deps.setEditToggleVisible(false);
    deps.getHtmlSurface()?.unload(); // a closed page must not keep running
    deps.showMarkdownSurface();
    setWindowTitle("docuzen");
    deps.resetChat(); // clears the comment registry, chat pane, AND the #comments margin list
    // `true` = a fresh editor state: ⌘Z must not bring the closed document back.
    deps.getEditor()?.action(replaceAll("# No document open\n\nUse File → New Document (⌘N) or File → Open (⌘O).\n", true));
    deps.getEditor()?.action((ctx) => {
      const view: EditorView = ctx.get(editorViewCtx);
      view.dispatch(view.state.tr.setMeta(deps.annoKey, "clear"));
      view.dispatch(view.state.tr.setMeta(deps.proposalKey, "clear"));
    });
    renderTabBar();
  }

  /**
   * Show tab `idx`. `capture` (default) first stores the outgoing tab's live text; callers that
   * have just replaced the tab's text themselves (reload, Edit from version, closing the
   * active tab) pass false so the surfaces' now-stale content is not captured back.
   */
  async function activateTab(idx: number, capture = true): Promise<void> {
    if (idx < 0 || idx >= tabs.length || !deps.getEditor()) return;
    if (capture) captureActiveEdits();
    deps.clearAnnotationUndo(); // annotation-undo doesn't carry across document switches
    deps.clearSearchHighlights(); // search overlays are per rendered document, not persisted tab state
    const seq = ++activationSeq;
    activeIdx = idx;
    const tab = tabs[idx];
    if (tab.docPath !== shownDocPath) closeDocModals();
    shownDocPath = tab.docPath;
    deps.notifySessionActive(tab.docPath, tab.format); // keeps the store's view/listeners in sync
    setWindowTitle(`${tab.name} — docuzen`);
    setDocPath(tab.docPath);
    deps.resetChat(); // clears the comment registry, chat pane, AND the #comments margin list
    if (tab.format === "html") {
      deps.showHtmlSurface();
      deps.setEditToggleVisible(true);
      deps.setHtmlEditMode(false); // open HTML docs in review mode so links/clicks work
      deps.getHtmlSurface()?.load(tab.markdown, baseHrefForDoc(tab.docPath), tab.docPath);
    } else {
      deps.getHtmlSurface()?.unload(); // a hidden page must not keep running
      deps.setEditToggleVisible(false);
      deps.showMarkdownSurface();
      const editor = deps.getEditor()!;
      // `true` = a fresh editor state rather than an edit of the old one: the swap is not an
      // undo step (⌘Z right after switching must never bring back the other tab's text), and
      // the listener's pending 200 ms report about the old text is dropped with the old state.
      editor.action(replaceAll(tab.markdown, true));
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
    await refreshHarnessBadge();
    if (!isCurrentActivation(seq, tab)) return;
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
      if (!isCurrentActivation(seq, tab)) return;
      if (opened.annotations.length) deps.renderLoaded(opened.annotations);
    } catch (e) {
      if (!isCurrentActivation(seq, tab)) return;
      reportError("load annotations", e, deps.log);
    }
    // Re-render any pending proposals as inline diffs (approved/rejected excluded).
    // Hunks carry their own `oldText`, so renderProposal re-locates them — no anchor
    // recovery needed. Full rewrites route to the chat note (panel is the next task).
    try {
      const props = await deps.api.listProposals({ docPath: tab.docPath });
      if (!isCurrentActivation(seq, tab)) return;
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
      if (!isCurrentActivation(seq, tab)) return;
      reportError("load proposals", e, deps.log);
    }
    resetDocumentViewport();
  }

  /** True for the rpc client's "sidecar unreachable" rejection (the file itself may be fine). */
  function isConnectionLoss(e: unknown): boolean {
    return String(e).includes(LOST_CONNECTION_MESSAGE);
  }

  /** Add an opened document to the tab strip, once: a second open of the same file reuses its tab. */
  function addTab(path: string, opened: { text: string; format?: string }): number {
    const existing = tabs.findIndex((t) => t.docPath === path);
    if (existing >= 0) return existing;
    const format = opened.format === "html" ? "html" : "markdown";
    tabs.push({ docPath: path, name: path.split("/").pop() ?? path, format, markdown: tabContent(opened.text, format) });
    unrestoredTabs = unrestoredTabs.filter((s) => s.docPath !== path);
    deps.log(`opened ${path}`);
    return tabs.length - 1;
  }

  /** Open a document in a tab (activating an existing tab if already open). */
  async function openInTab(path: string): Promise<void> {
    if (!deps.getEditor()) return;
    const existing = tabs.findIndex((t) => t.docPath === path);
    if (existing >= 0) return void (await activateTab(existing));
    try {
      const opened = await deps.api.openDoc({ docPath: path });
      // Looked up again after the await: another open of the same file may have landed.
      await activateTab(addTab(path, opened));
      saveTabSession();
    } catch (e) {
      reportError("open", e, deps.log);
    }
  }

  async function closeTab(idx: number): Promise<void> {
    if (idx < 0 || idx >= tabs.length) return;
    const wasActive = idx === activeIdx;
    const next = activeIndexAfterClose(activeIdx, idx, tabs.length);
    const [closed] = tabs.splice(idx, 1);
    deps.log(`closed ${closed.name}`);
    if (tabs.length === 0) {
      activeIdx = -1;
      saveTabSession();
      return void showEmptyState();
    }
    if (!wasActive) {
      // A background tab: the active one keeps its surface, chat, drafts, search and undo —
      // only its index shifts. (activeIndexAfterClose: a non-active close keeps the user's tab.)
      activeIdx = next;
      renderTabBar();
      saveTabSession();
      return;
    }
    // The active tab closed: its neighbour takes over. The closed tab's unsaved text goes
    // with it, so there is nothing to capture.
    await activateTab(next, false);
    saveTabSession();
  }

  /**
   * Reopen the saved tabs. All of them are added first and one is activated once, so no
   * half-finished iframe load is ever read as another tab's document. Until it finishes the
   * stored session is left alone (a reload mid-restore finds it whole); tabs the sidecar could
   * not be reached for stay in it, and a restore that reopened nothing leaves it untouched.
   * A file the sidecar reports gone is dropped.
   */
  async function restoreTabSession(): Promise<boolean> {
    const session = loadTabSession();
    if (!session || !deps.getEditor()) return false;
    const unreachable: SavedTab[] = [];
    restoring = true;
    try {
      for (const saved of session.tabs) {
        // The sidecar is down: keep the rest without waiting out each call's reconnect grace.
        if (unreachable.length) {
          unreachable.push(saved);
          continue;
        }
        try {
          addTab(saved.docPath, await deps.api.openDoc({ docPath: saved.docPath }));
        } catch (e) {
          reportError(`restore ${saved.docPath}`, e, deps.log);
          if (isConnectionLoss(e)) unreachable.push(saved);
        }
      }
    } finally {
      restoring = false;
    }
    unrestoredTabs = unreachable.filter((s) => !tabs.some((t) => t.docPath === s.docPath));
    if (!tabs.length) return false;
    if (activeIdx >= 0) {
      // The user opened something while the tabs were restoring: stay on it.
      renderTabBar();
      saveTabSession();
      return true;
    }
    const activeDocPath = session.tabs[session.activeIdx]?.docPath;
    const restoredActiveIdx = activeDocPath ? tabs.findIndex((t) => t.docPath === activeDocPath) : -1;
    await activateTab(restoredActiveIdx >= 0 ? restoredActiveIdx : Math.min(session.activeIdx, tabs.length - 1));
    saveTabSession();
    return true;
  }

  /** Re-fetch the active doc from disk and re-render (after an applied edit). */
  async function reloadActiveDoc(): Promise<void> {
    const tab = tabs[activeIdx];
    if (tab) await reloadTab(tab);
  }

  /** Re-read `tab` from disk. Re-rendered if still active; otherwise it shows the fresh text when next activated. */
  async function reloadTab(tab: Tab): Promise<void> {
    try {
      const opened = await deps.api.openDoc({ docPath: tab.docPath });
      if (!tabs.includes(tab)) return; // closed meanwhile
      const format = opened.format === "html" ? "html" : "markdown";
      tab.format = format;
      tab.markdown = tabContent(opened.text, format);
      if (tabs[activeIdx] !== tab) return;
      await activateTab(activeIdx, false); // the surfaces still show the pre-edit doc; keep the fresh text
      saveTabSession();
    } catch (e) {
      reportError("reload", e, deps.log);
    }
  }

  /**
   * Save the active document's current text so a document-wide agent pass (Review, Resolve
   * directives), which reads the file, sees what the user sees, including just-typed
   * [[ … ]] directives. The sidecar keeps no new version when nothing changed.
   */
  async function syncActiveDocToDisk(): Promise<void> {
    const tab = tabs[activeIdx];
    if (!tab) return;
    captureActiveEdits();
    const text = tab.markdown;
    if (!text) return;
    try {
      await deps.api.saveDoc({ docPath: tab.docPath, text });
    } catch (e) {
      reportError("autosave", e, deps.log);
    }
  }

  /**
   * Milkdown's markdownUpdated listener. It reports ~200 ms after the edit, so it may describe
   * text the editor no longer holds (an HTML tab or no tab is active now, or a tab swap
   * replaced the buffer): such a report is dropped rather than written into the tab now shown.
   */
  function onEditorMarkdownUpdated(md: string, prev: string): void {
    const tab = tabs[activeIdx];
    if (!tab || tab.format !== "markdown" || shownDocPath !== tab.docPath) return;
    const live: unknown = deps.getEditor()?.action(getMarkdown());
    if (typeof live === "string" && live !== md) return;
    tab.markdown = md;
    if (md !== prev) {
      deps.clearAnnotationUndo(); // a real text edit takes over the undo chord
      deps.log(`edited (${md.length} chars)`);
      if (deps.searchIsOpen() && deps.searchState.query.trim()) deps.refreshMarkdownSearch(false, false);
    }
  }

  function getDocPath(): string | undefined {
    return tabs[activeIdx]?.docPath;
  }
  function getFormat(): "markdown" | "html" {
    return tabs[activeIdx]?.format ?? "markdown";
  }
  function getCurrentMarkdown(): string {
    const tab = tabs[activeIdx];
    return tab ? liveText(tab) : "";
  }
  function markActiveHtmlTabDirty(): void {
    const tab = tabs[activeIdx];
    if (tab?.format === "html") deps.getHtmlSurface()?.markEdited(tab.docPath);
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
    onEditorMarkdownUpdated,
    markActiveHtmlTabDirty,
    syncActiveDocToDisk,
    uncollapseLeftPane,
    uncollapseRightRail,
    refreshHarnessBadge,
    drainExternalOpens,
  };
}
