// Full-viewport pan/zoom lightbox for mermaid diagrams. Opened from editor.ts's
// mermaidView node view (the document-editor's inline diagram rendering) via its
// hover-revealed expand button — see editor.ts's "mermaid diagram rendering"
// section. Self-contained: builds on the static #mermaidLightbox shell already
// declared in index.html (same pattern every other modal in this app follows),
// wires its own listeners lazily on first open (this module does no
// module-scope `document.querySelector`, matching editor.ts/surface.ts/
// shell.ts's own DOM-query-timing convention), and reuses ui.ts's wireModal for
// backdrop-click-to-close — the one piece of shared modal plumbing this needs.
//
// Not wired into surface.ts's own "Visualize" preview mermaid render (the
// proposed-diagram box in the chat pane) or any other mermaid renderer — only
// the document-editor case is covered.
//
// Zoom math: CSS `transform: translate(tx, ty) scale(s)` on the cloned SVG,
// `transform-origin` left at its default (the element's own center). "Zoom
// centered on the cursor" solves for the new translate that keeps the same
// document point under the cursor before/after a scale change — the standard
// "zoom around a point" identity: for a point at screen-offset `r` from the
// stage's center, and a zoom ratio `k = newScale / oldScale`,
//   translateNew = r * (1 - k) + translateOld * k
// (derived from requiring `stageCenter + translate + scale * localPoint` — the
// screen position of a fixed point in the SVG's local coordinate space — to
// stay equal to the cursor's screen position across the scale change).
//
// Pinch (trackpad): a physical pinch inside the stage arrives as a `wheel`
// event with `ctrlKey: true` — already covered by the wheel handling below,
// which doesn't discriminate on ctrlKey (matches this lightbox's existing
// "any wheel zooms" convention: there's no scrollable content inside the
// stage, so plain-wheel-zooms-too is intentional, not a bug). Safari/
// WKWebView ALSO fires the older, non-standard GestureEvent family
// (gesturestart/gesturechange/gestureend, an absolute cumulative `e.scale`
// from gesture start) for the SAME physical pinch. Feature-detected via
// `"GestureEvent" in window`; when present it drives the zoom instead
// (smoother — an absolute scale beats wheel's noisy per-tick deltaY), and the
// parallel ctrlKey-wheel events are skipped (but still preventDefault'd) to
// avoid double-applying the same pinch — see onWheel/onGestureChange below.
// This stays entirely local to the lightbox's own scale/tx/ty state and never
// touches doc-zoom.ts's document zoom, by construction: index.html declares
// `#mermaidLightbox` as a sibling of `.doc`, not a descendant, so wheel/
// gesture events here can never bubble into doc-zoom.ts's own `.doc`
// listener.

import { wireModal } from "./ui.js";

export const LIGHTBOX_ZOOM_MIN = 0.25;
export const LIGHTBOX_ZOOM_MAX = 8;
const BUTTON_ZOOM_FACTOR = 1.25;
const WHEEL_ZOOM_SENSITIVITY = 0.0015;

/** Clamp a lightbox scale factor to the supported range. Pure — unit-tested directly. */
export function clampLightboxScale(scale: number): number {
  return Math.min(LIGHTBOX_ZOOM_MAX, Math.max(LIGHTBOX_ZOOM_MIN, scale));
}

/**
 * The new translate coordinate that keeps the same document point under the
 * cursor after a scale change from `oldScale` to `newScale` — see file header
 * for the derivation. `offset` is the cursor's screen position minus the
 * stage's center (i.e. already relative to the point translate/scale are
 * measured from). Pure — unit-tested directly.
 */
export function zoomAroundPoint(
  offset: number,
  translateOld: number,
  oldScale: number,
  newScale: number,
): number {
  const k = newScale / oldScale;
  return offset * (1 - k) + translateOld * k;
}

let wired = false;
let modalEl: HTMLDivElement;
let stageEl: HTMLDivElement;
let zoomLabelEl: HTMLSpanElement;
let contentEl: SVGSVGElement | null = null;

let scale = 1;
let tx = 0;
let ty = 0;
let dragging = false;
let dragStartX = 0;
let dragStartY = 0;
let dragOriginTx = 0;
let dragOriginTy = 0;

function render(): void {
  if (!contentEl) return;
  contentEl.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
  zoomLabelEl.textContent = `${Math.round(scale * 100)}%`;
}

function resetView(): void {
  scale = 1;
  tx = 0;
  ty = 0;
  render();
}

/** Zoom to an ABSOLUTE target scale. When `clientX`/`clientY` are given (wheel,
 * gesture, cursor-centered), the point under the cursor stays fixed; button
 * clicks omit them and zoom around the stage's current center instead. */
function zoomTo(target: number, clientX?: number, clientY?: number): void {
  const next = clampLightboxScale(target);
  if (next === scale) return;
  if (clientX !== undefined && clientY !== undefined) {
    const rect = stageEl.getBoundingClientRect();
    const offsetX = clientX - rect.left - rect.width / 2;
    const offsetY = clientY - rect.top - rect.height / 2;
    tx = zoomAroundPoint(offsetX, tx, scale, next);
    ty = zoomAroundPoint(offsetY, ty, scale, next);
  }
  scale = next;
  render();
}

