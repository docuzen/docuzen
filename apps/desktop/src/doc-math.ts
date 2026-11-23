// LaTeX math support for the Milkdown/ProseMirror markdown surface:
// - `remarkMathPlugin`: remark/micromark/mdast extension for `$...$` and `$$...$$`
// - `mathBlockSchema` & `mathInlineSchema`: ProseMirror atom nodes with lossless
//   markdown round-trip (`$$...$$` single-line vs `$$\n...\n$$` multi-line, `$...$`)
// - `mathBlockView` & `mathInlineView`: KaTeX rendering in view mode + inline source
//   editing with live preview on double-click, hover `✎`, or Enter when selected
// - `mathBlockInputRule` & `mathInlineInputRule`: live WYSIWYG conversion while typing
// - `createMathCodeBlockView`: renders GitHub-style fenced ```math code blocks
import type { MilkdownPlugin } from "@milkdown/ctx";
import { InputRule } from "@milkdown/kit/prose/inputrules";
import type { Node as ProseNode } from "@milkdown/kit/prose/model";
import { NodeSelection, Plugin, PluginKey, TextSelection } from "@milkdown/kit/prose/state";
import type { EditorView, NodeView } from "@milkdown/kit/prose/view";
import { $inputRule, $nodeSchema, $prose, $remark, $view } from "@milkdown/kit/utils";
import { renderLatexInto } from "./latex-render.js";
import { remarkMath } from "./remark-math.js";

/** Remark plugin wrapping our self-contained math syntax/AST/serializer extension. */
export const remarkMathPlugin = $remark("remarkMath", () => remarkMath);

// Tracks a newly created empty math_block (via `$$ ` input rule) so its NodeView
// opens immediately into edit mode on mount without affecting loaded documents.
let pendingAutoEditMathBlock = false;

// Custom DOM event dispatched by Enter-to-edit keymap onto the selected math node DOM.
const EDIT_MATH_EVENT = "docuzen-math-edit";

