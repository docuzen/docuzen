import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

// The HTML surface interactions (popover construction, iframe link handling) moved
// to surface.ts in the frontend split. Assertion semantics are unchanged; only the
// source file (and the COMMENT_COLOR/etc. reference now going through `deps`) moved.
const htmlSurfaceUiSource = readFileSync(new URL("./surface.ts", import.meta.url), "utf8");
// html-surface.ts (the HTML iframe surface class) — unrelated to, and unmoved by,
// this extraction; kept under its pre-existing name.
const surfaceSource = readFileSync(new URL("./html-surface.ts", import.meta.url), "utf8");

function sourceBetween(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return source.slice(startIndex, endIndex);
}

describe("HTML surface interactions", () => {
  it("routes popover comment actions through the active surface dispatcher", () => {
    // End boundary: this task's wave-2 move landed the popover/quick-actions
    // section at the end of initHtmlSurface(), right before its `return` — see
    // surface.ts's own "end selection popover" marker comment.
    const popoverConstruction = sourceBetween(
      htmlSurfaceUiSource,
      "popover.addEventListener",
      "// --- end selection popover / quick actions ---",
    );

    expect(popoverConstruction).toContain('annotateActive("comment", deps.COMMENT_COLOR)');
    expect(popoverConstruction).not.toContain('annotate("comment", deps.COMMENT_COLOR)');
  });

  it("handles iframe link clicks with the Tauri opener instead of sandbox navigation", () => {
    expect(htmlSurfaceUiSource).toContain('from "@tauri-apps/plugin-opener"');
    expect(htmlSurfaceUiSource).toContain("function handleHtmlLinkClick");
    expect(htmlSurfaceUiSource).toContain('doc.addEventListener("click", handleHtmlLinkClick');
    expect(htmlSurfaceUiSource).toContain("openUrl(");
  });

  it("lets user-initiated popups escape the iframe sandbox", () => {
    expect(surfaceSource).toContain("allow-popups");
    expect(surfaceSource).toContain("allow-popups-to-escape-sandbox");
  });
});

// Meta/ctrl+click any agent marker -> its conversation. editor.ts's
// own click-jump ProseMirror plugin fires on a DIFFERENT native event than this
// module's click listeners (see surface.ts's markdown listener comment), so both the
// markdown surface's action-menu guard and the HTML iframe's span handler need their
// own meta/ctrl check — neither can rely on the other suppressing the event.
describe("meta/ctrl+click bypasses the annotation action menu", () => {
  it("skips the markdown action menu on meta/ctrl+click (editor.ts's plugin jumps instead)", () => {
    const markdownClickHandler = sourceBetween(
      htmlSurfaceUiSource,
      "deps.rootEl.addEventListener(\"click\", (e) => {",
      "openAnnoMenuForElement(target);",
    );
    expect(markdownClickHandler).toContain("if (e.metaKey || e.ctrlKey) return;");
  });

  it("jumps to the conversation on a meta/ctrl+click on an iframe annotation span, bypassing the menu", () => {
    const spanClickHandler = sourceBetween(
      htmlSurfaceUiSource,
      "for (const span of spans) {",
      "openAnnoMenuForElement(span,",
    );
    expect(spanClickHandler).toContain("if (e.metaKey || e.ctrlKey) {");
    expect(spanClickHandler).toContain("void deps.onAnnotationJump(id);");
    expect(spanClickHandler).toContain("return;");
  });

  it("exposes onAnnotationJump as a dep, distinct from the unconditional promoteToChat badge click", () => {
    expect(htmlSurfaceUiSource).toContain("onAnnotationJump: (id: string) => void | Promise<void>;");
  });
});
