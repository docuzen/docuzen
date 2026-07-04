// The in-document search UI (markdown + HTML iframe): the search panel, its
// keyboard shortcut (⌘F), and refreshing matches against either surface.
//
// Wave-1 scope: search only. The rest of the HTML surface (iframe interactions,
// annotation rendering, popover wiring, HTML proposal cards) stays in main.ts
// until this plan's Task 5 wave-2 step.
//
// Wiring pattern: initSearch(deps) queries this module's own DOM elements and
// returns the small external surface main.ts (and, later, other regions) call:
// searchIsOpen/searchState/refreshMarkdownSearch/refreshHtmlSearch/
// clearSearchHighlights. The search PluginKey is owned by editor.ts (one module
// instance) — this module never imports editor.ts (modules may only import
// ui.ts/session.ts per the plan's wiring rule), so main.ts passes the SAME
// PluginKey instance in via `deps.searchKey`, typed here only via the third-party
// `PluginKey` type. Likewise `SearchDecorationMeta`'s shape is redeclared locally
// (`SearchMeta`) rather than imported — it's a pure compile-time cast, so
// duplicating the 4-line shape costs nothing and keeps this module decoupled.
//
// DOM-query timing: like editor.ts/shell.ts, this module does no module-scope
// `document.querySelector` — its elements are queried once, inside initSearch()'s
// body, at the same point main.ts used to query them.

import type { Editor } from "@milkdown/kit/core";
import { editorViewCtx } from "@milkdown/kit/core";
import type { EditorView } from "@milkdown/kit/prose/view";
import type { PluginKey } from "@milkdown/kit/prose/state";
import mermaid from "mermaid";
import { openPath, openUrl } from "@tauri-apps/plugin-opener";
import { createAnchor, resolveAnchor } from "@ai-native-doc/docd/anchor";
import type { TextQuoteAnchor } from "@ai-native-doc/docd/anchor";
import type { Annotation, EditHunk, RpcEvent } from "@ai-native-doc/docd/protocol";
import { projectionOf, offsetForPos, posRangeForOffsets } from "./anchor-map.js";
import { findTextMatches, nextSearchIndex, type TextMatch } from "./doc-search.js";
import { buildHtmlProjection, offsetsForRange, rangeForOffsets, wrapRange, unwrapAnno } from "./html-projection.js";
import type { HtmlSurface } from "./html-surface.js";
import type { DocdApi } from "./session.js";
import { reportError } from "./ui.js";

/** Mirrors editor.ts's `SearchDecorationMeta` shape — see file header. */
interface SearchMeta {
  ranges: { from: number; to: number; index: number }[];
  activeIndex: number;
}

export interface SearchState {
  query: string;
  matches: TextMatch[];
  activeIndex: number;
}

export interface SearchDeps {
  /** The milkdown mount point (`#editor`), shared with editor.ts (same DOM node). */
  rootEl: HTMLElement;
  getEditor: () => Editor | null;
  getHtmlSurface: () => HtmlSurface | null;
  getFormat: () => "markdown" | "html";
  /** editor.ts's singleton search PluginKey — passed in, not imported (see file header). */
  searchKey: PluginKey;
}

export interface SearchApi {
  readonly searchState: SearchState;
  searchIsOpen(): boolean;
  refreshMarkdownSearch(resetActive?: boolean, scroll?: boolean): void;
  refreshHtmlSearch(resetActive?: boolean, scroll?: boolean): void;
  refreshSearchResults(resetActive?: boolean, scroll?: boolean): void;
  clearSearchHighlights(): void;
  /** Also wired directly onto the HTML iframe's own document (see onHtmlReady in main.ts) so ⌘F works with focus inside it. */
  handleSearchShortcut(e: KeyboardEvent): void;
}

