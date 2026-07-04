import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

// The annotation decoration plugin moved to editor.ts in the frontend split.
// Assertion semantics are unchanged; only the source file (and this one block's
// indentation, one level deeper inside initEditor()) moved.
const editorSource = readFileSync(new URL("./editor.ts", import.meta.url), "utf8");
const stylesSource = readFileSync(new URL("./styles.css", import.meta.url), "utf8");

function sourceBetween(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return source.slice(startIndex, endIndex);
}

function sourceFrom(source: string, start: string): string {
  const startIndex = source.indexOf(start);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  return source.slice(startIndex);
}

describe("annotation decoration UX", () => {
  const annotationBranch = sourceBetween(
    editorSource,
    'if (add.kind === "comment")',
    "            return set;",
  );

  it("renders comments as a subtle anchor plus one badge instead of underlining every selected line", () => {
    const commentDecoration = sourceBetween(
      annotationBranch,
      'if (add.kind === "comment")',
      "} else {",
    );

    expect(commentDecoration).toContain('className = "had-badge"');
    expect(commentDecoration).toContain('class: "had-mark had-comment"');
    expect(commentDecoration).toContain("background:${color.bg}40");
    expect(commentDecoration).toContain("box-shadow:0 0 0 1px ${color.edge}33");
    expect(commentDecoration).not.toMatch(/border-bottom|text-decoration/);
  });

  it("keeps highlights visibly filled with a stronger edge over the selected text", () => {
    const highlightDecoration = sourceFrom(annotationBranch, "} else {");

    expect(highlightDecoration).toContain("background:${add.color.bg}");
    expect(highlightDecoration).toContain("box-shadow:0 0 0 1px ${add.color.edge}66,inset 0 -3px 0 ${add.color.edge}");
  });

  it("uses wrapped inline styles instead of heavy annotation underlines", () => {
    const annotationCss = sourceBetween(
      stylesSource,
      "/* highlight / comment decorations",
      ".comments {",
    );

    expect(annotationCss).toContain(".had-highlight");
    expect(annotationCss).toContain("box-decoration-break: clone");
    expect(annotationCss).toContain("-webkit-box-decoration-break: clone");
    expect(annotationCss).not.toMatch(/\.had-comment[\s\S]*border-bottom/);
  });
});

// Meta/ctrl+click any agent marker -> its conversation. The plugin itself needs a
// live ProseMirror EditorView to exercise directly (see this file's header), so
// these are source-text pins over the click-jump plugin's wiring; the pure
// position->target matching it calls into is unit-tested directly in
// click-jump.test.ts.
describe("meta/ctrl+click thread-jump", () => {
  const clickJumpPlugin = sourceBetween(
    editorSource,
    "const clickJumpPlugin = $prose(",
    "const editor = await Editor.make()",
  );

  it("only handles meta/ctrl+click, letting a plain click fall through unchanged", () => {
    expect(clickJumpPlugin).toContain("handleClick(view, pos, event)");
    expect(clickJumpPlugin).toContain("if (!(event.metaKey || event.ctrlKey)) return false;");
  });

  it("resolves an annotation hit through onAnnotationJump and consumes the event", () => {
    const annoBranch = sourceBetween(clickJumpPlugin, "const annoId =", "const ordinal =");
    expect(annoBranch).toContain("annotationIdAtPos(annotationRanges(view.state), pos)");
    expect(annoBranch).toContain("event.preventDefault();");
    expect(annoBranch).toContain("event.stopPropagation();");
    expect(annoBranch).toContain("void deps.onAnnotationJump(annoId);");
    expect(annoBranch).toContain("return true;");
  });

  it("resolves a directive hit (by document-order ordinal) through onDirectiveJump", () => {
    const directiveBranch = sourceFrom(clickJumpPlugin, "const ordinal =");
    expect(directiveBranch).toContain("directiveOrdinalAtPos(directivePosRanges(view.state), pos)");
    expect(directiveBranch).toContain("void deps.onDirectiveJump(ordinal);");
    expect(directiveBranch).toContain("return true;");
  });

  it("is registered in the plugin chain alongside the other 5 plugins", () => {
    expect(editorSource).toContain(".use(clickJumpPlugin)");
  });

  it("shares directive-range computation with directivePlugin's own decorations (never drifts)", () => {
    expect(editorSource).toContain("function directivePosRanges(state: EditorState)");
    const directivePluginSrc = sourceBetween(
      editorSource,
      "const directivePlugin = $prose(",
      "// --- mermaid diagram rendering ---",
    );
    expect(directivePluginSrc).toContain("directivePosRanges(state)");
  });

  it("filters the annotation badge widget (from === to) out of click targets", () => {
    const annoRangesFn = sourceBetween(
      editorSource,
      "function annotationRanges(state: EditorState)",
      "const directivePlugin = $prose(",
    );
    expect(annoRangesFn).toContain("d.from < d.to");
  });
});

// GFM tables/strikethrough/tasklist/autolink on top of the commonmark preset —
// without this, a GFM table's pipe syntax has no matching schema/parser and
// Milkdown falls back to rendering it as flowed plain text with the pipes
// still visible (the reported bug). There's no jsdom/live-editor test harness
// in this package (see ui.test.ts's header) to actually mount a real Editor
// and round-trip a table through it, so — consistent with every other check
// in this file — this pins the source wiring; the interactive/visual round-trip
// and rendering checks are covered by the parity/live-boot verification.
describe("GFM support (tables, strikethrough, tasklist, autolink)", () => {
  it("imports the gfm preset from @milkdown/kit's preset/gfm export", () => {
    expect(editorSource).toContain('import { gfm } from "@milkdown/kit/preset/gfm"');
  });

  it("registers gfm AFTER commonmark (gfm's nodes/marks extend the base commonmark schema)", () => {
    const chain = sourceBetween(editorSource, ".use(commonmark)", ".use(history)");
    expect(chain).toContain(".use(gfm)");
  });
});
