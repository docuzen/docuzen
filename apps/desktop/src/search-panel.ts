// The in-document search UI (markdown + HTML iframe): the search panel, its keyboard
// shortcut (⌘F), and refreshing matches against either surface.
//
// initSearch(deps) queries its own DOM elements and returns the small surface the other
// regions call: searchIsOpen / searchState / refreshMarkdownSearch / refreshHtmlSearch /
// clearSearchHighlights. The search PluginKey is owned by editor.ts (one module instance)
// and passed in via `deps.searchKey`; `SearchDecorationMeta`'s shape is redeclared here
// (`SearchMeta`) rather than imported, so this module stays decoupled from editor.ts.
// The matching itself is pure and lives in doc-search.ts.
import type { Editor } from "@milkdown/kit/core";
import { editorViewCtx } from "@milkdown/kit/core";
import type { EditorView } from "@milkdown/kit/prose/view";
import type { PluginKey } from "@milkdown/kit/prose/state";
import { projectionOf, posRangeForOffsets } from "./anchor-map.js";
import { findTextMatches, nextSearchIndex, type TextMatch } from "./doc-search.js";
import { buildHtmlProjection, rangeForOffsets, wrapRange } from "./html-projection.js";
import type { HtmlSurface } from "./html-surface.js";

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