export function initSearch(deps: SearchDeps): SearchApi {
  const searchBtnEl = document.querySelector<HTMLButtonElement>("#searchBtn")!;
  const searchPanelEl = document.querySelector<HTMLDivElement>("#searchPanel")!;
  const searchInputEl = document.querySelector<HTMLInputElement>("#searchInput")!;
  const searchCountEl = document.querySelector<HTMLSpanElement>("#searchCount")!;
  const searchPrevEl = document.querySelector<HTMLButtonElement>("#searchPrev")!;
  const searchNextEl = document.querySelector<HTMLButtonElement>("#searchNext")!;
  const searchClearEl = document.querySelector<HTMLButtonElement>("#searchClear")!;
  const searchCloseEl = document.querySelector<HTMLButtonElement>("#searchClose")!;

  const searchState: SearchState = { query: "", matches: [], activeIndex: -1 };

  function searchIsOpen(): boolean {
    return !searchPanelEl.hidden;
  }

  function syncSearchControls(): void {
    const q = searchState.query.trim();
    const total = searchState.matches.length;
    if (!q) searchCountEl.textContent = "Type to search";
    else if (!total) searchCountEl.textContent = "0 results";
    else searchCountEl.textContent = `${searchState.activeIndex + 1} / ${total}`;
    searchPrevEl.disabled = total === 0;
    searchNextEl.disabled = total === 0;
    searchClearEl.disabled = !q;
  }

  function setSearchMatches(matches: TextMatch[], resetActive: boolean): void {
    searchState.matches = matches;
    if (!matches.length) {
      searchState.activeIndex = -1;
    } else if (resetActive || searchState.activeIndex < 0) {
      searchState.activeIndex = 0;
    } else if (searchState.activeIndex >= matches.length) {
      searchState.activeIndex = matches.length - 1;
    }
  }

  function clearMarkdownSearch(): void {
    deps.getEditor()?.action((ctx) => {
      const view: EditorView = ctx.get(editorViewCtx);
      view.dispatch(view.state.tr.setMeta(deps.searchKey, "clear"));
    });
  }

  function unwrapHtmlSearch(doc: Document): void {
    doc.querySelectorAll("[data-had-search]").forEach((span) => {
      const parent = span.parentNode;
      if (!parent) return;
      while (span.firstChild) parent.insertBefore(span.firstChild, span);
      parent.removeChild(span);
      parent.normalize();
    });
  }

  function clearSearchHighlights(): void {
    clearMarkdownSearch();
    const doc = deps.getHtmlSurface()?.doc;
    if (doc) unwrapHtmlSearch(doc);
  }

  function scrollActiveMarkdownMatch(): void {
    requestAnimationFrame(() => {
      deps.rootEl
        .querySelector<HTMLElement>(".had-search-match.active")
        ?.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" });
    });
  }

  function scrollActiveHtmlMatch(doc: Document): void {
    requestAnimationFrame(() => {
      doc
        .querySelector<HTMLElement>(".had-search-match.active")
        ?.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" });
    });
  }

  function refreshMarkdownSearch(resetActive = false, scroll = false): void {
    const editor = deps.getEditor();
    if (!editor) return;
    const q = searchState.query;
    editor.action((ctx) => {
      const view: EditorView = ctx.get(editorViewCtx);
      const proj = projectionOf(view);
      const matches = findTextMatches(proj.text, q);
      setSearchMatches(matches, resetActive);
      if (!q.trim()) {
        view.dispatch(view.state.tr.setMeta(deps.searchKey, "clear"));
        return;
      }
      const ranges = matches
        .map((m, index) => {
          const range = posRangeForOffsets(proj, m.start, m.end);
          return range ? { ...range, index } : null;
        })
        .filter((r): r is { from: number; to: number; index: number } => Boolean(r));
      view.dispatch(
        view.state.tr.setMeta(deps.searchKey, {
          ranges,
          activeIndex: searchState.activeIndex,
        } as SearchMeta),
      );
    });
    syncSearchControls();
    if (scroll && searchState.activeIndex >= 0) scrollActiveMarkdownMatch();
  }

  function refreshHtmlSearch(resetActive = false, scroll = false): void {
    const doc = deps.getHtmlSurface()?.doc;
    if (!doc?.body) {
      setSearchMatches([], resetActive);
      syncSearchControls();
      return;
    }
    unwrapHtmlSearch(doc);
    const q = searchState.query;
    const proj = buildHtmlProjection(doc.body);
    const matches = findTextMatches(proj.text, q);
    setSearchMatches(matches, resetActive);
    if (q.trim()) {
      [...matches].reverse().forEach((m, reverseIndex) => {
        const index = matches.length - 1 - reverseIndex;
        const range = rangeForOffsets(doc, proj, m.start, m.end);
        if (!range) return;
        wrapRange(doc, range, () => {
          const span = doc.createElement("span");
          span.setAttribute("data-had-search", "");
          span.setAttribute("data-search-index", String(index));
          span.className = `had-search-match${index === searchState.activeIndex ? " active" : ""}`;
          return span;
        });
      });
    }
    syncSearchControls();
    if (scroll && searchState.activeIndex >= 0) scrollActiveHtmlMatch(doc);
  }

  function refreshSearchResults(resetActive = false, scroll = false): void {
    if (deps.getFormat() === "html") refreshHtmlSearch(resetActive, scroll);
    else refreshMarkdownSearch(resetActive, scroll);
  }

  function openSearchPanel(): void {
    searchPanelEl.hidden = false;
    searchBtnEl.classList.add("active");
    refreshSearchResults(false, false);
    requestAnimationFrame(() => {
      searchInputEl.focus();
      searchInputEl.select();
    });
  }

  function closeSearchPanel(): void {
    searchPanelEl.hidden = true;
    searchBtnEl.classList.remove("active");
    clearSearchHighlights();
  }

  function clearSearch(): void {
    searchState.query = "";
    searchState.matches = [];
    searchState.activeIndex = -1;
    searchInputEl.value = "";
    clearSearchHighlights();
    syncSearchControls();
    searchInputEl.focus();
  }

  function goToSearchMatch(direction: 1 | -1): void {
    if (!searchState.query.trim()) return;
    refreshSearchResults(false, false);
    searchState.activeIndex = nextSearchIndex(searchState.activeIndex, searchState.matches.length, direction);
    refreshSearchResults(false, true);
  }

  function handleSearchShortcut(e: KeyboardEvent): void {
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && (e.key === "f" || e.key === "F")) {
      e.preventDefault();
      e.stopPropagation();
      openSearchPanel();
    }
  }

  searchBtnEl.addEventListener("click", () => {
    if (searchIsOpen()) closeSearchPanel();
    else openSearchPanel();
  });
  searchInputEl.addEventListener("input", () => {
    searchState.query = searchInputEl.value;
    refreshSearchResults(true, true);
  });
  searchInputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      goToSearchMatch(e.shiftKey ? -1 : 1);
    } else if (e.key === "Escape") {
      e.preventDefault();
      closeSearchPanel();
    }
  });
  searchPrevEl.addEventListener("click", () => goToSearchMatch(-1));
  searchNextEl.addEventListener("click", () => goToSearchMatch(1));
  searchClearEl.addEventListener("click", clearSearch);
  searchCloseEl.addEventListener("click", closeSearchPanel);
  window.addEventListener("keydown", handleSearchShortcut, true);
  syncSearchControls();

  return {
    searchState,
    searchIsOpen,
    refreshMarkdownSearch,
    refreshHtmlSearch,
    refreshSearchResults,
    clearSearchHighlights,
    handleSearchShortcut,
  };
}

// ============================================================================
// Wave-2: HTML surface interactions (edit mode, iframe CSS, link handling,
// annotate/decorate/remove, annotation undo stack, annotation action menu),
// renderLoadedHtml/onHtmlReady, and the selection popover + swatches + quick
// actions (Brainstorm/Visualize).
//
// A second factory, `initHtmlSurface(deps)`, alongside wave-1's `initSearch` in
// this same file (not merged into one function — the brief's own wave-1/wave-2
// split already treats them as two independently-gated slices, and there's no
// forced reason to collapse two already-working, independently-testable
// closures into one).
//
// `annoKey` (editor.ts's singleton annotation-decoration PluginKey),
// `swatchByName`/`PALETTE`/`COMMENT_COLOR` (the highlight/comment color
// palette), and `nextMermaidSeq` all cross into this module WITHOUT an
// editor.ts import, per the plan's "modules never import each other" rule —
// same by-value precedent `searchKey` already set above. `Swatch` and
// `LoadedAnno` are redeclared locally rather than imported (the `SearchMeta`
// precedent from Task 2: a pure compile-time shape, cheap to duplicate, keeps
// this module import-free of editor.ts). `ProposalView` mirrors proposals.ts's
// own type of the same name for the same reason (see that file's header) — the
// two are structurally identical by design, just declared in two files that
// must not import each other.
//
// `commentSeq` (the per-doc comment-numbering counter) moves fully into this
// module in Task 5: `annotate`/`annotateHtml`/`renderLoadedHtml` (its only
// three mutators) all live here now, so it's no longer main.ts-owned. Exposed
// as `nextCommentSeq`/`resetCommentSeq` for editor.ts's proposal-widget deps
// and chat.ts's `resetChat()` respectively (both still reach it through deps —
// see main.ts's wiring).
//
// `removeAnnotationById` (backend delete + in-document decoration + comment-
// registry cleanup) also moves fully in: its only OTHER main.ts-side caller,
// `undoLastAnnotation`, is itself part of the annotation-undo stack moving
// here, so main.ts no longer needs to own it. chat.ts's comment-card Delete
// button still reaches it via `deps.removeAnnotationById` (now a forward
// reference to this module's result — see main.ts's wiring).
//
// `resetDocumentViewport`/`captureActiveHtmlEdits`/`tabContent` are textually
// adjacent to this region in the pre-split file but are tabs-domain (they
// close over `activeIdx`/`tabs`) — they move to shell.ts instead, alongside
// the tabs array itself.

