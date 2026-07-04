// Bootstrap: constructs shared state (log, RPC client, DocSession store, editor/
// html-surface handles) and wires every feature module together. This file is
// the ONLY place that imports every module; feature modules never import each
// other (see each module's own header for its wiring-pattern notes) — cross-module
// calls are threaded through here via each `init<Name>(deps)` factory's `deps`
// object, with forward references (`(x) => laterConst.method(x)`) wherever a
// dependency isn't constructed yet at the point its consumer is wired (safe: none
// of these closures are CALLED until well after every top-level `const` in this
// file has been assigned).
//
// Construction order (chosen to minimize forward references):
// chat → search → shell → proposals → surface. `chat` is built first and so must
// forward-reference shell/proposals/surface; `shell` is built third and forward-
// references proposals/surface; proposals and surface are built last and need NO
// forward references (everything they depend on already exists).
//
// OWNERSHIP FLIP (Task 5): the old `DOC_PATH`/`currentFormat` globals are GONE.
// shell.ts's `tabs`/`activeIdx` are now the sole source of truth; `activeDocPath`/
// `activeFormat` below read it through the `sessionStore` (whose delegate, in
// turn, reads shell.ts's `getDocPath`/`getFormat` — see shell.ts's header).

import type { Editor } from "@milkdown/kit/core";
import { getMarkdown } from "@milkdown/kit/utils";
import { HtmlSurface, baseHrefForDoc } from "./html-surface.js";
import {
  buildHtmlSnippetPreviewContext,
  createHtmlSnippetPreviewFrame,
  htmlPreviewSnippet,
  type HtmlSnippetPreviewContext,
} from "./html-snippet-preview.js";
import { createSessionStore } from "./session.js";
import { reportError } from "./ui.js";
import {
  initEditor,
  annoKey,
  proposalKey,
  searchKey,
  swatchByName,
  findDirectiveOffsets,
  nextMermaidSeq,
  PALETTE,
  COMMENT_COLOR,
  type LoadedAnno,
} from "./editor.js";
import { initShell } from "./shell.js";
import { initSearch, initHtmlSurface } from "./surface.js";
import { initChat } from "./chat.js";
import { initProposals } from "./proposals.js";
import { initDocZoom } from "./doc-zoom.js";
import { connect } from "./rpc.js";
import { maybeShowFirstRun } from "./first-run.js";

const logEl = document.querySelector<HTMLPreElement>("#log")!;
function log(line: string): void {
  const ts = new Date().toISOString().slice(11, 19);
  logEl.textContent = `${ts}  ${line}\n` + logEl.textContent;
}

// --- engine banner ---
(function showEngine() {
  const ua = navigator.userAgent;
  const isWebKit = /AppleWebKit/.test(ua) && !/Chrome|Chromium|Edg/.test(ua);
  document.querySelector<HTMLDivElement>("#engine")!.textContent = `engine: ${
    isWebKit ? "WKWebView ✅" : "Chromium-class (run inside `tauri dev`)"
  }`;
})();

document.querySelector("#clearlog")!.addEventListener("click", () => {
  logEl.textContent = "";
});

// docd connection status indicator (topbar, next to the engine badge). rpc.ts's
// connect() now auto-reconnects forever and reports "connected" / "reconnecting
// (attempt N)" / "disconnected"; both non-connected states render identically
// here (amber "reconnecting…") since the indicator only needs to answer "can I
// talk to docd right now or not".
const connStatusEl = document.querySelector<HTMLSpanElement>("#connStatus")!;
const connLabelEl = connStatusEl.querySelector<HTMLSpanElement>(".connlabel")!;
function updateConnStatus(status: string): void {
  const connected = status === "connected";
  connStatusEl.classList.toggle("connected", connected);
  connStatusEl.classList.toggle("reconnecting", !connected);
  connLabelEl.textContent = connected ? "docd" : "reconnecting…";
  const packaged = typeof (globalThis as { __DOCD_PORT__?: number }).__DOCD_PORT__ === "number";
  connStatusEl.title = !connected && packaged ? "sidecar log: ~/.docuzen/logs/docd.log" : "";
}

const client = connect((s) => {
  log(s);
  updateConnStatus(s);
});

