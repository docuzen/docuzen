// Test support only (never imported by the app): mount the real editor (editor.ts's
// initEditor, every plugin) on index.html's markup under happy-dom, plus small helpers
// for driving it. Behavioural tests for the document surfaces build on this.
import { vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { editorViewCtx } from "@milkdown/kit/core";
import { TextSelection } from "@milkdown/kit/prose/state";
import type { EditorView } from "@milkdown/kit/prose/view";
import type { Node as ProseNode } from "@milkdown/kit/prose/model";
import { replaceAll } from "@milkdown/kit/utils";
import { initEditor, type EditorApi, type EditorDeps } from "./editor.js";

export const bodyHtml = /<body[^>]*>([\s\S]*)<\/body>/.exec(
  readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "..", "index.html"), "utf8"),
)![1];

export interface MountedEditor extends EditorApi {
  deps: EditorDeps;
  view(): EditorView;
  setMarkdown(md: string): void;
  /** Select [from, to) by ProseMirror position. */
  select(from: number, to: number): void;
  /** The ProseMirror position of `word`'s first character (its first occurrence in document order). */
  posOf(word: string, nth?: number): number;
  /** Run the click-jump plugin's handleClick for a ⌘-click at `pos`. */
  metaClick(pos: number): boolean;
}

/** Mount the editor into `#editor` (call after putting index.html's body in the document). */
export async function mountEditor(overrides: Partial<EditorDeps> = {}): Promise<MountedEditor> {
  const deps: EditorDeps = {
    rootEl: document.querySelector<HTMLElement>("#editor")!,
    log: () => {},
    getFormat: () => "markdown",
    resolveImageSrc: (s) => s,
    readImage: async () => ({ mime: "image/png", dataBase64: "" }),
    openLink: vi.fn(async () => {}),
    onMarkdownUpdated: () => {},
    promoteToChat: vi.fn(),
    onAnnotationJump: vi.fn(),
    onDirectiveJump: vi.fn(),
    buildProposalWidget: () => document.createElement("span"),
    buildProposalAddOnly: () => document.createElement("span"),
    buildProposalFallbackWidget: () => document.createElement("span"),
    nextCommentSeq: (() => {
      let n = 0;
      return () => ++n;
    })(),
    hasComment: () => false,
    getCommentQuoted: () => undefined,
    addCommentCard: vi.fn(),
    registerBranchEntry: vi.fn(),
    ...overrides,
  };
  const api = await initEditor(deps);
  const view = (): EditorView => api.editor.action((ctx) => ctx.get(editorViewCtx));
  return {
    ...api,
    deps,
    view,
    setMarkdown: (md) => api.editor.action(replaceAll(md)),
    select(from, to) {
      const v = view();
      v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, from, to)));
    },
    posOf: (word, nth = 0) => posOf(view().state.doc, word, nth),
    metaClick(pos) {
      const v = view();
      const event = new MouseEvent("click", { metaKey: true, bubbles: true, cancelable: true });
      return Boolean(v.someProp("handleClick", (f) => f(v, pos, event)));
    },
  };
}

export function posOf(doc: ProseNode, word: string, nth = 0): number {
  let found = -1;
  let seen = 0;
  doc.descendants((node, pos) => {
    if (found !== -1) return false;
    if (!node.isText || !node.text) return true;
    let at = node.text.indexOf(word);
    while (at !== -1) {
      if (seen++ === nth) {
        found = pos + at;
        return false;
      }
      at = node.text.indexOf(word, at + 1);
    }
    return true;
  });
  if (found === -1) throw new Error(`"${word}" (#${nth}) not in the document`);
  return found;
}
