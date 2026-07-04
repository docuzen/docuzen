import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

// Regression pin for the ASCII-diagram-in-code-block rendering bug: fenced code
// blocks in the document editor were rendering in a proportional font with
// wrapped lines, destroying box-drawing diagrams (┌─│└ …). Root cause was two
// interacting rules in styles.css:
//
//   1. theme-nord's own base CSS sets `.ProseMirror pre { white-space: pre-wrap }`,
//      soft-wrapping long lines instead of letting the block scroll.
//   2. The "Review-canvas stabilization layer" section (added later in the
//      cascade) swept `#editor .ProseMirror code`/`pre` into a broad sans-serif
//      font-family override intended for buttons/inputs/etc., silently
//      clobbering the monospace override declared earlier in the same file.
//

const stylesSource = readFileSync(new URL("./styles.css", import.meta.url), "utf8");

function sourceBetween(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return source.slice(startIndex, endIndex);
}

describe("document editor code block typography (ASCII diagrams survive)", () => {
  it("keeps #editor .ProseMirror pre monospace, non-wrapping, and horizontally scrollable", () => {
    const preRule = sourceBetween(
      stylesSource,
      "#editor .ProseMirror pre {",
      "#editor .ProseMirror pre code {",
    );
    expect(preRule).toContain("white-space: pre;");
    expect(preRule).toContain("overflow-x: auto;");
    expect(preRule).toContain("tab-size: 4;");
    expect(preRule).toContain("font-variant-ligatures: none;");
    expect(preRule).not.toContain("pre-wrap");
  });

  it("keeps #editor .ProseMirror code on a real monospace stack", () => {
    const codeRule = sourceBetween(
      stylesSource,
      "#editor .ProseMirror code {",
      "/* Fenced/block code must never reflow",
    );
    expect(codeRule).toContain(
      "font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;",
    );
  });

  it("does not let the later sans-serif override group reclaim #editor code/pre", () => {
    // This is the exact regression: the grouped selector below applies a
    // sans-serif font-family to buttons/inputs/etc. If `#editor .ProseMirror
    // code`/`pre` ever get swept back into this group, the ASCII-diagram bug
    // reappears — same font-family property, later in the cascade, same
    // specificity, wins over the monospace rule above.
    const overrideGroup = sourceBetween(
      stylesSource,
      "button,\ntextarea,\nselect,\ninput,\n.action,\n.engine,\n.log,\n.diffpane {",
      "font-family: ui-sans-serif",
    );
    expect(overrideGroup).not.toContain("#editor");
  });

  it("leaves .diffpane's existing (unrelated) font behavior untouched", () => {
    // Explicit scope guard: the proposal old/new diff panes are a different
    // surface and are not part of this fix — confirm the sans-serif override
    // group still lists .diffpane exactly as before.
    const overrideGroup = sourceBetween(
      stylesSource,
      "button,\ntextarea,\nselect,\ninput,\n.action,\n.engine,\n.log,\n.diffpane {",
      "font-family: ui-sans-serif",
    );
    expect(overrideGroup).toContain(".diffpane");
  });
});