// Shared DOM mount points, queried once and threaded to every module that needs
// them (editor.ts/surface.ts's initSearch/initHtmlSurface, shell.ts).
const editorEl = document.querySelector<HTMLDivElement>("#editor")!;
const htmlHostEl = document.querySelector<HTMLDivElement>("#htmlHost")!;

// The document to auto-open on first run if no tab session was restored — the dev
// env's default doc. Captured ONCE (never reassigned): unlike the pre-Task-5
// `DOC_PATH` global this used to be read from, "what's active now" lives entirely
// in shell.ts's tabs after this point.
const initialDocPath = (import.meta as { env?: Record<string, string> }).env?.VITE_DOC_PATH;

// Bound inside init() (below); referenced by deps closures above/below that are
// never CALLED until well after init() completes.
let editorRef: Editor | null = null;
let renderLoaded: (annotations: LoadedAnno[]) => void = () => {};
let setDirectivesWorking: (on: boolean) => void = () => {};
let htmlSurface: HtmlSurface | null = null;

// --- document zoom (⌘+ / ⌘- / ⌘0). See doc-zoom.ts's file header. Constructed
// early (before every other module) so the restored zoom level applies before
// the editor mounts (avoids a flash of unzoomed content), and threaded into
// htmlSurfaceApi below so the HTML iframe surface zooms the same way the
// markdown sheet does. `getHtmlSurfaceDoc` closes over `htmlSurface` by
// reference (not yet assigned at this point) — safe, since it's only CALLED
// later, well after init() assigns it (same forward-reference pattern this
// file's header describes for every other deps closure).
const docZoom = initDocZoom({ getHtmlSurfaceDoc: () => htmlSurface?.doc ?? null });

// DocSession store: shell.ts's tabs are the sole source of truth (see file
// header's OWNERSHIP FLIP note) — the delegate reads through shell's getDocPath/
// getFormat; its setters are no-ops because shell already updated the real state
// (tabs[activeIdx]) before calling `sessionStore.setActive` (kept only to fire
// onChange listeners, for whenever something starts using them).
const sessionStore = createSessionStore(client, {
  getDocPath: () => shell.getDocPath(),
  getFormat: () => shell.getFormat(),
  setDocPath: () => {},
  setFormat: () => {},
});
const api = sessionStore.api;

/** The active document's path/format, read through the session store — see file header. */
function activeDocPath(): string | undefined {
  return sessionStore.active()?.docPath;
}
function activeFormat(): "markdown" | "html" {
  return sessionStore.active()?.format ?? "markdown";
}

// --- HTML-preview-aware text rendering, shared by chat turns/proposal previews.
// Stays main.ts-owned (not moved into chat.ts or proposals.ts) — see those
// modules' file headers for why: it's called by both, and the wiring rule
// forbids either from exporting it back out for the other's benefit.
function activeHtmlPreviewContext(): HtmlSnippetPreviewContext | null {
  if (activeFormat() !== "html") return null;
  const docPath = activeDocPath();
  return buildHtmlSnippetPreviewContext(htmlSurface?.doc, docPath ? baseHrefForDoc(docPath) : undefined);
}

function renderPreviewText(
  into: HTMLElement,
  text: string,
  context: HtmlSnippetPreviewContext | null = activeHtmlPreviewContext(),
): void {
  into.dataset.rawText = text;
  const snippet = context ? htmlPreviewSnippet(text) : null;
  if (!context || !snippet) {
    into.classList.remove("html-snippet-host");
    into.textContent = text;
    return;
  }

  const doc = into.ownerDocument;
  into.classList.add("html-snippet-host");
  into.replaceChildren();

  const preview = doc.createElement("div");
  preview.className = "html-snippet-preview";
  preview.style.cssText = "display:flex;flex-direction:column;gap:4px;";
  const label = doc.createElement("div");
  label.className = "html-snippet-label";
  label.textContent = "Rendered HTML preview";
  label.style.cssText =
    "color:#6b6b80;font:700 10px/1 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;letter-spacing:.06em;text-transform:uppercase;";
  const frame = createHtmlSnippetPreviewFrame(doc, snippet, context);
  frame.style.cssText =
    "display:block;width:100%;min-height:140px;max-height:260px;border:1px solid #d8d8df;border-radius:10px;background:transparent;";
  preview.append(label, frame);

  const raw = doc.createElement("details");
  raw.className = "html-snippet-raw";
  raw.style.cssText = "margin-top:6px;color:#6b6b80;font-size:12px;";
  const summary = doc.createElement("summary");
  summary.textContent = "Raw HTML";
  const pre = doc.createElement("pre");
  pre.textContent = text;
  pre.style.cssText =
    "margin:4px 0 0;padding:6px 8px;max-height:12rem;overflow:auto;border:1px solid #d8d8df;border-radius:8px;background:rgba(255,255,255,.66);color:#1d1d1f;white-space:pre-wrap;word-break:break-word;font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;";
  raw.append(summary, pre);

  into.append(preview, raw);
}

