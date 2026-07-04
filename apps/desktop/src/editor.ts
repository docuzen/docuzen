// The Milkdown/ProseMirror editor: the 6 plugins (annotation overlay, inline
// proposal overlay, in-document search overlay, directive chip, meta/ctrl+click
// thread-jump, mermaid diagram rendering) plus rendering annotations persisted
// from a previous session.
//
// Wiring pattern: initEditor(deps) builds and returns the milkdown Editor plus
// renderLoaded()/setDirectivesWorking(). The plugins' meta-dispatch PluginKeys and
// payload interfaces are exported so main.ts (and eventually other modules, via
// deps) can set metas on them without reaching into this module's internals.
// Plugin bodies that need callbacks owned by regions still in main.ts
// (promoteToChat, the proposal widget builders, comment-card bookkeeping) reach
// them through `deps` — this module never imports main.ts.
//
// DOM-query timing: this module does no module-scope `document.querySelector`.
// The one DOM node it needs (the milkdown mount point) is queried once in
// main.ts (as before) and passed in via `deps.rootEl`, matching the existing
// leaf-module convention (html-surface.ts takes its host via constructor, not
// module scope) and keeping this module importable without a DOM.
//
// Meta/ctrl+click any agent marker -> its conversation: the click-jump plugin
// resolves WHICH annotation/directive decoration a meta/ctrl+click
// landed on (via `props.handleClick`) and reports it through `deps.onAnnotationJump`/
// `deps.onDirectiveJump` — routing that id/ordinal to promoteToChat, a read-only
// thread view, or a "never resolved" hint is chat.ts's call, reached only via deps
// (this module still never imports chat.ts). The pure position->target matching
// (`annotationIdAtPos`/`directiveOrdinalAtPos`) lives in click-jump.ts instead of
// inline here so it stays unit-testable without a DOM — see that file's header.

import { Editor, rootCtx, defaultValueCtx, editorViewCtx } from "@milkdown/kit/core";
import { commonmark, codeBlockSchema } from "@milkdown/kit/preset/commonmark";
import { gfm } from "@milkdown/kit/preset/gfm";
import { history } from "@milkdown/kit/plugin/history";
import { listener, listenerCtx } from "@milkdown/kit/plugin/listener";
import { $prose, $view } from "@milkdown/kit/utils";
import mermaid from "mermaid";
import { Plugin, PluginKey, type EditorState } from "@milkdown/kit/prose/state";
import { Decoration, DecorationSet } from "@milkdown/kit/prose/view";
import type { EditorView } from "@milkdown/kit/prose/view";
import { nord } from "@milkdown/theme-nord";
import { resolveAnchor } from "@ai-native-doc/docd/anchor";
import "@milkdown/kit/prose/view/style/prosemirror.css";
import "@milkdown/theme-nord/style.css";
import { projectionOf, buildProjection, posRangeForOffsets } from "./anchor-map.js";
import { openMermaidLightbox } from "./mermaid-lightbox.js";
import { annotationIdAtPos, directiveOrdinalAtPos, type AnnotationRange, type PosRange } from "./click-jump.js";
import type { Annotation } from "@ai-native-doc/docd/protocol";

// --- annotation decorations (overlay; auto-map through edits) ---
export const annoKey = new PluginKey("had-annotations");

export interface Swatch {
  name: string;
  bg: string;
  edge: string;
}
export const PALETTE: Swatch[] = [
  { name: "yellow", bg: "#ffe169", edge: "#c99500" },
  { name: "green", bg: "#a9e7a0", edge: "#2f8f3e" },
  { name: "blue", bg: "#a9d8ff", edge: "#1d6fb8" },
  { name: "pink", bg: "#ffb2d0", edge: "#d64f7a" },
  { name: "orange", bg: "#ffc46f", edge: "#d66b00" },
];
export const COMMENT_COLOR: Swatch = { name: "pink", bg: "#ffb2d0", edge: "#d64f7a" };
export function swatchByName(name: string | undefined, fallback: Swatch): Swatch {
  return PALETTE.find((p) => p.name === name) ?? fallback;
}

export interface AddMeta {
  from: number;
  to: number;
  id: string;
  kind: "highlight" | "comment";
  color: Swatch;
  num?: number; // 1..N comment number (comments only)
}