/** Mirrors editor.ts's Swatch shape — see file header. */
interface Swatch {
  name: string;
  bg: string;
  edge: string;
}

/** Mirrors editor.ts's `LoadedAnno` (the canonical protocol `Annotation` plus the two fields the handler joins in for comment threads). */
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

export interface HtmlSurfaceDeps {
  api: DocdApi;
  log: (line: string) => void;
  getDocPath: () => string | undefined;
  getFormat: () => "markdown" | "html";
  getEditor: () => Editor | null;
  getHtmlSurface: () => HtmlSurface | null;
  /** The milkdown mount point (`#editor`), shared with editor.ts/this file's initSearch (same DOM node). */
  rootEl: HTMLDivElement;
  htmlHostEl: HTMLDivElement;
  /** shell.ts-owned once tabs move there in this task's Step 3. */
  reloadActiveDoc: () => Promise<void>;
  /** The active tab's live markdown text (Visualize's Insert-into-doc source). shell.ts-owned once tabs move there. */
  getCurrentMarkdown: () => string;

  // editor.ts values, passed by reference — see file header.
  annoKey: PluginKey;
  swatchByName: (name: string | undefined, fallback: Swatch) => Swatch;
  PALETTE: Swatch[];
  COMMENT_COLOR: Swatch;
  nextMermaidSeq: () => number;

  // This file's own initSearch() result, threaded through by main.ts.
  searchIsOpen: () => boolean;
  searchState: SearchState;
  refreshMarkdownSearch: (resetActive?: boolean, scroll?: boolean) => void;
  refreshHtmlSearch: (resetActive?: boolean, scroll?: boolean) => void;
  handleSearchShortcut: (e: KeyboardEvent) => void;

  // doc-zoom.ts (main.ts constructs it directly — see that module's file header).
  /** Also wired onto the HTML iframe's own document below, mirroring handleSearchShortcut/handleResolveShortcut. */
  handleZoomShortcut: (e: KeyboardEvent) => void;
  /** Apply the current document zoom to a freshly-loaded iframe document (mirrors the static HAD_IFRAME_CSS injection just below). */
  applyDocZoom: (doc: Document) => void;
  /** Wire trackpad pinch (ctrlKey wheel + WebKit GestureEvent) onto the iframe's own document below — its own browsing context, so wheel/gesture events over its rendered content never reach the parent page and it needs its own listener, same reasoning as handleZoomShortcut/applyDocZoom just above. */
  wirePinchZoom: (target: EventTarget) => void;

  // proposals.ts
  routeProposal: (e: RpcEvent) => boolean;
  renderProposalHtml: (p: ProposalView) => void;
  openDiffPanel: (p: ProposalView) => Promise<void>;

  // chat.ts
  promoteToChat: (id: string) => Promise<void>;
  /**
   * meta/ctrl+click on an annotation span (markdown `.had-mark` or the HTML iframe's
   * own marks) — jump to its conversation, bypassing the annotation action menu.
   * promoteToChat vs. a read-only thread view is chat.ts's call. Phase-8 T4.
   */
  onAnnotationJump: (id: string) => void | Promise<void>;
  addCommentCard: (
    id: string,
    quoted: string,
    body?: string,
    num?: number,
    author?: string,
    resolved?: boolean,
    reviewMeta?: { origin?: string; severity?: string; kind?: string },
  ) => void;
  hasComment: (id: string) => boolean;
  getCommentQuoted: (id: string) => string | undefined;
  registerBranchEntry: (branchId: string, quoted: string, parentId: string) => void;
  /** shell.ts's right-rail un-collapse (Phase 11 T1). Called only from the selection popover's Comment button — NOT from persisted-annotation replay (renderLoaded/renderLoadedHtml), which is a data-load path, not a live user action; see shell.ts's sidebar-toggle section for the exception's full rationale. */
  uncollapseRightRail: () => void;
  removeCommentEntry: (id: string) => void;
  chatTurnWithAction: (label: string, onClick: () => void) => void;
  handleResolveShortcut: (e: KeyboardEvent) => void;
  activateChatPane: (id: string, quoted: string) => void;
  chatTurn: (role: "you", text: string) => HTMLDivElement;
  streamingAgentTurn: (meta?: string) => {
    onEvent: (e: RpcEvent) => void;
    done: (finalText?: string) => void;
    fail: (msg: string) => void;
  };
  setChip: (id: string, status: "idle" | "running" | "responded" | "error") => void;
  setChatBusy: (threadId: string | null) => void;
  markDiscussed: (id: string) => void;
  focusCommentInput: (id: string) => void;
  runImprove: (id: string) => Promise<void>;
  modelName: (key: string) => string;
  getStance: () => string;
  getModelId: () => string | undefined;
  appendCustomTurn: (box: HTMLElement) => void;
  scrollTurnsToBottom: () => void;
}

export interface HtmlSurfaceApi {
  showHtmlSurface(): void;
  showMarkdownSurface(): void;
  setHtmlEditMode(on: boolean): void;
  setEditToggleVisible(visible: boolean): void;
  onHtmlReady(): Promise<void>;
  updateHtmlPopover(): void;
  removeAnnotationById(id: string): Promise<void>;
  clearAnnotationUndo(): void;
  nextCommentSeq(): number;
  resetCommentSeq(): void;
}

/**
 * Insert a fenced block into the doc markdown as its own paragraph, right after
 * the line containing the anchor's matched text (separated by blank lines). Uses
 * `resolveAnchor` (fuzzy-tolerant) to locate the selection in the raw markdown,
 * which correctly handles inline formatting (e.g. `**bold**` → anchor.exact "bold")
 * and multi-paragraph selections (anchor uses single `\n`; markdown uses `\n\n`).
 * Falls back to appending at the document end when the anchor does not resolve.
 *
 * Exported at module level so it can be unit-tested independently of `initHtmlSurface`.
 */
export function insertBlockAfterQuote(
  markdown: string,
  anchor: TextQuoteAnchor,
  block: string,
): string {
  const range = resolveAnchor(markdown, anchor);
  if (!range) {
    return markdown.replace(/\s*$/, "") + `\n\n${block}\n`;
  }
  // Advance to the end of the line containing the matched span.
  const lineEnd = markdown.indexOf("\n", range.end);
  const insertAt = lineEnd === -1 ? markdown.length : lineEnd;
  const before = markdown.slice(0, insertAt);
  const after = markdown.slice(insertAt);
  return `${before}\n\n${block}\n${after}`;
}

