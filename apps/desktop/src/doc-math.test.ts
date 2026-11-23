// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { Editor, defaultValueCtx, editorViewCtx, rootCtx } from "@milkdown/kit/core";
import { codeBlockSchema, commonmark } from "@milkdown/kit/preset/commonmark";
import { gfm } from "@milkdown/kit/preset/gfm";
import { $view, getMarkdown } from "@milkdown/kit/utils";
import { buildProjection, offsetForPos, posRangeForOffsets } from "./anchor-map.js";
import { createMathCodeBlockView, mathPlugins } from "./doc-math.js";
import { renderLatexHtml } from "./latex-render.js";
import { projectionNeedlesForHunk } from "./proposal-locate.js";

const SCREENSHOT_EQ = String.raw`T_{\text{e2e}} = \underbrace{T_{\text{detect}}}_{\text{event / poll}} + \underbrace{T_{\text{fetch}}}_{\text{cloud/SaaS APIs}} + \underbrace{T_{\text{correlate + schedule}}}_{\text{who decides what to prove?}} + \underbrace{T_{\text{prove}}}_{\text{Kleene + Z3 + repair}}`;

const mathCodeBlockView = $view(codeBlockSchema.node, () => (initialNode, view, getPos) => {
  if (initialNode.attrs.language === "math") {
    return createMathCodeBlockView(initialNode, view, getPos);
  }
  const pre = document.createElement("pre");
  const code = document.createElement("code");
  pre.appendChild(code);
  return { dom: pre, contentDOM: code };
});

async function createMathEditor(markdown: string) {
  const root = document.createElement("div");
  document.body.appendChild(root);
  const editor = await Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, root);
      ctx.set(defaultValueCtx, markdown);
    })
    .use(commonmark)
    .use(gfm)
    .use(mathCodeBlockView)
    .use(mathPlugins)
    .create();
  return {
    root,
    editor,
    markdown: () => editor.action(getMarkdown()),
    destroy: async () => {
      await editor.destroy();
      root.remove();
    },
  };
}