/** Display math block (`$$...$$` or `$$\n...\n$$`). */
export const mathBlockSchema = $nodeSchema("math_block", () => ({
  group: "block",
  atom: true,
  selectable: true,
  isolating: true,
  marks: "",
  attrs: {
    value: { default: "", validate: "string" },
    multiline: { default: true, validate: "boolean" },
  },
  leafText: (node) => String(node.attrs.value ?? ""),
  parseDOM: [
    {
      tag: 'div[data-type="math_block"]',
      getAttrs: (dom) => {
        if (!(dom instanceof HTMLElement)) return false;
        return {
          value: dom.getAttribute("data-value") ?? dom.textContent ?? "",
          multiline: dom.getAttribute("data-multiline") !== "false",
        };
      },
    },
  ],
  toDOM: (node) => [
    "div",
    {
      class: "math-block",
      "data-type": "math_block",
      "data-value": String(node.attrs.value ?? ""),
      "data-multiline": String(Boolean(node.attrs.multiline)),
    },
    String(node.attrs.value ?? ""),
  ],
  parseMarkdown: {
    match: ({ type }) => type === "math",
    runner: (state, node, type) => {
      const value = typeof node.value === "string" ? node.value : "";
      const data = (node as { data?: { multiline?: boolean } }).data;
      const multiline = data?.multiline ?? (value.includes("\n") || value.length === 0);
      state.addNode(type, { value, multiline });
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === "math_block",
    runner: (state, node) => {
      const value = String(node.attrs.value ?? "");
      const multiline = Boolean(node.attrs.multiline) || value.includes("\n") || value.length === 0;
      state.addNode("math", undefined, value, { data: { multiline } });
    },
  },
}));

/** Inline math (`$...$`, or inline `$$...$$` when surrounded by prose on the same line). */
export const mathInlineSchema = $nodeSchema("math_inline", () => ({
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  isolating: true,
  attrs: {
    value: { default: "", validate: "string" },
    doubleDollar: { default: false, validate: "boolean" },
  },
  leafText: (node) => String(node.attrs.value ?? ""),
  parseDOM: [
    {
      tag: 'span[data-type="math_inline"]',
      getAttrs: (dom) => {
        if (!(dom instanceof HTMLElement)) return false;
        return {
          value: dom.getAttribute("data-value") ?? dom.textContent ?? "",
          doubleDollar: dom.getAttribute("data-double-dollar") === "true",
        };
      },
    },
  ],
  toDOM: (node) => [
    "span",
    {
      class: node.attrs.doubleDollar ? "math-inline math-inline-display" : "math-inline",
      "data-type": "math_inline",
      "data-value": String(node.attrs.value ?? ""),
      "data-double-dollar": String(Boolean(node.attrs.doubleDollar)),
    },
    String(node.attrs.value ?? ""),
  ],
  parseMarkdown: {
    match: ({ type }) => type === "inlineMath",
    runner: (state, node, type) => {
      const value = typeof node.value === "string" ? node.value : "";
      const data = (node as { data?: { doubleDollar?: boolean } }).data;
      state.addNode(type, { value, doubleDollar: Boolean(data?.doubleDollar) });
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === "math_inline",
    runner: (state, node) => {
      const value = String(node.attrs.value ?? "");
      const doubleDollar = Boolean(node.attrs.doubleDollar);
      state.addNode(
        "inlineMath",
        undefined,
        value,
        doubleDollar ? { data: { doubleDollar: true } } : undefined,
      );
    },
  },
}));

function autoSizeTextarea(ta: HTMLTextAreaElement): void {
  const lines = Math.max(1, ta.value.split("\n").length);
  ta.rows = Math.min(12, lines);
  ta.style.height = "auto";
  if (ta.scrollHeight > 0) ta.style.height = `${ta.scrollHeight}px`;
}

function buildBlockMathNodeView(
  initialNode: ProseNode,
  view: EditorView,
  getPos: () => number | undefined,
  options: {
    kind: "math_block" | "code_block";
    readValue: (node: ProseNode) => string;
    commitValue: (pos: number, node: ProseNode, nextValue: string) => void;
    delimiterLabel: string;
    autoEdit?: boolean;
  },
): NodeView {
  let node = initialNode;
  let currentValue = options.readValue(initialNode);
  let editing = false;

  const dom = document.createElement("div");
  dom.className = "math-block";
  dom.dataset.type = options.kind;

  const renderView = (): void => {
    editing = false;
    dom.classList.remove("editing");
    dom.replaceChildren();

    const body = document.createElement("div");
    body.className = "math-block-render";
    renderLatexInto(body, currentValue, true);

    const editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.className = "math-edit-btn";
    editBtn.title = "Edit LaTeX";
    editBtn.setAttribute("aria-label", "Edit LaTeX");
    editBtn.textContent = "✎";
    editBtn.addEventListener("mousedown", (e) => e.stopPropagation());
    editBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      enterEdit();
    });

    dom.append(body, editBtn);
  };

  const enterEdit = (): void => {
    if (editing) return;
    editing = true;
    dom.classList.add("editing");
    dom.replaceChildren();

    const editorBox = document.createElement("div");
    editorBox.className = "math-editor";

    const header = document.createElement("div");
    header.className = "math-editor-head";
    const delim = document.createElement("span");
    delim.className = "math-delim";
    delim.textContent = options.delimiterLabel;
    const hint = document.createElement("span");
    hint.className = "math-editor-hint";
    hint.textContent = "⌘↵ apply · Esc cancel";
    header.append(delim, hint);

    const textarea = document.createElement("textarea");
    textarea.className = "math-source";
    textarea.spellcheck = false;
    textarea.value = currentValue;
    textarea.placeholder = "LaTeX expression…";

    const preview = document.createElement("div");
    preview.className = "math-preview";
    renderLatexInto(preview, currentValue, true);

    let finished = false;
    const finish = (commit: boolean, refocusEditor: boolean): void => {
      if (finished) return;
      finished = true;
      const nextValue = textarea.value;
      if (commit && nextValue !== currentValue) {
        const pos = getPos();
        if (typeof pos === "number") {
          currentValue = nextValue;
          options.commitValue(pos, node, nextValue);
        }
      }
      renderView();
      if (refocusEditor) view.focus();
    };

    textarea.addEventListener("input", () => {
      autoSizeTextarea(textarea);
      renderLatexInto(preview, textarea.value, true);
    });
    textarea.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        finish(false, true);
      } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        e.stopPropagation();
        finish(true, true);
      }
    });
    textarea.addEventListener("blur", () => finish(true, false));

    editorBox.append(header, textarea, preview);
    dom.appendChild(editorBox);

    autoSizeTextarea(textarea);
    queueMicrotask(() => {
      textarea.focus();
      textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    });
  };

  dom.addEventListener("dblclick", (e) => {
    if (editing) return;
    e.preventDefault();
    e.stopPropagation();
    enterEdit();
  });
  dom.addEventListener(EDIT_MATH_EVENT, () => enterEdit());

  if (options.autoEdit) enterEdit();
  else renderView();

  return {
    dom,
    update(updated) {
      if (updated.type !== node.type) return false;
      if (options.kind === "code_block" && updated.attrs.language !== "math") return false;
      node = updated;
      const next = options.readValue(updated);
      if (next !== currentValue) {
        currentValue = next;
        if (!editing) renderView();
      }
      return true;
    },
    stopEvent: () => editing,
    ignoreMutation: () => true,
  };
}

