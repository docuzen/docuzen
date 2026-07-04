import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  LIGHTBOX_ZOOM_MIN,
  LIGHTBOX_ZOOM_MAX,
  clampLightboxScale,
  zoomAroundPoint,
} from "./mermaid-lightbox.js";

// Mermaid diagram lightbox (⤢ hover-expand on a rendered diagram → full-viewport
// pan/zoom overlay). This package's vitest setup has no DOM (see
// agent-retry-ux.test.ts's file header) — the pure zoom-math helpers below are
// unit-tested directly (they take/return plain numbers, no DOM), and the
// DOM-wiring half is source-pinned, the repo's established split for exactly
// this situation (see doc-zoom.ts/click-jump.ts for the same pattern).

describe("clampLightboxScale", () => {
  it("clamps to the 0.25x-8x range", () => {
    expect(clampLightboxScale(0.01)).toBe(LIGHTBOX_ZOOM_MIN);
    expect(clampLightboxScale(100)).toBe(LIGHTBOX_ZOOM_MAX);
  });

  it("passes values already inside the range through unchanged", () => {
    expect(clampLightboxScale(1)).toBe(1);
    expect(clampLightboxScale(3.5)).toBe(3.5);
  });
});

describe("zoomAroundPoint", () => {
  it("leaves translate unchanged when the scale doesn't change (k=1)", () => {
    expect(zoomAroundPoint(120, 40, 2, 2)).toBe(40);
  });

  it("keeps the cursor's document point fixed across a scale change", () => {
    // At scale=1, translate=0, a cursor 100px right of the stage's center is
    // sitting over the document point at local-offset 100 (offset = local*scale + translate).
    // Zooming to scale=2 while keeping that same point under the cursor requires local*2 + tx = 100,
    // i.e. tx = 100 - 200 = -100 — exactly what the identity should produce.
    const tx = zoomAroundPoint(100, 0, 1, 2);
    expect(tx).toBe(-100);
    // Verify the invariant directly: the document point that WAS at screen-offset 100
    // (localPoint = (100 - 0) / 1 = 100) must still resolve to offset 100 after rescaling.
    const localPoint = (100 - 0) / 1;
    expect(localPoint * 2 + tx).toBe(100);
  });

  it("zooming out (k<1) pulls translate back toward the cursor offset", () => {
    const tx = zoomAroundPoint(50, -30, 4, 2); // k = 0.5
    expect(tx).toBe(50 * 0.5 + -30 * 0.5);
  });
});

// --- wiring pins (no DOM harness in this package — see file header) ---
const editorSource = readFileSync(new URL("./editor.ts", import.meta.url), "utf8");
const lightboxSource = readFileSync(new URL("./mermaid-lightbox.ts", import.meta.url), "utf8");
const indexSource = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const stylesSource = readFileSync(new URL("./styles.css", import.meta.url), "utf8");

function sourceBetween(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return source.slice(startIndex, endIndex);
}

describe("editor.ts wires the expand button as a DISTINCT affordance", () => {
  it("adds the button only after a successful render, not on error", () => {
    expect(editorSource).toContain("import { openMermaidLightbox } from \"./mermaid-lightbox.js\";");
    const renderDiagramSource = sourceBetween(
      editorSource,
      "const renderDiagram = (source: string): void => {",
      "renderDiagram(currentSource);",
    );
    expect(renderDiagramSource).toContain("addMermaidExpandButton(container)");
    // showError (the .catch branch) must NOT also get a button — there's no
    // rendered SVG to expand when the diagram failed to parse.
    const catchBranch = sourceBetween(renderDiagramSource, ".catch(() => {", "});");
    expect(catchBranch).not.toContain("addMermaidExpandButton");
  });

  it("stops the click/mousedown from reaching ProseMirror's own node-selection handling", () => {
    const btnFnSource = sourceBetween(
      editorSource,
      "function addMermaidExpandButton(container: HTMLElement): void {",
      "\n/**\n * Node view for `code_block`",
    );
    expect(btnFnSource).toContain('btn.addEventListener("mousedown", (e) => e.stopPropagation());');
    expect(btnFnSource).toContain("e.stopPropagation();");
    expect(btnFnSource).toContain("openMermaidLightbox(svg);");
  });
});

describe("mermaid-lightbox.ts reuses ui.ts's wireModal for backdrop-click-to-close", () => {
  it("imports and calls wireModal instead of hand-rolling its own backdrop listener", () => {
    expect(lightboxSource).toContain('import { wireModal } from "./ui.js";');
    expect(lightboxSource).toContain("wireModal(modalEl);");
  });

  it("closes on Escape while open, and ignores it while already closed", () => {
    const escSource = sourceBetween(lightboxSource, 'window.addEventListener("keydown"', "});");
    expect(escSource).toContain("if (modalEl.hidden) return;");
    expect(escSource).toContain('e.key === "Escape"');
  });

  it("clones the SVG rather than moving it out of the live document", () => {
    expect(lightboxSource).toContain("svg.cloneNode(true)");
  });
});