// --- inline editable proposals (overlay; mirrors the annotation plugin) ---
// An agent edit proposal renders INLINE: the targeted passage struck through
// (a `proposed-del` inline decoration) plus the proposed new text + Approve/Reject
// buttons in a `proposed-add` widget right after it. Decorations auto-map through
// edits. Approve applies the edit + reloads; Reject clears it (the rejection is
// delivered to the agent with the user's NEXT message — the backend queues it).
export const proposalKey = new PluginKey("had-proposals");

export interface ProposalAddMeta {
  id: string;
  threadId: string;
  rationale: string;
  // Each hunk is a located region: strike [from,to) and show `newText` green after it.
  hunks: { from: number; to: number; newText: string }[];
  fallback?: {
    at: number;
    edits: { oldText: string; newText: string }[];
    located: number;
  };
}

// --- in-document search decorations (overlay; never serialized) ---
export const searchKey = new PluginKey("doc-search");

export interface SearchDecorationMeta {
  ranges: { from: number; to: number; index: number }[];
  activeIndex: number;
}

const searchPlugin = $prose(
  () =>
    new Plugin({
      key: searchKey,
      state: {
        init: () => DecorationSet.empty,
        apply(tr, set: DecorationSet) {
          const meta = tr.getMeta(searchKey);
          if (meta === "clear") return DecorationSet.empty;
          if (meta && typeof meta === "object" && "ranges" in meta) {
            const { ranges, activeIndex } = meta as SearchDecorationMeta;
            return DecorationSet.create(
              tr.doc,
              ranges.map((r) =>
                Decoration.inline(r.from, r.to, {
                  class: `had-search-match${r.index === activeIndex ? " active" : ""}`,
                  "data-search-index": String(r.index),
                }),
              ),
            );
          }
          return set.map(tr.mapping, tr.doc);
        },
      },
      props: {
        decorations(state) {
          return searchKey.getState(state) as DecorationSet;
        },
      },
    }),
);

// --- inline directive decoration ([[ ... ]]) for the markdown surface ---
// Shows directives as a distinct chip in the document and pulses them while a directive
// pass is running, so the writer sees in-place status without leaving the text.
const directiveKey = new PluginKey("had-directives");
let directivesWorking = false;

/** Find `[[ … ]]` ranges as projection offsets (mirrors the backend detector). */
export function findDirectiveOffsets(text: string): { start: number; end: number }[] {
  const re = /\[\[(?:(?!\]\])[\s\S])+\]\]/g;
  const out: { start: number; end: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) out.push({ start: m.index, end: m.index + m[0].length });
  return out;
}

/**
 * `[[ … ]]` ranges as ProseMirror position spans, in document order. Shared by
 * directivePlugin's own decorations() below AND the click-jump plugin's ordinal
 * lookup (initEditor, further down) — both must agree on exactly the same ranges in
 * exactly the same order, so this is the one place that computes them.
 */
function directivePosRanges(state: EditorState): PosRange[] {
  const proj = buildProjection(state.doc);
  const ranges: PosRange[] = [];
  for (const d of findDirectiveOffsets(proj.text)) {
    const r = posRangeForOffsets(proj, d.start, d.end);
    if (r) ranges.push(r);
  }
  return ranges;
}

/**
 * The annotation overlay's inline "had-mark" decorations (comment/highlight) as plain
 * id ranges, for the click-jump plugin's annotation lookup. Filters to `from < to`
 * (inline decorations) so the comment badge's widget decoration — which shares the
 * same `spec.id` but always has `from === to` — never shadows the marked text itself.
 */
function annotationRanges(state: EditorState): AnnotationRange[] {
  const set = annoKey.getState(state) as DecorationSet | undefined;
  if (!set) return [];
  const out: AnnotationRange[] = [];
  for (const d of set.find()) {
    const id = (d.spec as { id?: string })?.id;
    if (d.from < d.to && id) out.push({ from: d.from, to: d.to, id });
  }
  return out;
}

const directivePlugin = $prose(
  () =>
    new Plugin({
      key: directiveKey,
      props: {
        decorations(state) {
          const decos = directivePosRanges(state).map((r) =>
            Decoration.inline(r.from, r.to, {
              class: directivesWorking ? "had-directive working" : "had-directive",
            }),
          );
          return DecorationSet.create(state.doc, decos);
        },
      },
    }),
);