/** NodeView for `math_block` (`$$...$$`). */
export const mathBlockView = $view(mathBlockSchema.node, () => (initialNode, view, getPos) => {
  const autoEdit = pendingAutoEditMathBlock && initialNode.attrs.value === "";
  if (autoEdit) pendingAutoEditMathBlock = false;
  return buildBlockMathNodeView(initialNode, view, getPos, {
    kind: "math_block",
    readValue: (n) => String(n.attrs.value ?? ""),
    commitValue: (pos, n, nextValue) => {
      const trimmed = nextValue.trim();
      const multiline = Boolean(n.attrs.multiline) || nextValue.includes("\n") || trimmed.length === 0;
      const value = multiline ? nextValue.replace(/^\n+|\n+$/g, "") : trimmed;
      view.dispatch(
        view.state.tr.setNodeMarkup(pos, undefined, {
          ...n.attrs,
          value,
          multiline,
        }),
      );
    },
    delimiterLabel: "$$",
    autoEdit,
  });
});

/** NodeView for fenced ```math code blocks (delegated from `editor.ts`'s `code_block` view). */
export function createMathCodeBlockView(
  initialNode: ProseNode,
  view: EditorView,
  getPos: () => number | undefined,
): NodeView {
  return buildBlockMathNodeView(initialNode, view, getPos, {
    kind: "code_block",
    readValue: (n) => n.textContent,
    commitValue: (pos, n, nextValue) => {
      const from = pos + 1;
      const to = pos + n.nodeSize - 1;
      const tr = nextValue
        ? view.state.tr.replaceWith(from, to, view.state.schema.text(nextValue))
        : view.state.tr.delete(from, to);
      view.dispatch(tr);
    },
    delimiterLabel: "```math",
  });
}

/** NodeView for `math_inline` (`$...$` / inline `$$...$$`). */
export const mathInlineView = $view(mathInlineSchema.node, () => (initialNode, view, getPos) => {
  let node = initialNode;
  let currentValue = String(initialNode.attrs.value ?? "");
  let doubleDollar = Boolean(initialNode.attrs.doubleDollar);
  let editing = false;

  const dom = document.createElement("span");
  dom.dataset.type = "math_inline";

  const renderView = (): void => {
    editing = false;
    dom.className = doubleDollar ? "math-inline math-inline-display" : "math-inline";
    renderLatexInto(dom, currentValue, doubleDollar);
  };

  const enterEdit = (): void => {
    if (editing) return;
    editing = true;
    dom.className = "math-inline editing";
    dom.replaceChildren();

    const delimText = doubleDollar ? "$$" : "$";
    const open = document.createElement("span");
    open.className = "math-delim";
    open.textContent = delimText;

    const input = document.createElement("input");
    input.type = "text";
    input.className = "math-inline-input";
    input.spellcheck = false;
    input.value = currentValue;
    const resize = (): void => {
      input.size = Math.max(4, Math.min(60, input.value.length + 1));
    };
    resize();

    const close = document.createElement("span");
    close.className = "math-delim";
    close.textContent = delimText;

    let finished = false;
    const finish = (commit: boolean, moveAfter: boolean): void => {
      if (finished) return;
      finished = true;
      const nextValue = input.value.trim();
      const pos = getPos();
      if (commit && typeof pos === "number") {
        if (!nextValue) {
          view.dispatch(view.state.tr.delete(pos, pos + node.nodeSize));
          if (moveAfter) view.focus();
          return;
        }
        if (nextValue !== currentValue) {
          currentValue = nextValue;
          const tr = view.state.tr.setNodeMarkup(pos, undefined, {
            ...node.attrs,
            value: nextValue,
          });
          if (moveAfter) tr.setSelection(TextSelection.near(tr.doc.resolve(pos + 1)));
          view.dispatch(tr);
        } else if (moveAfter) {
          view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(pos + 1))));
        }
      }
      renderView();
      if (moveAfter) view.focus();
    };

    input.addEventListener("input", resize);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        finish(false, true);
      } else if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        finish(true, true);
      }
    });
    input.addEventListener("blur", () => finish(true, false));

    dom.append(open, input, close);
    queueMicrotask(() => {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    });
  };

  dom.addEventListener("dblclick", (e) => {
    if (editing) return;
    e.preventDefault();
    e.stopPropagation();
    enterEdit();
  });
  dom.addEventListener(EDIT_MATH_EVENT, () => enterEdit());

  renderView();

  return {
    dom,
    update(updated) {
      if (updated.type !== node.type) return false;
      node = updated;
      const nextVal = String(updated.attrs.value ?? "");
      const nextDouble = Boolean(updated.attrs.doubleDollar);
      if (nextVal !== currentValue || nextDouble !== doubleDollar) {
        currentValue = nextVal;
        doubleDollar = nextDouble;
        if (!editing) renderView();
      }
      return true;
    },
    stopEvent: () => editing,
    ignoreMutation: () => true,
  };
});

