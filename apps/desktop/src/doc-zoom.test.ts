import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  DOC_ZOOM_MIN,
  DOC_ZOOM_MAX,
  DOC_ZOOM_STEP,
  DOC_ZOOM_DEFAULT,
  IFRAME_ZOOM_STYLE_ATTR,
  clampDocZoom,
  clampDocZoomRange,
  zoomPercentLabel,
  iframeZoomCss,
  applyZoomToIframeDoc,
} from "./doc-zoom.js";

// Document zoom (⌘+ / ⌘= / ⌘- / ⌘0). This package's vitest setup has no DOM (see
// agent-retry-ux.test.ts's file header) — the pure helpers below (no
// document/localStorage/window reference) are unit-tested directly, including
// applyZoomToIframeDoc against a minimal hand-rolled Document stub (it only
// touches `doc.head`, so a stub is enough — no jsdom needed); the DOM-wiring
// half (initDocZoom itself, the keyboard shortcut, the main.ts/surface.ts
// threading) is source-pinned, the repo's established split for this exact
// situation (see mermaid-lightbox.test.ts for the same pattern).

describe("clampDocZoom", () => {
  it("clamps to the 50%-200% range", () => {
    expect(clampDocZoom(0.1)).toBe(DOC_ZOOM_MIN);
    expect(clampDocZoom(9)).toBe(DOC_ZOOM_MAX);
  });

  it("rounds to one decimal (0.1 steps), guarding against float drift", () => {
    expect(clampDocZoom(1.1 + DOC_ZOOM_STEP)).toBe(1.2); // 1.1 + 0.1 === 1.2000000000000002 in raw float math
    expect(clampDocZoom(1.23)).toBe(1.2);
    expect(clampDocZoom(1.26)).toBe(1.3);
  });

  it("leaves the default untouched", () => {
    expect(clampDocZoom(DOC_ZOOM_DEFAULT)).toBe(DOC_ZOOM_DEFAULT);
  });
});

describe("clampDocZoomRange", () => {
  it("clamps to the 50%-200% range, same bounds as clampDocZoom", () => {
    expect(clampDocZoomRange(0.1)).toBe(DOC_ZOOM_MIN);
    expect(clampDocZoomRange(9)).toBe(DOC_ZOOM_MAX);
  });

  it("does NOT round to 0.1 steps — continuous pinch/gesture input keeps full precision", () => {
    expect(clampDocZoomRange(1.2345)).toBe(1.2345);
    expect(clampDocZoomRange(1.1 + DOC_ZOOM_STEP)).toBe(1.1 + DOC_ZOOM_STEP); // 1.2000000000000002, unlike clampDocZoom
  });
});

describe("zoomPercentLabel", () => {
  it("formats a whole-percent label for the transient indicator", () => {
    expect(zoomPercentLabel(1)).toBe("100%");
    expect(zoomPercentLabel(1.3)).toBe("130%");
    expect(zoomPercentLabel(0.5)).toBe("50%");
  });
});

describe("iframeZoomCss", () => {
  it("emits a :root font-size rule in whole percent — the iframe-side analogue of --doc-zoom", () => {
    expect(iframeZoomCss(1)).toBe(":root { font-size: 100%; }");
    expect(iframeZoomCss(1.3)).toBe(":root { font-size: 130%; }");
  });
});

/** Minimal Document stub — applyZoomToIframeDoc only touches `doc.head`, so a
 * full jsdom Document isn't needed to exercise its create-once/reuse logic. */
function fakeIframeDoc() {
  const injected: { attr: string; textContent: string }[] = [];
  const styleEl = {
    attr: "",
    textContent: "",
    setAttribute(name: string) {
      this.attr = name;
      injected.push(this);
    },
  };
  const head = {
    querySelector: (sel: string) =>
      sel === `style[${IFRAME_ZOOM_STYLE_ATTR}]` && injected.includes(styleEl) ? styleEl : null,
    appendChild: (el: typeof styleEl) => el,
  };
  const doc = {
    head,
    createElement: () => styleEl,
  };
  return { doc: doc as unknown as Document, styleEl, injected };
}