// --- mermaid diagram rendering ---
// Initialize mermaid ONCE at module load. securityLevel:"strict" matters because
// diagram source can be agent-generated; "strict" sanitizes HTML and blocks scripts.
mermaid.initialize({ startOnLoad: false, theme: "default", securityLevel: "strict" });

// A simple incrementing counter gives each render a fresh DOM id (mermaid requires
// a unique id per render). Math.random/Date.now are banned in shared backend modules,
// but this is frontend UI state, so a counter is fine. Shared with main.ts's
// renderMermaidInto (the chat "Visualize" quick action also renders mermaid SVGs
// and needs ids from the SAME counter, not a second independent one) via this
// exported accessor — single source of truth, mirroring nextCommentSeq's shape.
let mermaidSeq = 0;
export function nextMermaidSeq(): number {
  return ++mermaidSeq;
}

/**
 * Add the hover-revealed "expand" button to a successfully-rendered mermaid
 * container, wired to open the full-viewport pan/zoom lightbox (see
 * mermaid-lightbox.ts). A distinct button rather than making the whole
 * diagram clickable: the diagram is an atom node view here (no contentDOM), so
 * a plain click on it already creates a ProseMirror node selection — piling
 * "click opens the lightbox" onto that SAME click would fight the selection
 * instead of complementing it. mousedown + click both stop propagation so the
 * click never reaches ProseMirror's own handling and re-triggers that
 * selection (`stopEvent` below returns `false`, i.e. this view does NOT tell
 * ProseMirror to skip its normal handling, so the guard has to live here).
 */
function addMermaidExpandButton(container: HTMLElement): void {
  const svg = container.querySelector("svg");
  if (!svg) return;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "mermaid-expand";
  btn.title = "Expand diagram";
  btn.setAttribute("aria-label", "Expand diagram");
  btn.textContent = "⤢";
  btn.addEventListener("mousedown", (e) => e.stopPropagation());
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    openMermaidLightbox(svg);
  });
  container.appendChild(btn);
}

/**
 * Node view for `code_block`. When the block's language is `mermaid`, render the
 * source as an SVG diagram (read-only presentation of the underlying text). Any
 * other language falls back to the default editable code block, so normal code
 * editing and markdown round-trip are untouched. A malformed mermaid block shows
 * its raw source in a `.mermaid-error` box — it never throws or breaks the editor.
 */
const mermaidView = $view(codeBlockSchema.node, () => (initialNode) => {
  // Non-mermaid code blocks: standard editable view (pre>code with contentDOM).
  // Returning a contentDOM keeps ProseMirror in charge of editing + serialization.
  if (initialNode.attrs.language !== "mermaid") {
    const pre = document.createElement("pre");
    const code = document.createElement("code");
    const lang = initialNode.attrs.language as string;
    if (lang) pre.dataset.language = lang;
    pre.appendChild(code);
    return {
      dom: pre,
      contentDOM: code,
      update: (updated) => updated.type.name === "code_block" && updated.attrs.language !== "mermaid",
    };
  }

  // Mermaid blocks: render the source to SVG. No contentDOM — the diagram is a
  // rendered view of the node's text, which still lives in the node and so still
  // serializes back to a ```mermaid fenced block unchanged.
  let currentSource = initialNode.textContent;
  const container = document.createElement("div");
  container.className = "mermaid-rendered";

  const showError = (source: string): void => {
    container.className = "mermaid-error";
    container.textContent = source;
  };

  const renderDiagram = (source: string): void => {
    const src = source.trim();
    if (!src) {
      container.className = "mermaid-error";
      container.textContent = "(empty mermaid block)";
      return;
    }
    const id = `mermaid-${nextMermaidSeq()}`;
    container.className = "mermaid-rendered";
    // mermaid.render is async; tolerate failure by falling back to source.
    mermaid
      .render(id, src)
      .then(({ svg }) => {
        // Guard against a stale render landing after the source changed again.
        if (source === currentSource) {
          container.innerHTML = svg;
          addMermaidExpandButton(container);
        }
      })
      .catch(() => {
        if (source === currentSource) showError(src);
      });
  };

  renderDiagram(currentSource);

  return {
    dom: container,
    // Re-render whenever the underlying source text changes; keep handling the
    // node only while it stays a mermaid code block (a language change rebuilds
    // the view via the default path).
    update: (updated) => {
      if (updated.type.name !== "code_block" || updated.attrs.language !== "mermaid") {
        return false;
      }
      const next = updated.textContent;
      if (next !== currentSource) {
        currentSource = next;
        renderDiagram(next);
      }
      return true;
    },
    // The diagram is non-editable; let ProseMirror manage selection/deletion of
    // the whole node and ignore mutations inside the injected SVG.
    ignoreMutation: () => true,
    stopEvent: () => false,
  };
});