/**
 * Input rule: typing `$$ ` at the start of an empty paragraph creates a `math_block`
 * and opens its LaTeX source editor immediately.
 */
export const mathBlockInputRule = $inputRule(
  (ctx) =>
    new InputRule(/^\$\$\s$/, (state, _match, start, end) => {
      const $start = state.doc.resolve(start);
      if ($start.parent.type.name !== "paragraph" || $start.parentOffset !== start - $start.start()) {
        return null;
      }
      const blockStart = $start.before();
      const blockEnd = $start.after();
      if (end !== blockEnd - 1) return null;
      pendingAutoEditMathBlock = true;
      const mathNode = mathBlockSchema.type(ctx).create({ value: "", multiline: true });
      return state.tr.replaceWith(blockStart, blockEnd, mathNode);
    }),
);

/**
 * Input rule: typing a complete single-line `$$...$$` paragraph converts it
 * immediately into a rendered `math_block` (`multiline: false`).
 */
export const mathBlockSingleLineInputRule = $inputRule(
  (ctx) =>
    new InputRule(/^\$\$([^$\n]+?)\$\$$/, (state, match, start, end) => {
      const value = match[1]?.trim();
      if (!value) return null;
      const $start = state.doc.resolve(start);
      if ($start.parent.type.name !== "paragraph" || $start.parentOffset !== start - $start.start()) {
        return null;
      }
      const blockStart = $start.before();
      const blockEnd = $start.after();
      if (end !== blockEnd - 1) return null;
      const mathNode = mathBlockSchema.type(ctx).create({ value, multiline: false });
      return state.tr.replaceWith(blockStart, blockEnd, mathNode);
    }),
);

/**
 * Input rule: typing `$x^2$ ` (or followed by punctuation other than a digit or `$`)
 * converts `$x^2$` into a rendered `math_inline` node while keeping the trailing char.
 * Waiting for a non-digit, non-`$` trailing character guarantees currency ranges like
 * `$5-$10` never falsely trigger math mid-typing.
 */
export const mathInlineInputRule = $inputRule(
  (ctx) =>
    new InputRule(
      /(^|[^\\$])\$((?:[^\s$\\]|\\\$)(?:(?:[^$\n]|\\\$)*?(?:[^\s$\\]|\\\$))?)\$([^\d$])$/,
      (state, match, start, end) => {
        const [, prefix, value, trailing] = match;
        if (!value) return null;
        const from = start + prefix.length;
        const mathNode = mathInlineSchema.type(ctx).create({ value, doubleDollar: false });
        return state.tr.replaceWith(from, end, [mathNode, state.schema.text(trailing)]);
      },
    ),
);

const mathKeymapKey = new PluginKey("had-math-keymap");

/** Press Enter while a `math_block` or `math_inline` node is selected to edit its LaTeX. */
export const mathKeymapPlugin = $prose(
  () =>
    new Plugin({
      key: mathKeymapKey,
      props: {
        handleKeyDown(view, event) {
          if (event.key !== "Enter" || event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) {
            return false;
          }
          const sel = view.state.selection;
          if (!(sel instanceof NodeSelection)) return false;
          const name = sel.node.type.name;
          if (name !== "math_block" && name !== "math_inline") return false;
          const dom = view.nodeDOM(sel.from);
          if (dom instanceof HTMLElement) {
            event.preventDefault();
            dom.dispatchEvent(new CustomEvent(EDIT_MATH_EVENT));
            return true;
          }
          return false;
        },
      },
    }),
);

/** All Milkdown plugins required for LaTeX math rendering and editing. */
export const mathPlugins: MilkdownPlugin[] = [
  remarkMathPlugin,
  mathBlockSchema,
  mathInlineSchema,
  mathBlockView,
  mathInlineView,
  mathBlockInputRule,
  mathBlockSingleLineInputRule,
  mathInlineInputRule,
  mathKeymapPlugin,
].flat();