export function initHtmlSurface(deps: HtmlSurfaceDeps): HtmlSurfaceApi {
  const popover = document.querySelector<HTMLDivElement>("#popover")!;
  const htmlEditToggle = document.querySelector<HTMLButtonElement>("#htmlEditToggle")!;

  // comments are numbered 1..N per open document. Fully region-local now (Task 5) —
  // see file header.
  let commentSeq = 0;

  /** Show the iframe HTML surface and hide the markdown (Milkdown) editor. */
  function showHtmlSurface(): void {
    deps.rootEl.style.display = "none";
    deps.htmlHostEl.hidden = false;
    deps.getHtmlSurface()?.show();
  }
  /** Show the markdown (Milkdown) editor and hide the iframe HTML surface. */
  function showMarkdownSurface(): void {
    deps.htmlHostEl.hidden = true;
    deps.getHtmlSurface()?.hide();
    deps.rootEl.style.display = "";
  }

  // HTML Edit/Review toggle. Review (default) keeps the doc a normal interactive page so
  // links, buttons, and scripts work and clicks behave; Edit turns on WYSIWYG editing.
  // Highlight/comment work in both modes (selection doesn't require contenteditable).
  let htmlEditMode = false;
  function setHtmlEditMode(on: boolean): void {
    htmlEditMode = on;
    deps.getHtmlSurface()?.setEditable(on);
    htmlEditToggle.textContent = on ? "✓ Done" : "✎ Edit";
    htmlEditToggle.classList.toggle("editing", on);
    htmlEditToggle.title = on
      ? "Editing on — links/scripts are inert while you edit. Click to return to review."
      : "Turn on WYSIWYG editing for this HTML document.";
  }
  htmlEditToggle.addEventListener("click", () => setHtmlEditMode(!htmlEditMode));
  function setEditToggleVisible(visible: boolean): void {
    htmlEditToggle.hidden = !visible;
  }

  /** CSS injected into the iframe so highlight/comment marks + badges render there. */
  const HAD_IFRAME_CSS = `
.had-mark { border-radius: 3px; }
.had-mark.had-highlight { box-decoration-break: clone; -webkit-box-decoration-break: clone; }
.had-mark.had-comment { box-decoration-break: clone; -webkit-box-decoration-break: clone; cursor: pointer; }
.had-mark.focus { outline: 2px solid #1458a8; outline-offset: 1px; }
.had-search-match {
  border-radius: 3px;
  background: rgba(255, 220, 92, 0.58);
  box-shadow: 0 0 0 1px rgba(138, 92, 0, 0.16);
  box-decoration-break: clone;
  -webkit-box-decoration-break: clone;
}
.had-search-match.active {
  background: rgba(255, 178, 64, 0.9);
  box-shadow: 0 0 0 1px rgba(138, 92, 0, 0.46), 0 0 0 4px rgba(255, 178, 64, 0.22);
}
.had-badge {
  display: inline-block; min-width: 1.05em; height: 1.05em; line-height: 1.05em;
  padding: 0 0.3em; margin-left: 2px; border-radius: 999px; color: #fff;
  font: 700 0.62em/1.05em -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  text-align: center; vertical-align: super; cursor: pointer;
}`;

  /** Position the popover over the current iframe selection (HTML surface). */
  let lastHtmlSelectionRange: Range | null = null;
  function updateHtmlPopoverImpl(): void {
    if (deps.getFormat() !== "html") return;
    const doc = deps.getHtmlSurface()?.doc;
    const frame = deps.getHtmlSurface()?.frameEl;
    if (!doc || !frame) return void (popover.hidden = true);
    const sel = doc.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return void (popover.hidden = true);
    lastHtmlSelectionRange = sel.getRangeAt(0).cloneRange();
    const r = sel.getRangeAt(0).getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return void (popover.hidden = true);
    const fr = frame.getBoundingClientRect();
    positionPopoverForRect({
      top: fr.top + r.top,
      bottom: fr.top + r.bottom,
      left: fr.left + r.left,
      width: r.width,
    });
  }
  const updateHtmlPopover: () => void = updateHtmlPopoverImpl;

  function htmlLinkFromEvent(e: MouseEvent): HTMLAnchorElement | null {
    const target = e.target as Element | null;
    return target?.closest?.("a[href]") as HTMLAnchorElement | null;
  }

  function scrollHtmlHashLink(doc: Document, hash: string): void {
    let id = hash.slice(1);
    try {
      id = decodeURIComponent(id);
    } catch {
      // Keep the raw fragment when the page authored an invalid escape sequence.
    }
    const target = doc.getElementById(id) ?? doc.getElementsByName(id)[0];
    target?.scrollIntoView({ block: "start" });
  }

  function localPathFromFileUrl(url: URL): string {
    const path = decodeURIComponent(url.pathname);
    if (url.hostname) return `//${url.hostname}${path}`;
    return /^\/[A-Za-z]:/.test(path) ? path.slice(1) : path;
  }

  async function openHtmlLink(url: URL): Promise<void> {
    if (url.protocol === "file:") {
      await openPath(localPathFromFileUrl(url));
      return;
    }
    await openUrl(url.href);
  }

  function handleHtmlLinkClick(e: MouseEvent): void {
    const doc = deps.getHtmlSurface()?.doc;
    const anchor = htmlLinkFromEvent(e);
    if (!doc || !anchor) return;
    if (e.button !== 0) return;

    // In edit mode, keep links inert so a click places the caret instead of navigating.
    if (htmlEditMode) {
      e.preventDefault();
      return;
    }

    const rawHref = anchor.getAttribute("href")?.trim();
    if (!rawHref || rawHref.startsWith("javascript:")) return;

    if (rawHref.startsWith("#")) {
      e.preventDefault();
      scrollHtmlHashLink(doc, rawHref);
      return;
    }

    let url: URL;
    try {
      url = new URL(rawHref, doc.baseURI);
    } catch {
      deps.log(`open link failed: invalid URL "${rawHref}"`);
      return;
    }
    if (!["http:", "https:", "mailto:", "tel:", "file:"].includes(url.protocol)) return;

    e.preventDefault();
    e.stopPropagation();
    void openHtmlLink(url).catch((err) => reportError("open link", err, deps.log));
  }

  /** Decorate one resolved annotation inside the iframe (highlight fill or comment tint + badge). */
  function decorateHtmlAnno(
    doc: Document,
    anchor: TextQuoteAnchor,
    id: string,
    kind: "highlight" | "comment",
    color: Swatch,
    num?: number,
  ): boolean {
    const proj = buildHtmlProjection(doc.body);
    const r = resolveAnchor(proj.text, anchor);
    if (!r) return false;
    const range = rangeForOffsets(doc, proj, r.start, r.end);
    if (!range) return false;
    const spans = wrapRange(doc, range, () => {
      const span = doc.createElement("span");
      span.setAttribute("data-had-mark", "");
      span.setAttribute("data-anno", id);
      if (kind === "comment") {
        span.className = "had-mark had-comment";
        span.style.background = `${color.bg}55`;
      } else {
        span.className = "had-mark had-highlight";
        span.style.background = color.bg;
        span.style.boxShadow = `inset 0 -2px 0 ${color.edge}`;
      }
      return span;
    });
    if (kind === "comment" && spans[0]) {
      const badge = doc.createElement("span");
      badge.className = "had-badge";
      badge.setAttribute("data-had-overlay", ""); // stripped on serialize
      badge.style.background = color.edge;
      badge.textContent = num != null ? String(num) : "•";
      badge.addEventListener("mousedown", (e) => e.preventDefault());
      badge.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        void deps.promoteToChat(id);
      });
      spans[0].appendChild(badge);
    }
    // Clicking the marked text opens the action menu (open discussion / remove). The badge
    // (comments) keeps its own click → open chat and stops propagation, so it isn't shadowed.
    // meta/ctrl+click bypasses the menu entirely and jumps straight to the conversation
    // (Phase-8 T4) — same marker, same target, just skipping the intermediate menu.
    const frame = deps.getHtmlSurface()?.frameEl;
    for (const span of spans) {
      span.addEventListener("click", (e) => {
        e.stopPropagation();
        if (e.metaKey || e.ctrlKey) {
          void deps.onAnnotationJump(id);
          return;
        }
        const fr = frame?.getBoundingClientRect();
        openAnnoMenuForElement(span, fr ? { left: fr.left, top: fr.top } : undefined);
      });
    }
    return spans.length > 0;
  }

  /** Create a highlight/comment from the current iframe selection (HTML surface). */
  async function annotateHtml(
    kind: "highlight" | "comment",
    color: Swatch,
  ): Promise<{ id: string; quoted: string; anchor: TextQuoteAnchor } | null> {
    const doc = deps.getHtmlSurface()?.doc;
    if (!doc) return null;
    const sel = doc.getSelection();
    const selectedRange =
      sel && !sel.isCollapsed && sel.rangeCount > 0 ? sel.getRangeAt(0) : lastHtmlSelectionRange;
    if (!selectedRange) {
      deps.log(`${kind}: no selection`);
      return null;
    }
    const proj = buildHtmlProjection(doc.body);
    const offs = offsetsForRange(proj, selectedRange);
    popover.hidden = true;
    if (!offs) {
      deps.log(`${kind}: no selection`);
      return null;
    }
    const anchor = createAnchor(proj.text, offs.start, offs.end);
    const quoted = proj.text.slice(offs.start, offs.end);

    let id = "";
    let author: string | undefined;
    if (deps.getDocPath()) {
      try {
        const created = await deps.api.createAnnotation({ kind, anchor, color: color.name });
        id = created.id;
        author = created.author;
        deps.log(`persisted ${kind} ${id} (${color.name})`);
      } catch (e) {
        deps.log(`persist FAILED: ${String(e)}`);
        return null;
      }
    } else {
      id = `local-${Date.now()}`;
    }

    const num = kind === "comment" ? ++commentSeq : undefined;
    sel?.removeAllRanges(); // clear so the decoration wrap isn't fighting the live selection
    lastHtmlSelectionRange = null;
    decorateHtmlAnno(doc, anchor, id, kind, color, num);
    if (kind === "comment") deps.addCommentCard(id, quoted, "", num!, author);
    pushAnnotationUndo(id, kind);
    return { id, quoted, anchor };
  }

  /** Dispatch annotate to the active surface (markdown editor vs HTML iframe). */
  function annotateActive(
    kind: "highlight" | "comment",
    color: Swatch,
  ): Promise<{ id: string; quoted: string; anchor: TextQuoteAnchor } | null> {
    return deps.getFormat() === "html" ? annotateHtml(kind, color) : annotate(kind, color);
  }

  /** Remove an annotation's in-document decoration from whichever surface is active. */
  function removeAnnotationDecoration(id: string): void {
    if (deps.getFormat() === "html") {
      const doc = deps.getHtmlSurface()?.doc;
      if (doc) unwrapAnno(doc, id);
      return;
    }
    deps.getEditor()?.action((ctx) => {
      const view: EditorView = ctx.get(editorViewCtx);
      view.dispatch(view.state.tr.setMeta(deps.annoKey, { remove: id }));
    });
  }

  /**
   * Fully remove an annotation: backend delete + in-document decoration + (for comments)
   * its margin card, branch children, and the chat pane if it was active. Shared by the
   * card Delete button and annotation-undo.
   */
  async function removeAnnotationById(id: string): Promise<void> {
    if (deps.getDocPath()) {
      try {
        await deps.api.deleteAnnotation({ id });
      } catch (e) {
        return void reportError("delete", e, deps.log);
      }
    }
    removeAnnotationDecoration(id);
    deps.removeCommentEntry(id);
  }

  // Annotation-level undo. Highlights/comments are not document text edits — in the HTML
  // surface they wrap real DOM nodes programmatically (which the native Cmd+Z can't undo),
  // and in markdown they're decorations outside ProseMirror's history. So we track a small
  // stack of just-created annotations and let Cmd/Ctrl+Z remove the most recent one. The
  // stack is cleared on any content edit, tab switch, or chat engagement, so undo only
  // applies immediately after annotating — exactly when the user expects "undo the highlight".
  const annotationUndoStack: { id: string; kind: "highlight" | "comment" }[] = [];
  function pushAnnotationUndo(id: string, kind: "highlight" | "comment"): void {
    annotationUndoStack.push({ id, kind });
  }
  function clearAnnotationUndo(): void {
    annotationUndoStack.length = 0;
  }
  function undoLastAnnotation(): boolean {
    const last = annotationUndoStack.pop();
    if (!last) return false;
    void removeAnnotationById(last.id);
    deps.log(`undid ${last.kind} ${last.id}`);
    return true;
  }
  /** True for an undo chord (Cmd/Ctrl+Z, not redo). */
  function isUndoChord(e: KeyboardEvent): boolean {
    return (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && (e.key === "z" || e.key === "Z");
  }
  /** If an annotation can be undone, undo it and swallow the event; else let native undo run. */
  function handleAnnotationUndoKey(e: KeyboardEvent): void {
    if (!isUndoChord(e)) return;
    if (annotationUndoStack.length === 0) return; // nothing fresh → native (text) undo proceeds
    if (undoLastAnnotation()) {
      e.preventDefault();
      e.stopPropagation();
    }
  }
  // Markdown surface: focus is in the main document; capture so we run before ProseMirror's
  // history keymap (only when there's a fresh annotation to undo, else it falls through).
  window.addEventListener("keydown", handleAnnotationUndoKey, true);

  // --- annotation action menu (click a highlight/comment → open discussion / remove) ---
  // Gives a persistent way to remove a highlight (undo only works right after creating one)
  // and to open a comment's discussion. Works on both surfaces; positioned in viewport
  // coordinates so it overlays the markdown editor or the HTML iframe alike.
  let annoMenuEl: HTMLDivElement | null = null;
  function closeAnnoMenu(): void {
    annoMenuEl?.remove();
    annoMenuEl = null;
  }
  function openAnnoMenu(
    id: string,
    kind: "highlight" | "comment",
    rect: { left: number; bottom: number },
  ): void {
    closeAnnoMenu();
    const menu = document.createElement("div");
    menu.className = "annomenu";
    menu.style.left = `${Math.max(8, rect.left)}px`;
    menu.style.top = `${rect.bottom + 6}px`;
    const item = (label: string, danger: boolean, fn: () => void): void => {
      const b = document.createElement("button");
      b.className = danger ? "annomenu-item danger" : "annomenu-item";
      b.textContent = label;
      b.addEventListener("mousedown", (e) => e.preventDefault());
      b.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        closeAnnoMenu();
        fn();
      });
      menu.appendChild(b);
    };
    if (kind === "comment") item("Open discussion", false, () => void deps.promoteToChat(id));
    item(kind === "comment" ? "Remove comment" : "Remove highlight", true, () => void removeAnnotationById(id));
    document.body.appendChild(menu);
    annoMenuEl = menu;
  }
  // Dismiss on outside click (parent doc) or Escape. Clicks inside the iframe are dismissed
  // by a listener attached to the iframe document in onHtmlReady.
  document.addEventListener(
    "mousedown",
    (e) => {
      if (annoMenuEl && !annoMenuEl.contains(e.target as Node)) closeAnnoMenu();
    },
    true,
  );
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeAnnoMenu();
  });

  /** Open the action menu for an annotation mark element (shared by both surfaces). */
  function openAnnoMenuForElement(el: HTMLElement, frameOffset?: { left: number; top: number }): void {
    const id = el.getAttribute("data-anno");
    if (!id) return;
    const kind = el.classList.contains("had-comment") ? "comment" : "highlight";
    const r = el.getBoundingClientRect();
    const ox = frameOffset?.left ?? 0;
    const oy = frameOffset?.top ?? 0;
    openAnnoMenu(id, kind, { left: ox + r.left, bottom: oy + r.bottom });
  }

  // Markdown surface: delegate clicks on highlight/comment decoration spans. We don't
  // preventDefault, so normal caret placement/editing still works; the menu just appears.
  // meta/ctrl+click is editor.ts's click-jump ProseMirror plugin's job instead (it
  // resolves the annotation id from decoration state and calls onAnnotationJump
  // directly) — that plugin fires on ProseMirror's internal mousedown/mouseup click
  // detection, a DIFFERENT native event than this listener's "click", so stopping
  // propagation there doesn't reach here; this early return is what actually keeps
  // the menu from also popping up on a meta/ctrl+click (Phase-8 T4).
  deps.rootEl.addEventListener("click", (e) => {
    if (e.metaKey || e.ctrlKey) return;
    const target = (e.target as HTMLElement | null)?.closest?.(".had-mark[data-anno]") as HTMLElement | null;
    if (target) openAnnoMenuForElement(target);
  });

  /** Render persisted annotations into the iframe (HTML analogue of renderLoaded). */
  function renderLoadedHtml(annotations: LoadedAnno[]): void {
    const doc = deps.getHtmlSurface()?.doc;
    if (!doc) return;
    let placed = 0;
    let orphaned = 0;
    const branchAnnotations: LoadedAnno[] = [];
    for (const a of annotations) {
      if (a.parent) {
        branchAnnotations.push(a);
        continue;
      }
      const color = deps.swatchByName(a.color, a.type === "comment" ? deps.COMMENT_COLOR : deps.PALETTE[0]);
      const num = a.type === "comment" ? ++commentSeq : undefined;
      const ok = decorateHtmlAnno(doc, a.anchor, a.id, a.type, color, num);
      if (!ok) {
        orphaned++;
        continue;
      }
      if (a.type === "comment") {
        deps.addCommentCard(a.id, a.anchor.exact, a.body ?? "", num!, a.author, a.status === "resolved", {
          origin: a.origin,
          severity: a.review?.severity,
          kind: a.review?.kind,
        });
      }
      placed++;
    }
    for (const a of branchAnnotations) {
      if (a.parent && deps.hasComment(a.parent)) {
        deps.registerBranchEntry(a.id, deps.getCommentQuoted(a.parent) ?? a.anchor.exact, a.parent);
      } else {
        orphaned++;
      }
    }
    deps.log(`reloaded ${placed} annotation(s)${orphaned ? `, ${orphaned} orphaned` : ""}`);
  }

  /** Called when the iframe finishes loading: inject CSS + render this doc's annotations. */
  async function onHtmlReady(): Promise<void> {
    const doc = deps.getHtmlSurface()?.doc;
    if (!doc) return;
    // Focus lives inside the iframe for HTML docs, so annotation-undo (Cmd/Ctrl+Z) must be
    // handled here. Capture phase so we pre-empt the contenteditable's native undo, but only
    // when there's a fresh annotation to undo (else native text undo proceeds).
    doc.addEventListener("keydown", handleAnnotationUndoKey, true);
    doc.addEventListener("keydown", deps.handleResolveShortcut, true);
    doc.addEventListener("keydown", deps.handleSearchShortcut, true);
    doc.addEventListener("keydown", deps.handleZoomShortcut, true);
    // Trackpad pinch (ctrlKey wheel + WebKit GestureEvent) — same "own browsing
    // context needs its own listener" reasoning as the keydown handler just above.
    deps.wirePinchZoom(doc);
    // Clicks inside the iframe don't reach the parent document, so dismiss the annotation
    // menu from here too (a click on a mark re-opens it via the span's own handler).
    doc.addEventListener("mousedown", () => closeAnnoMenu(), true);
    doc.addEventListener("click", handleHtmlLinkClick);
    if (doc.head && !doc.head.querySelector("style[data-had-overlay]")) {
      const style = doc.createElement("style");
      style.setAttribute("data-had-overlay", "");
      style.textContent = HAD_IFRAME_CSS;
      doc.head.appendChild(style);
    }
    // Re-apply the current document zoom — a fresh iframe load (srcdoc navigation)
    // starts with a clean <head>, so this must run every time, not just once.
    deps.applyDocZoom(doc);
    if (deps.searchIsOpen() && deps.searchState.query.trim()) deps.refreshHtmlSearch(false, false);
    if (deps.getFormat() !== "html" || !deps.getDocPath()) return;
    const docPath = deps.getDocPath()!;
    try {
      const opened = await deps.api.openDoc({ docPath });
      if (deps.getDocPath() !== docPath || deps.getFormat() !== "html") return;
      if (opened.annotations.length) renderLoadedHtml(opened.annotations);
    } catch (e) {
      reportError("load html annotations", e, deps.log);
    }
    // Re-render pending proposals as in-iframe overlay cards (mirrors the markdown path).
    try {
      const props = await deps.api.listProposals({ docPath });
      if (deps.getDocPath() !== docPath || deps.getFormat() !== "html") return;
      for (const p of props) {
        if (p.status !== "pending") continue;
        if (p.fullText !== undefined) {
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
        if (!p.edits) continue;
        deps.renderProposalHtml({
          id: p.id,
          threadId: p.threadId,
          rationale: p.rationale,
          edits: p.edits,
          status: p.status,
        });
      }
    } catch (e) {
      reportError("load html proposals", e, deps.log);
    }
  }

  // --- markdown-surface selection popover ---
  function updatePopover(): void {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return void (popover.hidden = true);
    const range = sel.getRangeAt(0);
    if (!deps.rootEl.contains(range.commonAncestorContainer)) return void (popover.hidden = true);
    const rect = range.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return void (popover.hidden = true);
    positionPopoverForRect(rect);
  }

  /** Position the selection popover above/below a viewport-coordinate rect, clamped. */
  function positionPopoverForRect(rect: { top: number; bottom: number; left: number; width: number }): void {
    popover.hidden = false;

    const viewportPadding = 8;
    const gap = 8;
    const popWidth = popover.offsetWidth;
    const popHeight = popover.offsetHeight;
    const selectionCenter = rect.left + rect.width / 2;
    const minCenter = viewportPadding + popWidth / 2;
    const maxCenter = Math.max(minCenter, window.innerWidth - viewportPadding - popWidth / 2);
    const left = Math.min(Math.max(selectionCenter, minCenter), maxCenter);

    const minTop = window.scrollY + viewportPadding;
    const maxTop = Math.max(minTop, window.scrollY + window.innerHeight - popHeight - viewportPadding);
    const topAbove = rect.top + window.scrollY - popHeight - gap;
    const topBelow = rect.bottom + window.scrollY + gap;
    const preferredTop = topAbove >= minTop ? topAbove : topBelow;
    const top = Math.min(Math.max(preferredTop, minTop), maxTop);

    popover.style.top = `${top}px`;
    popover.style.left = `${left + window.scrollX}px`;
  }
  document.addEventListener("selectionchange", updatePopover);

  interface Captured {
    from: number;
    to: number;
    anchor: TextQuoteAnchor;
    quoted: string;
  }

  async function annotate(
    kind: "highlight" | "comment",
    color: Swatch,
  ): Promise<{ id: string; quoted: string; anchor: TextQuoteAnchor } | null> {
    const editor = deps.getEditor();
    if (!editor) return null;
    // editor.action returns its callback's value, so TS narrows `cap` correctly.
    const cap = editor.action((ctx): Captured | null => {
      const view: EditorView = ctx.get(editorViewCtx);
      const { from, to, empty } = view.state.selection;
      if (empty) return null;
      const proj = projectionOf(view);
      const sOff = offsetForPos(proj, from);
      const eOff = offsetForPos(proj, to);
      return {
        from,
        to,
        anchor: createAnchor(proj.text, sOff, eOff),
        quoted: proj.text.slice(sOff, eOff),
      };
    });
    popover.hidden = true;
    if (!cap) {
      deps.log(`${kind}: no selection`);
      return null;
    }

    let id = "";
    let author: string | undefined;
    if (deps.getDocPath()) {
      try {
        const created = await deps.api.createAnnotation({ kind, anchor: cap.anchor, color: color.name });
        id = created.id;
        author = created.author;
        deps.log(`persisted ${kind} ${id} (${color.name})`);
      } catch (e) {
        deps.log(`persist FAILED: ${String(e)}`);
        return null;
      }
    } else {
      id = `local-${Date.now()}`;
    }

    const num = kind === "comment" ? ++commentSeq : undefined;
    editor.action((ctx) => {
      const view: EditorView = ctx.get(editorViewCtx);
      view.dispatch(
        view.state.tr.setMeta(deps.annoKey, {
          from: cap.from,
          to: cap.to,
          id,
          kind,
          color,
          num,
        }),
      );
    });
    if (kind === "comment") deps.addCommentCard(id, cap.quoted, "", num!, author);
    pushAnnotationUndo(id, kind);
    return { id, quoted: cap.quoted, anchor: cap.anchor };
  }

  popover.addEventListener("mousedown", (e) => e.preventDefault());
  const popTop = document.createElement("div");
  popTop.className = "poptop";
  for (const sw of deps.PALETTE) {
    const b = document.createElement("button");
    b.className = "swatch";
    b.title = `Highlight ${sw.name}`;
    b.style.background = sw.bg;
    b.style.boxShadow = `inset 0 0 0 1.5px ${sw.edge}`;
    b.addEventListener("click", () => void annotateActive("highlight", sw));
    popTop.appendChild(b);
  }
  const sep = document.createElement("span");
  sep.className = "popsep";
  popTop.appendChild(sep);
  const commentBtn = document.createElement("button");
  commentBtn.className = "popcomment";
  commentBtn.textContent = "Comment";
  commentBtn.addEventListener("click", async () => {
    const a = await annotateActive("comment", deps.COMMENT_COLOR);
    if (a) {
      deps.uncollapseRightRail(); // creating a comment always shows the review rail (Phase 11 T1 exception)
      // Focus the new card's field so it scrolls into view and is ready to type.
      deps.focusCommentInput(a.id);
    }
  });
  popTop.appendChild(commentBtn);
  popover.appendChild(popTop);

  // --- quick actions on a selection ---
  // Each action creates a comment annotation on the selection (reusing the same
  // persistence + highlight as 💬 Comment) and then runs the matching agent flow
  // in the chat pane.

  /**
   * The persisted body of the most recently appended agent turn in `threadId` — same
   * best-effort re-fetch chat.ts's discuss/reply/panel flows use to re-render a just-
   * completed streaming bubble from the source of truth (discuss's RPC result is only
   * `{ ok: boolean }` — see protocol/rpc.ts). Returns undefined (not throw) on any
   * failure, so `bubble.done(finalText)` degrades to keeping the streamed text.
   */
  async function fetchLastAgentReply(threadId: string): Promise<string | undefined> {
    if (!deps.getDocPath()) return undefined;
    try {
      const thread = await deps.api.getThread({ threadId });
      const last = thread.turns[thread.turns.length - 1];
      return last?.role === "agent" ? last.body : undefined;
    } catch {
      return undefined;
    }
  }

  /** Stream a one-shot discuss turn into the chat pane (used by Brainstorm). */
  async function runBrainstorm(id: string, quoted: string): Promise<void> {
    if (!deps.getDocPath()) return;
    deps.activateChatPane(id, quoted);
    deps.chatTurn("you", "Brainstorm options for this passage.");
    const bubble = deps.streamingAgentTurn(deps.getStance());
    let docChanged = false;
    const modelId = deps.getModelId();
    deps.setChip(id, "running");
    deps.setChatBusy(id); // show Stop; cancelKey for discuss is docPath#<id>
    try {
      await deps.api.discuss(
        {
          threadId: id,
          annotationId: id,
          stance: deps.getStance(),
          comment:
            "Brainstorm options, alternatives, and improvements for this passage. Give a concise bulleted list.",
          ...(modelId ? { modelId } : {}),
        },
        (e: RpcEvent) => {
          if (deps.routeProposal(e)) return;
          if (e.event === "docChanged") docChanged = true;
          else bubble.onEvent(e);
        },
      );
      bubble.done(await fetchLastAgentReply(id));
      deps.markDiscussed(id);
      deps.setChip(id, "responded");
      if (docChanged) {
        deps.log("agent edited the document — reloading");
        await deps.reloadActiveDoc();
      }
    } catch (e) {
      bubble.fail(String(e));
      deps.setChip(id, "error");
      reportError("brainstorm", e, deps.log);
    } finally {
      deps.setChatBusy(null);
    }
  }

  /**
   * Extract a fenced code block (```…```) from an agent reply, dropping any
   * surrounding prose. Takes from the first ``` fence to its matching closer; if
   * there's no complete fence, returns the whole reply trimmed.
   */
  function extractFencedBlock(reply: string): string {
    const open = reply.indexOf("```");
    if (open === -1) return reply.trim();
    const close = reply.indexOf("```", open + 3);
    if (close === -1) return reply.trim();
    return reply.slice(open, close + 3).trim();
  }


  /** The mermaid source inside a ```mermaid fenced block. */
  function mermaidSource(block: string): string {
    return block.replace(/^```mermaid\s*\n?/, "").replace(/\n?```\s*$/, "").trim();
  }
  /** Render mermaid `src` into `container`, falling back to showing the source on error. */
  async function renderMermaidInto(container: HTMLElement, src: string): Promise<void> {
    try {
      const { svg } = await mermaid.render(`mermaid-chat-${deps.nextMermaidSeq()}`, src);
      container.className = "mermaid-rendered";
      container.innerHTML = svg;
    } catch {
      container.className = "mermaid-error";
      container.textContent = src;
    }
  }

  /** Stream a visualize turn into a proposal-style box; offer Insert into doc. */
  async function runVisualize(id: string, quoted: string, anchor: TextQuoteAnchor): Promise<void> {
    if (!deps.getDocPath()) return;
    deps.activateChatPane(id, quoted);
    const box = document.createElement("div");
    box.className = "proposal";
    box.innerHTML = `<div class="ptitle">Proposed diagram</div>
    <div class="dpreview"></div>
    <pre class="pnew"></pre>
    <div class="pacts"><button class="papply" disabled>Insert into doc</button><button class="preject">Reject</button></div>`;
    const preview = box.querySelector<HTMLDivElement>(".dpreview")!;
    const pre = box.querySelector<HTMLPreElement>(".pnew")!;
    const insertBtn = box.querySelector<HTMLButtonElement>(".papply")!;
    box.querySelector<HTMLButtonElement>(".preject")!.addEventListener("click", () => box.remove());
    deps.appendCustomTurn(box);

    deps.setChatBusy(id); // show Stop; cancelKey for visualize is docPath#<id>
    let result: { diagram: string };
    try {
      result = await deps.api.visualize({ threadId: id }, (e) => {
        if (e.event === "token") {
          pre.textContent += String(e.data);
          deps.scrollTurnsToBottom();
        }
      });
    } catch (e) {
      pre.textContent = `⚠ ${String(e)}`;
      return;
    } finally {
      deps.setChatBusy(null);
    }

    const block = extractFencedBlock(result.diagram);
    if (!block.trim()) {
      pre.className = "pnew empty-reply";
      pre.textContent =
        `⚠ No diagram from ${deps.modelName(deps.getModelId() ?? "") || "the model"} — it returned no content.` +
        " Check the model in File ▸ Settings: a wrong/forbidden model id, an unreachable" +
        " gateway, or rate-limiting all look like this.";
      return; // nothing to render or insert
    }
    pre.textContent = block; // show the clean fenced source under the rendered preview
    void renderMermaidInto(preview, mermaidSource(block)); // show the actual diagram
    insertBtn.disabled = false;
    insertBtn.addEventListener("click", async () => {
      const docPath = deps.getDocPath();
      if (!docPath) return;
      insertBtn.disabled = true;
      try {
        const newMarkdown = insertBlockAfterQuote(deps.getCurrentMarkdown(), anchor, block);
        await deps.api.saveDoc({ text: newMarkdown });
        deps.log(`inserted diagram for ${id}`);
        box.remove();
        await deps.reloadActiveDoc();
      } catch (e) {
        reportError("diagram insert", e, deps.log);
        insertBtn.disabled = false;
      }
    });
  }

  interface QuickAction {
    label: string;
    run: (a: { id: string; quoted: string; anchor: TextQuoteAnchor }) => Promise<void>;
  }
  const QUICK_ACTIONS: QuickAction[] = [
    { label: "Improve", run: async (a) => { deps.activateChatPane(a.id, a.quoted); await deps.runImprove(a.id); } },
    { label: "Visualize", run: (a) => runVisualize(a.id, a.quoted, a.anchor) },
    { label: "Brainstorm", run: (a) => runBrainstorm(a.id, a.quoted) },
    { label: "Discuss", run: (a) => deps.promoteToChat(a.id) },
  ];

  const popActions = document.createElement("div");
  popActions.className = "popactions";
  for (const qa of QUICK_ACTIONS) {
    const b = document.createElement("button");
    b.className = "popaction";
    b.textContent = qa.label;
    b.addEventListener("click", async () => {
      popover.hidden = true;
      const a = await annotateActive("comment", deps.COMMENT_COLOR);
      if (!a) return;
      // Quick actions create a comment card like the Comment button does, so the
      // same un-collapse rule applies (their chat-side un-collapse happens via
      // activateChatPane/promoteToChat inside run()).
      deps.uncollapseRightRail();
      await qa.run(a);
    });
    popActions.appendChild(b);
  }
  popover.appendChild(popActions);

  // --- end selection popover / quick actions ---

  return {
    showHtmlSurface,
    showMarkdownSurface,
    setHtmlEditMode,
    setEditToggleVisible,
    onHtmlReady,
    updateHtmlPopover,
    removeAnnotationById,
    clearAnnotationUndo,
    nextCommentSeq: () => ++commentSeq,
    resetCommentSeq: () => {
      commentSeq = 0;
    },
  };
}