function rawPreviewText(from: HTMLElement): string {
  return from.dataset.rawText ?? from.textContent ?? "";
}

/**
 * Truncate a tree-node title for compact single-line display. Pure helper shared by
 * chat.ts's thread tree (via deps.truncTitle) and shell.ts's version picker — stays
 * main.ts-owned rather than picking one of the two as its home.
 */
function truncTitle(s: string, max = 34): string {
  return s.length > max ? s.slice(0, max) + "…" : s;
}

/**
 * Strip the leading `---\nhad: …\n---\n` frontmatter so we show the doc body only. Only
 * caller is shell.ts's version preview (via deps.stripFrontmatter) — stays main.ts-owned.
 */
function stripFrontmatter(s: string): string {
  return s.replace(/^---\n[\s\S]*?\n---\n/, "");
}

/**
 * Persist the current editor content to disk so document-wide agent passes — which read
 * the file on the backend — see the user's latest text, including just-typed [[ … ]]
 * directives. Dedupes to no new version when nothing changed. Needs `editorRef`/
 * `htmlSurface` (bootstrap-owned instances), so it stays here rather than moving into
 * shell.ts with the rest of the tabs domain; chat.ts's review/directives actions
 * reach it via deps.syncDocToDisk, and it clears the active tab's dirty flag through
 * shell.ts's `clearActiveTabDirty`.
 */
async function syncDocToDisk(): Promise<void> {
  if (!activeDocPath()) return;
  const text =
    activeFormat() === "html" ? htmlSurface?.getHtml() ?? "" : editorRef?.action(getMarkdown()) ?? shell.getCurrentMarkdown();
  if (!text) return;
  try {
    await api.saveDoc({ text });
    shell.clearActiveTabDirty();
  } catch (e) {
    reportError("autosave", e, log);
  }
}

// --- chat pane: discussion threads, review pass, inline directives, agents panel,
// comment cards. See chat.ts's file header. Constructed first — its forward
// references to shell/proposals/surface are resolved once those are built below
// (never called before then).
const chat = initChat({
  api,
  log,
  getDocPath: activeDocPath,
  getFormat: activeFormat,
  getHtmlSurface: () => htmlSurface,
  renderPreviewText,
  rawPreviewText,
  routeProposal: (e) => proposals.routeProposal(e),
  reloadActiveDoc: () => shell.reloadActiveDoc(),
  syncDocToDisk,
  clearAnnotationUndo: () => htmlSurfaceApi.clearAnnotationUndo(),
  setDirectivesWorking: (on) => setDirectivesWorking(on),
  openVersionPreview: (versionId) => shell.openVersionPreview(versionId),
  truncTitle,
  resetCommentSeq: () => htmlSurfaceApi.resetCommentSeq(),
  removeAnnotationById: (id) => htmlSurfaceApi.removeAnnotationById(id),
  uncollapseLeftPane: () => shell.uncollapseLeftPane(),
});

// --- in-document search UI (markdown + HTML iframe). See surface.ts's file header.
const searchApi = initSearch({
  rootEl: editorEl,
  getEditor: () => editorRef,
  getHtmlSurface: () => htmlSurface,
  getFormat: activeFormat,
  searchKey,
});