describe("applyZoomToIframeDoc", () => {
  it("creates the style tag once and updates (not duplicates) it on later calls", () => {
    const { doc, styleEl, injected } = fakeIframeDoc();
    applyZoomToIframeDoc(doc, 1.2);
    expect(injected).toHaveLength(1);
    expect(styleEl.attr).toBe(IFRAME_ZOOM_STYLE_ATTR);
    expect(styleEl.textContent).toBe(":root { font-size: 120%; }");

    applyZoomToIframeDoc(doc, 1.5);
    expect(injected).toHaveLength(1); // reused, not duplicated
    expect(styleEl.textContent).toBe(":root { font-size: 150%; }");
  });

  it("no-ops when there's no head yet (fresh iframe, or no doc loaded at all)", () => {
    expect(() => applyZoomToIframeDoc({ head: null } as unknown as Document, 1)).not.toThrow();
    expect(() => applyZoomToIframeDoc(null, 1)).not.toThrow();
    expect(() => applyZoomToIframeDoc(undefined, 1)).not.toThrow();
  });
});

// --- wiring pins (no DOM harness in this package — see file header) ---
const docZoomSource = readFileSync(new URL("./doc-zoom.ts", import.meta.url), "utf8");
const mainSource = readFileSync(new URL("./main.ts", import.meta.url), "utf8");
const surfaceSource = readFileSync(new URL("./surface.ts", import.meta.url), "utf8");
const htmlSurfaceSource = readFileSync(new URL("./html-surface.ts", import.meta.url), "utf8");
const snippetPreviewSource = readFileSync(new URL("./html-snippet-preview.ts", import.meta.url), "utf8");
const indexSource = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const stylesSource = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
const tauriLibSource = readFileSync(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");

function sourceBetween(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return source.slice(startIndex, endIndex);
}

describe("⌘+ / ⌘= / ⌘- / ⌘0 shortcut — checked against every other accelerator in this app", () => {
  it("checks e.isComposing FIRST, mirroring chat.ts's Enter-to-send guard", () => {
    const handlerSource = sourceBetween(
      docZoomSource,
      "function handleZoomShortcut(e: KeyboardEvent): void {",
      "\n  window.addEventListener",
    );
    expect(handlerSource).toContain("if (e.isComposing) return;");
    expect(handlerSource.indexOf("e.isComposing")).toBeLessThan(handlerSource.indexOf('e.key === "0"'));
  });

  it("matches literal +, =, - and 0 (not e.g. numpad codes) and doesn't gate on shiftKey (⌘+ needs Shift held on a US keyboard)", () => {
    const handlerSource = sourceBetween(
      docZoomSource,
      "function handleZoomShortcut(e: KeyboardEvent): void {",
      "\n  window.addEventListener",
    );
    expect(handlerSource).toContain('e.key === "0"');
    expect(handlerSource).toContain('e.key === "+"');
    expect(handlerSource).toContain('e.key === "="');
    expect(handlerSource).toContain('e.key === "-"');
    expect(handlerSource).not.toContain("e.shiftKey");
  });

  it("does not collide with any src-tauri native-menu accelerator", () => {
    const accelerators = [...tauriLibSource.matchAll(/\.accelerator\("([^"]+)"\)/g)].map((m) => m[1]);
    expect(accelerators.length).toBeGreaterThan(0);
    for (const combo of accelerators) {
      expect(["+", "=", "-", "0"]).not.toContain(combo.split("+").pop());
    }
  });

  it("main.ts constructs docZoom before htmlSurfaceApi and threads it through (not a second independent instance)", () => {
    expect(mainSource).toContain('import { initDocZoom } from "./doc-zoom.js";');
    const docZoomAt = mainSource.indexOf("const docZoom = initDocZoom(");
    const htmlSurfaceApiAt = mainSource.indexOf("const htmlSurfaceApi = initHtmlSurface(");
    expect(docZoomAt).toBeGreaterThanOrEqual(0);
    expect(docZoomAt).toBeLessThan(htmlSurfaceApiAt);
    expect(mainSource).toContain("handleZoomShortcut: docZoom.handleZoomShortcut,");
    expect(mainSource).toContain("applyDocZoom: docZoom.applyToIframeDoc,");
    expect(mainSource).toContain("wirePinchZoom: docZoom.wirePinchZoom,");
  });
});

describe("surface.ts wires the iframe the same way it already wires ⌘F/⌘⇧D", () => {
  it("HtmlSurfaceDeps declares all three hooks", () => {
    expect(surfaceSource).toContain("handleZoomShortcut: (e: KeyboardEvent) => void;");
    expect(surfaceSource).toContain("applyDocZoom: (doc: Document) => void;");
    expect(surfaceSource).toContain("wirePinchZoom: (target: EventTarget) => void;");
  });

  it("onHtmlReady attaches the keydown handler, wires pinch, and re-applies zoom on every fresh load", () => {
    const onReadySource = sourceBetween(
      surfaceSource,
      "async function onHtmlReady(): Promise<void> {",
      "if (deps.searchIsOpen()",
    );
    expect(onReadySource).toContain('doc.addEventListener("keydown", deps.handleZoomShortcut, true);');
    expect(onReadySource).toContain("deps.wirePinchZoom(doc);");
    expect(onReadySource).toContain("deps.applyDocZoom(doc);");
    // Must run unconditionally (not inside the `if (!doc.head.querySelector(...))`
    // guard next to it) — a fresh iframe load always starts with a clean <head>.
    const applyAt = onReadySource.indexOf("deps.applyDocZoom(doc);");
    const overlayGuardEnd = onReadySource.indexOf("doc.head.appendChild(style);\n    }");
    expect(applyAt).toBeGreaterThan(overlayGuardEnd);
  });
});

describe("doc-zoom.ts's own pinch wiring (ctrlKey wheel + WebKit GestureEvent), threaded onto the markdown sheet's own `.doc` area", () => {
  it("queries .doc (not window/document globally) as the markdown-surface pinch target", () => {
    expect(docZoomSource).toContain('document.querySelector<HTMLElement>(".doc")!');
    expect(docZoomSource).toContain("wirePinchZoom(docAreaEl);");
  });

  it("onWheelZoom ignores non-ctrlKey wheel events (a plain two-finger scroll must not zoom) and preventDefaults ctrlKey ones", () => {
    const wheelSource = sourceBetween(
      docZoomSource,
      "function onWheelZoom(e: Event): void {",
      "\n  function onGestureStart",
    );
    expect(wheelSource).toContain("if (!we.ctrlKey) return;");
    expect(wheelSource).toContain("we.preventDefault();");
  });

  it("skips re-applying the wheel-based zoom when GestureEvent is supported, to avoid double-applying the same physical pinch", () => {
    expect(docZoomSource).toContain('const supportsGestureEvents = "GestureEvent" in window;');
    const wheelSource = sourceBetween(
      docZoomSource,
      "function onWheelZoom(e: Event): void {",
      "\n  function onGestureStart",
    );
    expect(wheelSource).toContain("if (supportsGestureEvents) return;");
  });

  it("wheel input goes through setZoomContinuous (clampDocZoomRange), not the keyboard path's rounded setZoom", () => {
    const wheelSource = sourceBetween(
      docZoomSource,
      "function onWheelZoom(e: Event): void {",
      "\n  function onGestureStart",
    );
    expect(wheelSource).toContain("setZoomContinuous(zoom * factor);");
  });

  it("gesturestart/gesturechange/gestureend all preventDefault (stops the OS/browser page-zoom), and gesturechange scales from an ABSOLUTE gesture-start zoom (not a per-tick delta)", () => {
    expect(docZoomSource).toContain("function onGestureStart(e: Event): void {\n    e.preventDefault();\n    gestureStartZoom = zoom;\n  }");
    expect(docZoomSource).toContain("setZoomContinuous(gestureStartZoom * scale);");
    expect(docZoomSource).toContain("function onGestureEnd(e: Event): void {\n    e.preventDefault();\n  }");
  });

  it("wirePinchZoom wires gesture listeners only when supported, wheel always", () => {
    const wireSource = sourceBetween(
      docZoomSource,
      "function wirePinchZoom(target: EventTarget): void {",
      "\n  window.addEventListener(\"keydown\", handleZoomShortcut, true);",
    );
    expect(wireSource).toContain('target.addEventListener("wheel", onWheelZoom, { passive: false });');
    expect(wireSource).toContain("if (supportsGestureEvents) {");
    expect(wireSource).toContain('target.addEventListener("gesturestart", onGestureStart);');
    expect(wireSource).toContain('target.addEventListener("gesturechange", onGestureChange);');
    expect(wireSource).toContain('target.addEventListener("gestureend", onGestureEnd);');
  });
});

describe("the injected iframe zoom style never leaks into the saved document or a preview snippet", () => {
  it("serializeDocument strips [data-had-zoom], same as [data-had-overlay]", () => {
    const serializeSource = sourceBetween(
      htmlSurfaceSource,
      "export function serializeDocument(doc: Document): string {",
      "const dt = doc.doctype;",
    );
    expect(serializeSource).toContain('root.querySelectorAll("[data-had-overlay]").forEach((n) => n.remove());');
    expect(serializeSource).toContain('root.querySelectorAll("[data-had-zoom]").forEach((n) => n.remove());');
  });

  it("buildHtmlSnippetPreviewContext's head-copy selector excludes it too", () => {
    expect(snippetPreviewSource).toContain(
      'style:not([data-had-overlay]):not([data-had-zoom])',
    );
  });
});

describe("index.html + styles.css", () => {
  it("declares the persistent zoom control in the status cluster (bottom status bar) — '− 100% +', live-updating, no [hidden] toggling needed (it's always visible, unlike the old toast)", () => {
    expect(indexSource).toContain('id="docZoomControl"');
    expect(indexSource).toContain('id="docZoomOutBtn"');
    expect(indexSource).toContain('id="docZoomPctBtn"');
    expect(indexSource).toContain('id="docZoomInBtn"');
    // Lives inside .statuscluster, next to the harness badge/docd dot.
    const statusClusterStart = indexSource.indexOf('<div class="statuscluster">');
    const statusClusterEnd = indexSource.indexOf("</div>", indexSource.indexOf('id="connStatus"'));
    expect(statusClusterStart).toBeGreaterThanOrEqual(0);
    const statusCluster = indexSource.slice(statusClusterStart, statusClusterEnd);
    expect(statusCluster).toContain('id="docZoomControl"');
    // Its tooltip documents both pinch AND the keyboard shortcuts (the task's two input paths).
    const controlLine = indexSource.split("\n").find((line) => line.includes('id="docZoomControl"'));
    expect(controlLine).toBeDefined();
    expect(controlLine).toMatch(/pinch/i);
    expect(controlLine).toContain("⌘+");
    expect(controlLine).toContain("⌘0");
  });

  it("REMOVED the old transient %-indicator toast — the persistent control is the one indicator now (avoids duplicate indicators; a toast would flicker continuously under pinch's much higher update frequency)", () => {
    expect(indexSource).not.toContain('id="zoomIndicator"');
    expect(stylesSource).not.toContain(".zoomindicator");
  });

  it("styles.css gives the control the same quiet mono treatment as .harnessbadge/.connstatus right next to it", () => {
    expect(stylesSource).toContain(".doczoom {");
    expect(stylesSource).toContain(".doczoombtn,");
    expect(stylesSource).toContain(".doczoompct {");
  });

  it("documents the shortcuts in the Keyboard shortcuts modal", () => {
    expect(indexSource).toContain("<kbd>⌘+</kbd>");
    expect(indexSource).toContain("<kbd>⌘-</kbd>");
    expect(indexSource).toContain("<kbd>⌘0</kbd>");
  });

  it("--doc-zoom multiplies the sheet's own font-size rules (not the app chrome's)", () => {
    expect(stylesSource).toContain("--doc-zoom: 1;");
    expect(stylesSource).toContain("font-size: calc(1.02rem * var(--doc-zoom, 1));");
    expect(stylesSource).toContain("font-size: calc(clamp(2rem, 4vw, 3.2rem) * var(--doc-zoom, 1));");
    expect(stylesSource).toContain("font-size: calc(1.45rem * var(--doc-zoom, 1));");
    // Scope check: the topbar/chatpane/panel rules must NOT reference --doc-zoom —
    // only the document sheet (.editor .ProseMirror) should scale.
    expect(stylesSource).not.toMatch(/\.topbar[^{]*\{[^}]*--doc-zoom/);
  });
});