// --- render annotations persisted from a previous session ---
// openDoc's annotations are the canonical Annotation shape plus the two fields
// the handler joins in for comment threads (had/types.ts doesn't carry these).
export type LoadedAnno = Annotation & { body?: string; parent?: string };

/** Callbacks the plugins/renderLoaded reach for, owned by regions still in main.ts. */
export interface EditorDeps {
  /** The milkdown mount point (`#editor`), queried once by main.ts (shared with surface.ts's search). */
  rootEl: HTMLElement;
  log: (line: string) => void;
  /** Reads the (still main.ts-owned) currentFormat global — used to gate directive redecoration. */
  getFormat: () => "markdown" | "html";
  /** The markdownUpdated listener body — tabs/search/log bookkeeping still lives in main.ts. */
  onMarkdownUpdated: (markdown: string, prev: string) => void;
  promoteToChat: (id: string) => void | Promise<void>;
  /**
   * meta/ctrl+click inside an annotation decoration (comment, review finding, or a
   * plain highlight) — jump to its conversation. This module only resolves WHICH
   * annotation id was clicked; routing that id to promoteToChat vs. a read-only
   * thread view is chat.ts's call. Phase-8 T4.
   */
  onAnnotationJump: (id: string) => void | Promise<void>;
  /**
   * meta/ctrl+click inside a `[[ … ]]` directive decoration — `n` is the 1-based
   * document-order ordinal among directive decorations at click time, matching
   * chat.ts's `directive-<n>` thread ids. Phase-8 T4.
   */
  onDirectiveJump: (n: number) => void | Promise<void>;
  buildProposalWidget: (p: {
    id: string;
    threadId: string;
    newText: string;
    rationale: string;
    count?: number;
  }) => HTMLElement;
  buildProposalAddOnly: (newText: string) => HTMLElement;
  buildProposalFallbackWidget: (p: {
    id: string;
    threadId: string;
    rationale: string;
    edits: { oldText: string; newText: string }[];
    located: number;
  }) => HTMLElement;
  /** Increments and returns the shared (main.ts-owned) per-doc comment counter. */
  nextCommentSeq: () => number;
  hasComment: (id: string) => boolean;
  getCommentQuoted: (id: string) => string | undefined;
  addCommentCard: (
    id: string,
    quoted: string,
    body: string | undefined,
    num: number,
    author: string | undefined,
    resolved: boolean | undefined,
    reviewMeta?: { origin?: string; severity?: string; kind?: string },
  ) => void;
  registerBranchEntry: (branchId: string, quoted: string, parentId: string) => void;
}

export interface EditorApi {
  editor: Editor;
  renderLoaded(annotations: LoadedAnno[]): void;
  /** Pulse the [[ … ]] directive chips while a resolve-directives pass runs. */
  setDirectivesWorking(on: boolean): void;
}