// --- shell: settings modal, model manager, harness caps, version preview/picker
// modals, doc actions (Save/Export/Open) + native-menu wiring + tabs/session
// restore (the DocSession store's sole backing state — see file header). See
// shell.ts's file header for the OWNERSHIP FLIP details.
const shell = initShell({
  api,
  log,
  getEditor: () => editorRef,
  getHtmlSurface: () => htmlSurface,
  rootEl: editorEl,
  runResolveDirectives: chat.runResolveDirectives,
  refreshThreadModels: chat.refreshThreadModels,
  setDefaultModelKey: chat.setDefaultModelKey,
  getThreadNodes: chat.getThreadNodes,
  refreshThreadTree: chat.refreshThreadTree,
  truncTitle,
  stripFrontmatter,
  notifySessionActive: sessionStore.setActive,
  annoKey,
  proposalKey,
  searchKey,
  renderLoaded: (annotations) => renderLoaded(annotations),
  clearAnnotationUndo: () => htmlSurfaceApi.clearAnnotationUndo(),
  showHtmlSurface: () => htmlSurfaceApi.showHtmlSurface(),
  showMarkdownSurface: () => htmlSurfaceApi.showMarkdownSurface(),
  setEditToggleVisible: (v) => htmlSurfaceApi.setEditToggleVisible(v),
  setHtmlEditMode: (on) => htmlSurfaceApi.setHtmlEditMode(on),
  clearSearchHighlights: searchApi.clearSearchHighlights,
  searchIsOpen: searchApi.searchIsOpen,
  searchState: searchApi.searchState,
  refreshMarkdownSearch: searchApi.refreshMarkdownSearch,
  renderProposal: (p) => proposals.renderProposal(p),
  openDiffPanel: (p) => proposals.openDiffPanel(p),
  resetChat: chat.resetChat,
  chatTurnWithAction: chat.chatTurnWithAction,
  modelName: chat.modelName,
});
shell.wireMenu();

// --- proposal widgets/rendering + full-rewrite diff panel. See proposals.ts's
// file header. Everything it needs (chat, shell) already exists — no forward refs.
const proposals = initProposals({
  api,
  log,
  getDocPath: activeDocPath,
  getFormat: activeFormat,
  getEditor: () => editorRef,
  getHtmlSurface: () => htmlSurface,
  renderPreviewText,
  reloadActiveDoc: shell.reloadActiveDoc,
  chatTurn: chat.chatTurn,
  chatTurnWithAction: chat.chatTurnWithAction,
  getCommentQuoted: chat.getCommentQuoted,
  proposalKey,
  findDirectiveOffsets,
});

// --- HTML surface interactions, selection popover + swatches + quick actions. See
// surface.ts's file header. Everything it needs (chat, search, shell, proposals)
// already exists — no forward refs.
const htmlSurfaceApi = initHtmlSurface({
  api,
  log,
  getDocPath: activeDocPath,
  getFormat: activeFormat,
  getEditor: () => editorRef,
  getHtmlSurface: () => htmlSurface,
  rootEl: editorEl,
  htmlHostEl,
  reloadActiveDoc: shell.reloadActiveDoc,
  getCurrentMarkdown: shell.getCurrentMarkdown,
  annoKey,
  swatchByName,
  PALETTE,
  COMMENT_COLOR,
  nextMermaidSeq,
  searchIsOpen: searchApi.searchIsOpen,
  searchState: searchApi.searchState,
  refreshMarkdownSearch: searchApi.refreshMarkdownSearch,
  refreshHtmlSearch: searchApi.refreshHtmlSearch,
  handleSearchShortcut: searchApi.handleSearchShortcut,
  handleZoomShortcut: docZoom.handleZoomShortcut,
  applyDocZoom: docZoom.applyToIframeDoc,
  wirePinchZoom: docZoom.wirePinchZoom,
  routeProposal: proposals.routeProposal,
  renderProposalHtml: proposals.renderProposalHtml,
  openDiffPanel: proposals.openDiffPanel,
  promoteToChat: chat.promoteToChat,
  onAnnotationJump: chat.jumpToAnnotation,
  addCommentCard: chat.addCommentCard,
  hasComment: chat.hasComment,
  getCommentQuoted: chat.getCommentQuoted,
  registerBranchEntry: chat.registerBranchEntry,
  removeCommentEntry: chat.removeCommentEntry,
  chatTurnWithAction: chat.chatTurnWithAction,
  handleResolveShortcut: chat.handleResolveShortcut,
  activateChatPane: chat.activateChatPane,
  chatTurn: chat.chatTurn,
  streamingAgentTurn: chat.streamingAgentTurn,
  setChip: chat.setChip,
  setChatBusy: chat.setChatBusy,
  markDiscussed: chat.markDiscussed,
  focusCommentInput: chat.focusCommentInput,
  runImprove: chat.runImprove,
  modelName: chat.modelName,
  getStance: chat.getStance,
  getModelId: chat.getModelId,
  appendCustomTurn: chat.appendCustomTurn,
  scrollTurnsToBottom: chat.scrollTurnsToBottom,
  uncollapseRightRail: shell.uncollapseRightRail,
});