/** Zoom by a multiplicative `factor` from the CURRENT scale — button clicks
 * and per-tick wheel deltas. `zoomTo` (an absolute target) is the pinch/
 * gesture entry point instead, since GestureEvent's `e.scale` is a
 * cumulative factor from gesture START, not a per-tick delta. */
function zoomBy(factor: number, clientX?: number, clientY?: number): void {
  zoomTo(scale * factor, clientX, clientY);
}

function close(): void {
  modalEl.hidden = true;
  stageEl.replaceChildren();
  contentEl = null;
}

/** WebKit fires this proprietary event family alongside a synthetic ctrlKey
 * wheel event for the SAME physical pinch (see file header) — feature-detect
 * once (inside ensureWired, not at module scope: this module does no
 * module-scope `window`/`document` reference — see file header — so its pure
 * exports stay importable under this package's no-DOM vitest setup) so
 * onWheel can skip re-applying that pinch when gesture events will drive it
 * instead. */
let supportsGestureEvents = false;
let gestureStartScale = 1;

function onWheel(e: WheelEvent): void {
  e.preventDefault();
  if (e.ctrlKey && supportsGestureEvents) return; // this engine's GestureEvents already drive the zoom below — avoid double-applying the same physical pinch
  const factor = Math.exp(-e.deltaY * WHEEL_ZOOM_SENSITIVITY);
  zoomBy(factor, e.clientX, e.clientY);
}

function onGestureStart(e: Event): void {
  e.preventDefault();
  gestureStartScale = scale;
}
function onGestureChange(e: Event): void {
  e.preventDefault();
  const ge = e as unknown as { scale: number; clientX: number; clientY: number };
  zoomTo(gestureStartScale * ge.scale, ge.clientX, ge.clientY);
}
function onGestureEnd(e: Event): void {
  e.preventDefault();
}

function onStageMouseDown(e: MouseEvent): void {
  if (e.button !== 0) return;
  dragging = true;
  dragStartX = e.clientX;
  dragStartY = e.clientY;
  dragOriginTx = tx;
  dragOriginTy = ty;
  stageEl.classList.add("dragging");
  e.preventDefault();
}

function onWindowMouseMove(e: MouseEvent): void {
  if (!dragging) return;
  tx = dragOriginTx + (e.clientX - dragStartX);
  ty = dragOriginTy + (e.clientY - dragStartY);
  render();
}

function onWindowMouseUp(): void {
  if (!dragging) return;
  dragging = false;
  stageEl.classList.remove("dragging");
}

function ensureWired(): void {
  if (wired) return;
  wired = true;
  supportsGestureEvents = "GestureEvent" in window;
  modalEl = document.querySelector<HTMLDivElement>("#mermaidLightbox")!;
  stageEl = document.querySelector<HTMLDivElement>("#mermaidLbStage")!;
  zoomLabelEl = document.querySelector<HTMLSpanElement>("#mermaidLbZoomLabel")!;
  const zoomInBtn = document.querySelector<HTMLButtonElement>("#mermaidLbZoomIn")!;
  const zoomOutBtn = document.querySelector<HTMLButtonElement>("#mermaidLbZoomOut")!;
  const resetBtn = document.querySelector<HTMLButtonElement>("#mermaidLbReset")!;
  const closeBtn = document.querySelector<HTMLButtonElement>("#mermaidLbClose")!;

  wireModal(modalEl); // click the darkened backdrop (outside the surface) to close
  closeBtn.addEventListener("click", close);
  zoomInBtn.addEventListener("click", () => zoomBy(BUTTON_ZOOM_FACTOR));
  zoomOutBtn.addEventListener("click", () => zoomBy(1 / BUTTON_ZOOM_FACTOR));
  resetBtn.addEventListener("click", resetView);
  stageEl.addEventListener("wheel", onWheel, { passive: false });
  if (supportsGestureEvents) {
    stageEl.addEventListener("gesturestart", onGestureStart);
    stageEl.addEventListener("gesturechange", onGestureChange);
    stageEl.addEventListener("gestureend", onGestureEnd);
  }
  stageEl.addEventListener("mousedown", onStageMouseDown);
  window.addEventListener("mousemove", onWindowMouseMove);
  window.addEventListener("mouseup", onWindowMouseUp);
  window.addEventListener("keydown", (e) => {
    if (modalEl.hidden) return;
    if (e.key === "Escape") close();
  });
}

/**
 * Open the lightbox showing `svg` (editor.ts's rendered mermaid diagram). The
 * node is CLONED, not moved — the original stays inline in the document as the
 * live diagram. SVG scales losslessly, so cloning is enough to get a sharp
 * full-viewport render; no need to re-render mermaid at a larger size.
 */
export function openMermaidLightbox(svg: SVGSVGElement): void {
  ensureWired();
  const clone = svg.cloneNode(true) as SVGSVGElement;
  // Drop mermaid's inline width/height/style (it typically stamps a small
  // pixel width plus a `max-width` style) so the clone fills the stage instead
  // of staying pinned to its small inline-render size; the viewBox (left
  // untouched) keeps the diagram's proportions.
  clone.removeAttribute("width");
  clone.removeAttribute("height");
  clone.removeAttribute("style");
  clone.style.display = "block";
  clone.style.width = "100%";
  clone.style.height = "100%";
  stageEl.replaceChildren(clone);
  contentEl = clone;
  scale = 1;
  tx = 0;
  ty = 0;
  render();
  modalEl.hidden = false;
}