export async function initEditor(deps: EditorDeps): Promise<EditorApi> {
  const annotationPlugin = $prose(
    () =>
      new Plugin({
        key: annoKey,
        state: {
          init: () => DecorationSet.empty,
          apply(tr, set: DecorationSet) {
            set = set.map(tr.mapping, tr.doc);
            const meta = tr.getMeta(annoKey);
            if (meta === "clear") return DecorationSet.empty; // doc switch
            if (meta && typeof meta === "object" && "remove" in meta) {
              const id = (meta as { remove: string }).remove;
              // predicate receives the decoration SPEC (4th arg below), not attrs
              const found = set.find(
                undefined,
                undefined,
                (spec: { id?: string }) => spec?.id === id,
              );
              return set.remove(found);
            }
            const add = meta as AddMeta | undefined;
            if (add) {
              if (add.kind === "comment") {
                // PDF-review style: keep the text lightly anchored, then use one
                // numbered badge to tie it to the margin card. Avoid line-by-line
                // underlines on wrapped selections.
                const num = add.num;
                const color = add.color;
                const annoId = add.id;
                const badge = Decoration.widget(
                  add.to,
                  () => {
                    const b = document.createElement("span");
                    b.className = "had-badge";
                    b.style.setProperty("--had-badge-color", color.edge);
                    b.textContent = num != null ? String(num) : "•";
                    b.title = "Open this discussion";
                    b.addEventListener("mousedown", (e) => e.preventDefault());
                    b.addEventListener("click", (e) => {
                      // Meta/ctrl+click is handled by the click-jump plugin (its
                      // mark range covers this anchor) — bail so the same
                      // promoteToChat can't double-fire and duplicate turns.
                      if (e.metaKey || e.ctrlKey) return;
                      e.preventDefault();
                      e.stopPropagation();
                      void deps.promoteToChat(annoId);
                    });
                    return b;
                  },
                  { id: add.id, side: 1 },
                );
                set = set.add(tr.doc, [
                  Decoration.inline(
                    add.from,
                    add.to,
                    {
                      class: "had-mark had-comment",
                      "data-anno": add.id,
                      style: `background:${color.bg}40;box-shadow:0 0 0 1px ${color.edge}33`,
                    },
                    { id: add.id },
                  ),
                  badge,
                ]);
              } else {
                set = set.add(tr.doc, [
                  Decoration.inline(
                    add.from,
                    add.to,
                    {
                      class: "had-mark had-highlight",
                      "data-anno": add.id,
                      style: `background:${add.color.bg};box-shadow:0 0 0 1px ${add.color.edge}66,inset 0 -3px 0 ${add.color.edge}`,
                    },
                    { id: add.id },
                  ),
                ]);
              }
            }
            return set;
          },
        },
        props: {
          decorations(state) {
            return annoKey.getState(state) as DecorationSet;
          },
        },
      }),
  );

  const proposalPlugin = $prose(
    () =>
      new Plugin({
        key: proposalKey,
        state: {
          init: () => DecorationSet.empty,
          apply(tr, set: DecorationSet) {
            set = set.map(tr.mapping, tr.doc);
            const meta = tr.getMeta(proposalKey);
            if (meta === "clear") return DecorationSet.empty; // doc switch
            if (meta && typeof meta === "object" && "remove" in meta) {
              const id = (meta as { remove: string }).remove;
              const found = set.find(
                undefined,
                undefined,
                (spec: { proposalId?: string }) => spec?.proposalId === id,
              );
              return set.remove(found);
            }
            const add = meta as ProposalAddMeta | undefined;
            if (add && (add.hunks.length || add.fallback)) {
              // Every decoration shares the same `proposalId` spec, so the existing
              // remove-by-proposalId / "clear" handling drops them all in one go.
              const decos: Decoration[] = [];
              add.hunks.forEach((h, i) => {
                decos.push(
                  Decoration.inline(
                    h.from,
                    h.to,
                    { class: "proposed-del" },
                    { proposalId: add.id },
                  ),
                );
                // First hunk hosts the shared Approve/Reject card (its newText green +
                // the change count). Later hunks get a green-only add widget.
                const widget =
                  i === 0
                    ? Decoration.widget(
                        h.to,
                        () =>
                          deps.buildProposalWidget({
                            id: add.id,
                            threadId: add.threadId,
                            newText: h.newText,
                            rationale: add.rationale,
                            count: add.hunks.length,
                          }),
                        { side: 1, proposalId: add.id },
                      )
                    : Decoration.widget(h.to, () => deps.buildProposalAddOnly(h.newText), {
                        side: 1,
                        proposalId: add.id,
                      });
                decos.push(widget);
              });
              if (add.fallback) {
                decos.push(
                  Decoration.widget(
                    add.fallback.at,
                    () =>
                      deps.buildProposalFallbackWidget({
                        id: add.id,
                        threadId: add.threadId,
                        rationale: add.rationale,
                        edits: add.fallback!.edits,
                        located: add.fallback!.located,
                      }),
                    { side: 1, proposalId: add.id },
                  ),
                );
              }
              set = set.add(tr.doc, decos);
            }
            return set;
          },
        },
        props: {
          decorations(state) {
            return proposalKey.getState(state) as DecorationSet;
          },
        },
      }),
  );

  /**
   * meta/ctrl+click any agent marker (an annotation mark or a `[[ … ]]` directive
   * chip) -> its conversation, instead of the marker's plain-click behavior (caret
   * placement, or — on the markdown surface — surface.ts's annotation action menu,
   * which guards against opening on a meta/ctrl+click itself since it listens for a
   * different native event than this plugin's `handleClick` — see surface.ts's own
   * click listeners). A plain click (no modifier) returns false and changes nothing.
   */
  const clickJumpPlugin = $prose(
    () =>
      new Plugin({
        props: {
          handleClick(view, pos, event) {
            if (!(event.metaKey || event.ctrlKey)) return false;
            const annoId = annotationIdAtPos(annotationRanges(view.state), pos);
            if (annoId) {
              event.preventDefault();
              event.stopPropagation();
              void deps.onAnnotationJump(annoId);
              return true;
            }
            const ordinal = directiveOrdinalAtPos(directivePosRanges(view.state), pos);
            if (ordinal != null) {
              event.preventDefault();
              event.stopPropagation();
              void deps.onDirectiveJump(ordinal);
              return true;
            }
            return false;
          },
        },
      }),
  );

  const editor = await Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, deps.rootEl);
      ctx.set(defaultValueCtx, "");
      ctx.get(listenerCtx).markdownUpdated((_c, md, prev) => {
        deps.onMarkdownUpdated(md, prev);
      });
    })
    .config(nord)
    .use(commonmark)
    // GFM adds tables, strikethrough, task lists, and autolink on top of the
    // commonmark preset (must come after it — the gfm preset's table/strikethrough
    // schema nodes extend commonmark's base schema). Without this, a GFM table's
    // pipe syntax has no matching parser/schema and Milkdown falls back to
    // rendering it as flowed plain text with the pipes still visible.
    .use(gfm)
    .use(history)
    .use(listener)
    .use(annotationPlugin)
    .use(proposalPlugin)
    .use(searchPlugin)
    .use(directivePlugin)
    .use(clickJumpPlugin)
    .use(mermaidView)
    .create();

  /** Force the directive decorations to recompute (e.g. when the working flag flips). */
  function refreshDirectiveDecos(): void {
    if (deps.getFormat() !== "markdown") return;
    editor.action((ctx) => {
      const view: EditorView = ctx.get(editorViewCtx);
      view.dispatch(view.state.tr); // empty tx → decorations() re-runs and reads the flag
    });
  }
  function setDirectivesWorking(on: boolean): void {
    directivesWorking = on;
    refreshDirectiveDecos();
  }

  function renderLoaded(annotations: LoadedAnno[]): void {
    editor.action((ctx) => {
      const view: EditorView = ctx.get(editorViewCtx);
      const proj = projectionOf(view);
      let placed = 0;
      let orphaned = 0;
      const branchAnnotations: LoadedAnno[] = [];
      for (const a of annotations) {
        if (a.parent) {
          branchAnnotations.push(a);
          continue;
        }
        const r = resolveAnchor(proj.text, a.anchor);
        if (!r) {
          orphaned++;
          continue;
        }
        const range = posRangeForOffsets(proj, r.start, r.end);
        if (!range) {
          orphaned++;
          continue;
        }
        const color = swatchByName(a.color, a.type === "comment" ? COMMENT_COLOR : PALETTE[0]);
        const num = a.type === "comment" ? deps.nextCommentSeq() : undefined;
        view.dispatch(
          view.state.tr.setMeta(annoKey, {
            from: range.from,
            to: range.to,
            id: a.id,
            kind: a.type,
            color,
            num,
          } as AddMeta),
        );
        if (a.type === "comment") {
          deps.addCommentCard(
            a.id,
            proj.text.slice(r.start, r.end),
            a.body ?? "",
            num!,
            a.author,
            a.status === "resolved",
            {
              origin: a.origin,
              severity: a.review?.severity,
              kind: a.review?.kind,
            },
          );
        }
        placed++;
      }
      for (const a of branchAnnotations) {
        if (a.parent && deps.hasComment(a.parent)) {
          const quoted = deps.getCommentQuoted(a.parent) ?? a.anchor.exact;
          deps.registerBranchEntry(a.id, quoted, a.parent);
        } else {
          orphaned++;
        }
      }
      deps.log(`reloaded ${placed} annotation(s)${orphaned ? `, ${orphaned} orphaned` : ""}`);
    });
  }

  return { editor, renderLoaded, setDirectivesWorking };
}