// Esc closes the version-preview modal (shell.ts) and the full-rewrite diff panel
// (proposals.ts) — kept here rather than in either module since it's the one
// listener that spans both.
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !shell.versionModal.hidden) shell.versionModal.hidden = true;
  if (e.key === "Escape" && !proposals.diffPanel.hidden) proposals.diffPanel.hidden = true;
});

/**
 * The milkdown markdownUpdated listener body. Lives in main.ts (not editor.ts)
 * because it reaches into tabs state (shell.ts-owned) and calls back into
 * surface.ts's search refresh — main.ts is the composition root that wires both,
 * so this cross-module call is threaded through here rather than either leaf.
 */
function onEditorMarkdownUpdated(md: string, prev: string): void {
  // Ignore Milkdown updates while an HTML tab is active (its content lives in
  // the iframe, not Milkdown) so we never overwrite the raw HTML with markdown.
  if (activeFormat() === "html") return;
  shell.setActiveTabMarkdown(md); // preserve edits per tab (no-op with no active tab)
  if (md !== prev) {
    htmlSurfaceApi.clearAnnotationUndo(); // a real text edit takes over the undo chord
    log(`edited (${md.length} chars)`);
    if (searchApi.searchIsOpen() && searchApi.searchState.query.trim()) searchApi.refreshMarkdownSearch(false, false);
  }
}

// --- init: mount the editor, then open the initial doc as the first tab ---
async function init(): Promise<void> {
  const editorApi = await initEditor({
    rootEl: editorEl,
    log,
    getFormat: activeFormat,
    onMarkdownUpdated: onEditorMarkdownUpdated,
    promoteToChat: chat.promoteToChat,
    onAnnotationJump: chat.jumpToAnnotation,
    onDirectiveJump: chat.jumpToDirective,
    buildProposalWidget: proposals.buildProposalWidget,
    buildProposalAddOnly: proposals.buildProposalAddOnly,
    buildProposalFallbackWidget: proposals.buildProposalFallbackWidget,
    nextCommentSeq: () => htmlSurfaceApi.nextCommentSeq(),
    hasComment: chat.hasComment,
    getCommentQuoted: chat.getCommentQuoted,
    addCommentCard: chat.addCommentCard,
    registerBranchEntry: chat.registerBranchEntry,
  });
  editorRef = editorApi.editor;
  renderLoaded = editorApi.renderLoaded;
  setDirectivesWorking = editorApi.setDirectivesWorking;

  htmlSurface = new HtmlSurface(htmlHostEl, {
    onEdit: () => {
      shell.markActiveHtmlTabDirty();
      htmlSurfaceApi.clearAnnotationUndo(); // a real iframe edit takes over the undo chord
      if (searchApi.searchIsOpen() && searchApi.searchState.query.trim()) searchApi.refreshHtmlSearch(false, false);
    },
    onSelection: () => htmlSurfaceApi.updateHtmlPopover(),
    onReady: () => void htmlSurfaceApi.onHtmlReady(),
  });

  log("editor mounted ✅ — select text → swatch / 💬");
  await chat.refreshThreadModels(); // populate the per-thread model pickers' cache
  await shell.restoreTabSession();
  if (shell.getTabCount() === 0 && initialDocPath) await shell.openInTab(initialDocPath);
  else if (shell.getTabCount() === 0) shell.showEmptyState();
  await shell.refreshHarnessBadge(); // boot refresh — see shell.ts's harness-badge section for the full trigger contract
  void maybeShowFirstRun(client, log);
  void shell.drainExternalOpens();
}

void init();