describe("index.html declares the lightbox shell + shortcuts entry", () => {
  it("has the overlay, stage, and all four controls", () => {
    expect(indexSource).toContain('id="mermaidLightbox"');
    expect(indexSource).toContain('id="mermaidLbStage"');
    expect(indexSource).toContain('id="mermaidLbZoomIn"');
    expect(indexSource).toContain('id="mermaidLbZoomOut"');
    expect(indexSource).toContain('id="mermaidLbReset"');
    expect(indexSource).toContain('id="mermaidLbClose"');
  });

  it("starts hidden (so wireModal's backdrop click / display toggling behaves like every other modal)", () => {
    const lightboxMarkup = sourceBetween(indexSource, '<div id="mermaidLightbox"', "</div>\n    </div>\n  </body>");
    expect(lightboxMarkup).toContain("hidden");
  });
});

describe("mermaid-lightbox.ts pinch (ctrlKey wheel + WebKit GestureEvent), scoped to the overlay, never the document", () => {
  it("feature-detects GestureEvent lazily inside ensureWired (not at module scope, so pure exports stay importable under this package's no-DOM vitest setup)", () => {
    expect(lightboxSource).toContain('supportsGestureEvents = "GestureEvent" in window;');
    const wiredSource = sourceBetween(
      lightboxSource,
      "function ensureWired(): void {",
      "\n/**\n * Open the lightbox",
    );
    expect(wiredSource).toContain('supportsGestureEvents = "GestureEvent" in window;');
  });

  it("onWheel always preventDefaults, and skips re-zooming a ctrlKey (pinch) wheel event when GestureEvent will drive it instead", () => {
    const onWheelSource = sourceBetween(lightboxSource, "function onWheel(e: WheelEvent): void {", "\n\nfunction onGestureStart");
    expect(onWheelSource).toContain("e.preventDefault();");
    expect(onWheelSource).toContain("if (e.ctrlKey && supportsGestureEvents) return;");
  });

  it("gesturestart/gesturechange/gestureend all preventDefault (stops WebKit's native page pinch-zoom from fighting the overlay)", () => {
    expect(lightboxSource).toContain("function onGestureStart(e: Event): void {\n  e.preventDefault();\n  gestureStartScale = scale;\n}");
    expect(lightboxSource).toContain("function onGestureEnd(e: Event): void {\n  e.preventDefault();\n}");
  });

  it("gesturechange zooms from an ABSOLUTE gesture-start scale via zoomTo, not a relative per-tick delta like zoomBy", () => {
    const changeSource = sourceBetween(lightboxSource, "function onGestureChange(e: Event): void {", "\nfunction onGestureEnd");
    expect(changeSource).toContain("gestureStartScale * ge.scale");
    expect(changeSource).toContain("zoomTo(");
  });

  it("wires gesture listeners on the stage only when supported; wheel is wired unconditionally", () => {
    const wiredSource = sourceBetween(
      lightboxSource,
      "function ensureWired(): void {",
      "\n/**\n * Open the lightbox",
    );
    expect(wiredSource).toContain('stageEl.addEventListener("wheel", onWheel, { passive: false });');
    expect(wiredSource).toContain("if (supportsGestureEvents) {");
    expect(wiredSource).toContain('stageEl.addEventListener("gesturestart", onGestureStart);');
    expect(wiredSource).toContain('stageEl.addEventListener("gesturechange", onGestureChange);');
    expect(wiredSource).toContain('stageEl.addEventListener("gestureend", onGestureEnd);');
  });

  it("never touches document zoom: #mermaidLightbox is a sibling of .doc in index.html, not a descendant, so its wheel/gesture events can't bubble into doc-zoom.ts's own .doc listener", () => {
    expect(indexSource).not.toMatch(/<main class="doc">[\s\S]*id="mermaidLightbox"[\s\S]*<\/main>/);
  });
});

describe("styles.css gives the diagram an expand affordance without changing its default cursor", () => {
  it("keeps .mermaid-expand invisible until hover/focus", () => {
    const expandCss = sourceBetween(stylesSource, ".mermaid-expand {", ".mermaid-lightbox {");
    expect(expandCss).toContain("opacity: 0;");
    expect(expandCss).toContain(".mermaid-rendered:hover .mermaid-expand");
    expect(expandCss).toContain("cursor: zoom-in;");
  });

  it("the lightbox is a true full-viewport overlay (position: fixed; inset: 0), not a centered .modal-card", () => {
    const lightboxCss = sourceBetween(stylesSource, ".mermaid-lightbox {", ".mermaid-lightbox-surface {");
    expect(lightboxCss).toContain("position: fixed; inset: 0;");
  });

  it("keeps the [hidden] override (author `display:flex` would otherwise beat the UA [hidden] rule)", () => {
    expect(stylesSource).toContain(".mermaid-lightbox[hidden] { display: none; }");
  });
});
