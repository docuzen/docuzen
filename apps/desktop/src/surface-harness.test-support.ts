// Test support only (never imported by the app): the document surfaces as main.ts wires
// them — the real editor (editor-harness.test-support.ts), the search panel and surface.ts —
// on index.html's markup under happy-dom, with a scripted sidecar and a stand-in for the
// HTML iframe (happy-dom does not load iframes; each "iframe document" is the document of
// its own happy-dom Window, which has a working Selection).
import { vi } from "vitest";
import { Window } from "happy-dom";
import type { DecorationSet } from "@milkdown/kit/prose/view";
import { annoKey, searchKey, PALETTE, COMMENT_COLOR, swatchByName, nextMermaidSeq } from "./editor.js";
import { initSearch, type SearchApi } from "./search-panel.js";
import { initHtmlSurface, type HtmlSurfaceApi, type HtmlSurfaceDeps } from "./surface.js";
import { bodyHtml, mountEditor, type MountedEditor } from "./editor-harness.test-support.js";

export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
}
export function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export const settle = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
};

/** A fresh "iframe document" holding `html` in its body. */
export function frameDocument(html: string): Document {
  const w = new Window();
  const doc = w.document as unknown as Document;
  doc.body.innerHTML = html;
  return doc;
}

export interface MountedSurface {
  ed: MountedEditor;
  surface: HtmlSurfaceApi;
  search: SearchApi;
  api: Record<string, ReturnType<typeof vi.fn>>;
  /** surface.ts's deps; any not set up here is a `vi.fn()` (created when first read). */
  deps: Record<string, ReturnType<typeof vi.fn>>;
  log: string[];
  /** The active document, as shell.ts would report it. */
  state: { docPath: string | undefined; format: "markdown" | "html" };
  /** What the HTML surface's iframe currently shows (null: nothing loaded). */
  html: { doc: Document | null };
  /** Ids decorated in the markdown editor right now (one per decoration). */
  annoIds(): string[];
  /** Switch to another markdown document the way shell.ts's activateTab does. */
  showMarkdown(docPath: string, md: string): void;
  /** Switch to an HTML document the way shell.ts's activateTab does; returns its document. */
  showHtml(docPath: string, html: string): Document;
  popoverButton(selector: string): HTMLButtonElement;
}

export async function mountSurface(): Promise<MountedSurface> {
  document.body.innerHTML = bodyHtml;
  const state: MountedSurface["state"] = { docPath: "/d/a.md", format: "markdown" };
  const html: MountedSurface["html"] = { doc: null };
  let seq = 0;
  const api = {
    createAnnotation: vi.fn(async (_p: unknown) => ({ id: `c${String(++seq).padStart(4, "0")}`, author: "you" })),
    deleteAnnotation: vi.fn(async (_p: unknown) => ({ ok: true })),
    openDoc: vi.fn(async (_p: unknown) => ({ text: "", format: state.format, annotations: [] as unknown[] })),
    listProposals: vi.fn(async (_p: unknown) => [] as unknown[]),
  };
  const ed = await mountEditor({ getFormat: () => state.format });
  const frameEl = document.createElement("div");
  const htmlSurface = {
    get doc() {
      return html.doc;
    },
    frameEl,
    show: () => {},
    hide: () => {},
    setEditable: vi.fn(),
    isEditable: false,
  };
  const search = initSearch({
    rootEl: ed.deps.rootEl,
    getEditor: () => ed.editor,
    getHtmlSurface: () => htmlSurface as never,
    getFormat: () => state.format,
    searchKey,
  });
  const log: string[] = [];
  const explicit: Record<string, unknown> = {
    api,
    log: (l: string) => void log.push(l),
    getDocPath: () => state.docPath,
    getFormat: () => state.format,
    getEditor: () => ed.editor,
    getHtmlSurface: () => htmlSurface,
    rootEl: ed.deps.rootEl,
    htmlHostEl: document.querySelector("#htmlHost"),
    annoKey,
    swatchByName,
    PALETTE,
    COMMENT_COLOR,
    nextMermaidSeq,
    searchIsOpen: search.searchIsOpen,
    searchState: search.searchState,
    refreshMarkdownSearch: search.refreshMarkdownSearch,
    refreshHtmlSearch: search.refreshHtmlSearch,
    handleSearchShortcut: search.handleSearchShortcut,
    hasComment: () => false,
    getCommentQuoted: () => undefined,
    beginExclusiveTurn: () => true,
  };
  const deps = new Proxy(explicit, {
    get: (target, prop: string) => (prop in target ? target[prop] : (target[prop] = vi.fn())),
  });
  const surface = initHtmlSurface(deps as unknown as HtmlSurfaceDeps);
  return {
    ed,
    surface,
    search,
    api,
    deps: deps as unknown as Record<string, ReturnType<typeof vi.fn>>,
    log,
    state,
    html,
    annoIds: () =>
      ((annoKey.getState(ed.view().state) as DecorationSet | undefined)?.find() ?? [])
        .map((d) => (d.spec as { id?: string }).id)
        .filter((id): id is string => Boolean(id)),
    showMarkdown(docPath, md) {
      state.docPath = docPath;
      state.format = "markdown";
      surface.showMarkdownSurface();
      ed.setMarkdown(md);
      ed.view().dispatch(ed.view().state.tr.setMeta(annoKey, "clear"));
    },
    showHtml(docPath, body) {
      state.docPath = docPath;
      state.format = "html";
      surface.showHtmlSurface();
      html.doc = frameDocument(body);
      return html.doc;
    },
    popoverButton: (selector) => document.querySelector<HTMLButtonElement>(`#popover ${selector}`)!,
  };
}