describe("Milkdown LaTeX rendering & round-trip", () => {
  it("renders the screenshot's single-line $$...$$ equation via KaTeX with zero <em> corruption and lossless round-trip", async () => {
    const source = `security change event from cloud mutation to verified proof:\n\n$$${SCREENSHOT_EQ}$$\n`;
    const ed = await createMathEditor(source);
    try {
      const block = ed.root.querySelector(".math-block");
      expect(block).not.toBeNull();
      expect(block!.querySelector(".katex-display")).not.toBeNull();
      expect(block!.querySelector(".katex-error")).toBeNull();
      expect(ed.root.querySelector("em")).toBeNull();
      expect(ed.markdown()).toBe(source);
    } finally {
      await ed.destroy();
    }
  });

  it("renders inline math, fenced multi-line math, and ```math code blocks while keeping currency untouched", async () => {
    const source = [
      "The latency $T_{\\text{e2e}}$ costs $5 and $10 to run.",
      "",
      "$$",
      "\\sum_{i=1}^{n} x_i = S",
      "$$",
      "",
      "```math",
      "E = mc^2",
      "```",
      "",
    ].join("\n");
    const ed = await createMathEditor(source);
    try {
      const inline = ed.root.querySelectorAll(".math-inline");
      expect(inline).toHaveLength(1);
      expect(inline[0].querySelector(".katex")).not.toBeNull();
      expect(ed.root.textContent).toContain("$5 and $10");

      const blocks = ed.root.querySelectorAll(".math-block");
      expect(blocks).toHaveLength(2);
      for (const b of blocks) {
        expect(b.querySelector(".katex-display")).not.toBeNull();
        expect(b.querySelector(".katex-error")).toBeNull();
      }

      const saved = ed.markdown();
      expect(saved).toContain("$T_{\\text{e2e}}$");
      expect(saved).toContain("$5 and $10");
      expect(saved).toContain("$$\n\\sum_{i=1}^{n} x_i = S\n$$");
      expect(saved).toContain("```math\nE = mc^2\n```");
    } finally {
      await ed.destroy();
    }
  });

  it("edits a display math block via double-click + ⌘Enter and cancels on Escape", async () => {
    const ed = await createMathEditor("$$a^2 + b^2 = c^2$$\n");
    try {
      const block = ed.root.querySelector<HTMLElement>(".math-block")!;
      block.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
      const ta = block.querySelector<HTMLTextAreaElement>("textarea.math-source")!;
      expect(ta).not.toBeNull();
      expect(ta.value).toBe("a^2 + b^2 = c^2");

      // Escape cancels without changing markdown
      ta.value = "should-discard";
      ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
      expect(ed.markdown()).toBe("$$a^2 + b^2 = c^2$$\n");

      // Hover edit button + ⌘Enter commits
      block.querySelector<HTMLButtonElement>(".math-edit-btn")!.click();
      const ta2 = block.querySelector<HTMLTextAreaElement>("textarea.math-source")!;
      ta2.value = "x^3 + y^3 = z^3";
      ta2.dispatchEvent(new Event("input", { bubbles: true }));
      expect(block.querySelector(".math-preview .katex-display")).not.toBeNull();
      ta2.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true, cancelable: true }));
      expect(ed.markdown()).toBe("$$x^3 + y^3 = z^3$$\n");
    } finally {
      await ed.destroy();
    }
  });

  it("edits an inline math node via double-click + Enter", async () => {
    const ed = await createMathEditor("Value $x^2$ here.\n");
    try {
      const span = ed.root.querySelector<HTMLElement>(".math-inline")!;
      span.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
      const input = span.querySelector<HTMLInputElement>("input.math-inline-input")!;
      expect(input).not.toBeNull();
      expect(input.value).toBe("x^2");

      input.value = "y^3";
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
      expect(ed.markdown()).toBe("Value $y^3$ here.\n");
    } finally {
      await ed.destroy();
    }
  });

  it("projects inline and block math into anchor-map without spurious newlines and supports proposal lookup", async () => {
    const ed = await createMathEditor("Measure $T_{\\text{e2e}}$ daily.\n\n$$a + b = c$$\n\nDone.\n");
    try {
      const proj = ed.editor.action((ctx) => buildProjection(ctx.get(editorViewCtx).state.doc));
      expect(proj.text).toBe("Measure $T_{\\text{e2e}}$ daily.\na + b = c\nDone.");

      const inlineStart = proj.text.indexOf("$T_{\\text{e2e}}$");
      const inlineRange = posRangeForOffsets(proj, inlineStart, inlineStart + "$T_{\\text{e2e}}$".length);
      expect(inlineRange).not.toBeNull();
      expect(inlineRange!.to - inlineRange!.from).toBe(1);
      expect(offsetForPos(proj, inlineRange!.from)).toBe(inlineStart);

      const blockStart = proj.text.indexOf("a + b = c");
      const blockRange = posRangeForOffsets(proj, blockStart, blockStart + "a + b = c".length);
      expect(blockRange).not.toBeNull();
      expect(blockRange!.to - blockRange!.from).toBe(1);

      // Proposal lookup needles strip $$ fences to match the block projection.
      expect(projectionNeedlesForHunk("$$a + b = c$$")).toContain("a + b = c");
      expect(projectionNeedlesForHunk("$$\na + b = c\n$$")).toContain("a + b = c");
    } finally {
      await ed.destroy();
    }
  });

  it("renders malformed or untrusted LaTeX safely without throwing or emitting links", () => {
    const bad = renderLatexHtml("\\frac{1", true);
    expect(bad).toContain("katex-error");

    const loop = renderLatexHtml("\\def\\a{\\a}\\a", false);
    expect(loop).toContain("katex-error");

    const xss = renderLatexHtml("\\href{javascript:alert(1)}{click}", false);
    const wrap = document.createElement("div");
    wrap.innerHTML = xss;
    expect(wrap.querySelector("a, script, img")).toBeNull();
  });

  it("opens edit mode on Enter when a math_block or math_inline node is selected", async () => {
    const { NodeSelection } = await import("@milkdown/kit/prose/state");
    const ed = await createMathEditor("$$x^2$$\n\nInline $y^2$ text.\n");
    try {
      ed.editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        // Select math_block at pos 0
        view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, 0)));
        const handled = view.someProp("handleKeyDown", (f) =>
          f(view, new KeyboardEvent("keydown", { key: "Enter", cancelable: true })),
        );
        expect(handled).toBe(true);
      });
      expect(ed.root.querySelector(".math-block textarea.math-source")).not.toBeNull();
    } finally {
      await ed.destroy();
    }
  });
});
