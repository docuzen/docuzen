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
import { initHtmlSurface } from "./surface.js";
import { initDocLinks } from "./doc-links.js";
import { openPath, openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { initSearch } from "./search-panel.js";
import { initChat } from "./chat.js";
import { initProposals } from "./proposals.js";
import { initDocZoom } from "./doc-zoom.js";
import { connect, docdPort } from "./rpc.js";
import { initDocImages } from "./doc-images.js";
import { maybeShowFirstRun } from "./first-run.js";

const logEl = document.querySelector<HTMLPreElement>("#log")!;
// Newest line first. Bounded so a long session (one "edited" line per keystroke) can't
// grow the <pre> without limit or turn each append into a full-text copy.
const LOG_MAX_LINES = 500;
const logLines: string[] = [];
function log(line: string): void {
  const ts = new Date().toISOString().slice(11, 19);
  logLines.unshift(`${ts}  ${line}`);
  if (logLines.length > LOG_MAX_LINES) logLines.length = LOG_MAX_LINES;
  logEl.textContent = logLines.join("\n") + "\n";
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
  logLines.length = 0;
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
  // Save what the user sees before a document-wide pass reads the file (shell.ts owns which
  // text that is: the editor/iframe of the active tab, never a half-loaded page).
  syncDocToDisk: () => shell.syncActiveDocToDisk(),
  clearAnnotationUndo: () => htmlSurfaceApi.clearAnnotationUndo(),
  setDirectivesWorking: (on) => setDirectivesWorking(on),
  openVersionPreview: (versionId) => shell.openVersionPreview(versionId),
  truncTitle,
  resetCommentSeq: () => htmlSurfaceApi.resetCommentSeq(),
  removeAnnotationById: (id) => htmlSurfaceApi.removeAnnotationById(id),
  uncollapseLeftPane: () => shell.uncollapseLeftPane(),
});

/** A short message over the document that goes away by itself (the log is hidden by default). */
let docNoticeTimer: ReturnType<typeof setTimeout> | undefined;
function showDocNotice(message: string): void {
  let box = document.querySelector<HTMLElement>("#docNotice");
  if (!box) {
    box = document.createElement("div");
    box.id = "docNotice";
    box.className = "docnotice";
    box.setAttribute("role", "status");
    document.body.appendChild(box);
  }
  box.textContent = message;
  box.hidden = false;
  clearTimeout(docNoticeTimer);
  docNoticeTimer = setTimeout(() => (box.hidden = true), 4500);
}

// --- images: drop/paste into either surface, stored in the doc's .had/assets (doc-images.ts).
const docImages = initDocImages({
  rootEl: editorEl,
  log,
  reportError: (scope, e) => reportError(scope, e, log),
  getEditor: () => editorRef ?? undefined,
  getHtmlSurface: () => htmlSurface,
  getDocPath: activeDocPath,
  getFormat: activeFormat,
  port: docdPort,
  saveImage: (p) => api.saveImage(p),
  readImage: (path) => api.readImage({ path }),
  notify: showDocNotice,
  onHtmlEdited: () => shell.markActiveHtmlTabDirty(),
});

// --- links: ⌘-click (or a click in HTML review mode) opens what a link points at (doc-links.ts).
const docLinks = initDocLinks({
  getDocPath: activeDocPath,
  openUrl: (url) => openUrl(url),
  openPath: (path) => openPath(path),
  revealPath: (path) => revealItemInDir(path),
  openInTab: (path) => shell.openInTab(path),
  notify: showDocNotice,
  log,
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
  addImagePaths: (paths) => docImages.addPaths(paths),
  canInsertImage: () => docImages.canInsert(),
  runResolveDirectives: chat.runResolveDirectives,
  refreshThreadModels: chat.refreshThreadModels,
  setDefaultModelKey: chat.setDefaultModelKey,
  getThreadNodes: chat.getThreadNodes,
  refreshThreadTree: chat.refreshThreadTree,
  truncTitle,
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
  // A document switch also closes the previous document's full-rewrite panel.
  resetChat: () => {
    chat.resetChat();
    proposals.closeDiffPanel();
  },
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
  wireHtmlImages: docImages.wireHtmlDocument,
  openLink: docLinks.open,
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
  beginExclusiveTurn: chat.beginExclusiveTurn,
  endExclusiveTurn: chat.endExclusiveTurn,
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

// --- init: mount the editor, then open the initial doc as the first tab ---
async function init(): Promise<void> {
  const editorApi = await initEditor({
    rootEl: editorEl,
    log,
    getFormat: activeFormat,
    // The milkdown markdownUpdated listener: shell.ts owns the tabs it writes to, and drops a
    // late report about text the editor no longer shows.
    onMarkdownUpdated: (md, prev) => shell.onEditorMarkdownUpdated(md, prev),
    resolveImageSrc: docImages.resolve,
    readImage: docImages.read,
    openLink: docLinks.open,
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
  // Files opened from Finder (cold launch, or while the session restored) open after the
  // restored tabs, so they end up focused, and before the empty state / default doc / badge,
  // which then describe the document actually shown.
  await shell.drainExternalOpens({ boot: true });
  if (shell.getTabCount() === 0 && initialDocPath) await shell.openInTab(initialDocPath);
  else if (shell.getTabCount() === 0) shell.showEmptyState();
  await shell.refreshHarnessBadge(); // boot refresh — see shell.ts's harness-badge section for the full trigger contract
  void maybeShowFirstRun(client, log, { onConfigured: () => void shell.refreshHarnessBadge() });
}

void init();
