// Document zoom (⌘+ / ⌘= / ⌘− / ⌘0, trackpad pinch, and a persistent topbar
// control): scales the DOCUMENT content — the markdown sheet AND the HTML
// iframe surface — like an editor's zoom, not the app chrome (topbar/sidebars
// stay fixed size). Font-size based (a `--doc-zoom` custom property multiplied
// into the sheet's own font-size rules in styles.css, and a
// `:root { font-size: N% }` rule injected into the iframe) rather than a CSS
// `transform: scale()` on the whole layout, so zoomed content still reflows
// (wrapping, table widths, etc.) instead of just rasterizing bigger.
//
// Pinch: macOS WKWebView + Chromium deliver a trackpad pinch as `wheel`
// events with `ctrlKey: true` (a real Ctrl+wheel-scroll is vanishingly rare on
// a trackpad, and zooming on it anyway matches the convention every other
// editor uses for this combo). Safari/WKWebView ALSO fires the older,
// non-standard `GestureEvent` family (`gesturestart`/`gesturechange`/
// `gestureend`, an absolute cumulative `e.scale` from gesture start) for the
// SAME physical pinch — feature-detected via `"GestureEvent" in window`; when
// present it drives the zoom instead (smoother — an absolute scale beats
// wheel's noisy per-tick deltaY), and the parallel ctrlKey-wheel events are
// still preventDefault'd (so the OS/browser's own page-zoom doesn't fight)
// but NOT re-applied to the zoom state, to avoid double-applying the same
// pinch. Pinch writes the EXACT SAME `zoom` variable ⌘+/−/0 and the topbar
// control do — one shared state, three input paths (single source of truth).
// Unlike the keyboard shortcut's 0.1-step rounding (`clampDocZoom`), pinch/
// gesture input goes through `clampDocZoomRange` (clamp only, no rounding) so
// a slow pinch feels continuous rather than notchy; both write `zoom`, so a
// mid-decile pinch stop (e.g. 137%) is a legitimate value a later keyboard
// nudge then rounds away from.
//
// Persistent topbar control ("− 100% +" in the status cluster) REPLACED the
// old transient %-indicator toast: with pinch now able to fire zoom changes
// dozens of times a second, a fade-in/fade-out toast would flicker
// continuously mid-gesture — a live-updating persistent readout reads far
// cleaner, and doubles as the reset button (click the % to return to 100%).
// This is a deliberate call, not an oversight: avoid duplicate indicators —
// the persistent control IS the indicator now.
//
// Self-contained like shell.ts's sidebar toggles: queries its own DOM (the
// `.doc` pinch target, the topbar control's three buttons) inside
// initDocZoom()'s body, not at module scope (this module does no module-scope
// `document.querySelector` — same convention as every other region file). The
// pure zoom-math/formatting/CSS-text helpers below have NO DOM/localStorage/
// window reference, so — unlike the DOM-wiring half — they really are unit-
// tested directly (see doc-zoom.test.ts), the same split anchor-map.ts/
// click-jump.ts already use for their pure logic.
//
// Wiring: main.ts constructs this early (so the restored zoom applies before
// the editor mounts) and threads `handleZoomShortcut`/`applyDocZoom`/
// `wirePinchZoom` into surface.ts's HtmlSurfaceDeps — `onHtmlReady` wires the
// first onto the iframe doc's own keydown (mirroring the existing ⌘F/⌘⇧D
// precedent), calls the second once per fresh load (mirroring the static
// HAD_IFRAME_CSS injection right next to it), and calls the third once per
// fresh load too — the iframe is its own browsing context, so wheel/gesture
// events over its rendered content never reach the parent page and it needs
// its own pinch listener, same reasoning as the keydown one right next to it.
// `getHtmlSurfaceDoc` is typed structurally (`{ doc }`-shaped by inference,
// not imported) so this module never imports html-surface.ts/surface.ts —
// main.ts passes `() => htmlSurface?.doc ?? null` in, matching the "modules
// never import each other" wiring rule.
//
// html-surface.ts's serializeDocument strips the injected iframe zoom
// `<style>` tag (by its `data-had-zoom` marker attribute) before saving, the
// same way it already strips `data-had-overlay` — a view-only zoom preference
// must never get baked into the saved HTML file.

export const DOC_ZOOM_MIN = 0.5;
export const DOC_ZOOM_MAX = 2.0;
export const DOC_ZOOM_STEP = 0.1;
export const DOC_ZOOM_DEFAULT = 1.0;

const ZOOM_STORAGE_KEY = "docuzen:zoom:v1";

/** Wheel-deltaY-to-zoom-factor sensitivity for ctrlKey (pinch) wheel events —
 * same exponential-decay shape as mermaid-lightbox.ts's own wheel zoom, tuned
 * separately for this module's much narrower 50%-200% range (vs. the
 * lightbox's 25%-800%). Only reachable via onWheelZoom, inside initDocZoom's
 * closure — not unit-tested directly (DOM-wiring half, see file header). */
const DOC_ZOOM_WHEEL_SENSITIVITY = 0.003;

/** Marker attribute for the injected iframe zoom `<style>` — html-surface.ts's
 * serializeDocument strips any element carrying it before saving. */
export const IFRAME_ZOOM_STYLE_ATTR = "data-had-zoom";

/** Clamp + round to one decimal (0.1 steps) — guards against float drift from
 * repeated +/- (1.1 + 0.1 = 1.2000000000000002). Used by the keyboard
 * shortcut and the topbar control's own ±/reset buttons. Pure. */
export function clampDocZoom(z: number): number {
  const rounded = Math.round(z * 10) / 10;
  return Math.min(DOC_ZOOM_MAX, Math.max(DOC_ZOOM_MIN, rounded));
}

/** Clamp WITHOUT rounding to 0.1 steps — used for continuous pinch/gesture
 * input, where forcing a decile step would feel jerky against a smooth
 * physical gesture (see file header). Pure. */
export function clampDocZoomRange(z: number): number {
  return Math.min(DOC_ZOOM_MAX, Math.max(DOC_ZOOM_MIN, z));
}

/** Whole-percent label for the topbar zoom control's readout ("130%"). Pure. */
export function zoomPercentLabel(z: number): string {
  return `${Math.round(z * 100)}%`;
}

/** The iframe-side CSS text (a `:root` font-size rule) that scales the whole
 * HTML surface the same way `--doc-zoom` scales the markdown sheet. Pure. */
export function iframeZoomCss(z: number): string {
  return `:root { font-size: ${Math.round(z * 100)}%; }`;
}

/**
 * Create (once) or update the iframe's zoom `<style>` tag. Called both on a
 * fresh iframe load (surface.ts's onHtmlReady, applying whatever zoom is
 * already active) and immediately when the zoom changes while an HTML doc is
 * open (so switching zoom doesn't wait for a reload).
 */
export function applyZoomToIframeDoc(doc: Document | null | undefined, z: number): void {
  if (!doc?.head) return;
  let style = doc.head.querySelector<HTMLStyleElement>(`style[${IFRAME_ZOOM_STYLE_ATTR}]`);
  if (!style) {
    style = doc.createElement("style");
    style.setAttribute(IFRAME_ZOOM_STYLE_ATTR, "");
    doc.head.appendChild(style);
  }
  style.textContent = iframeZoomCss(z);
}

function loadDocZoom(): number {
  try {
    const raw = localStorage.getItem(ZOOM_STORAGE_KEY);
    if (!raw) return DOC_ZOOM_DEFAULT;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? clampDocZoom(parsed) : DOC_ZOOM_DEFAULT;
  } catch {
    return DOC_ZOOM_DEFAULT;
  }
}

function saveDocZoom(z: number): void {
  try {
    localStorage.setItem(ZOOM_STORAGE_KEY, String(z));
  } catch {
    // Storage can be unavailable in unusual webview modes; failing to persist is non-fatal.
  }
}

export interface DocZoomDeps {
  /** Structural — see file header on why this isn't html-surface.ts's `HtmlSurface` type. */
  getHtmlSurfaceDoc: () => Document | null | undefined;
}

export interface DocZoomApi {
  /** Also wired onto the HTML iframe's own document (surface.ts's onHtmlReady), mirroring ⌘F/⌘⇧D. */
  handleZoomShortcut: (e: KeyboardEvent) => void;
  /** Apply the CURRENT zoom to a freshly-loaded iframe document (surface.ts's onHtmlReady). */
  applyToIframeDoc: (doc: Document) => void;
  /** Wire pinch (ctrlKey wheel + WebKit GestureEvent where available) onto an
   * arbitrary target — this module calls it once itself for the markdown
   * sheet's own `.doc` area; surface.ts's onHtmlReady calls it again on every
   * freshly-loaded iframe document (a fresh `srcdoc` navigation is a new
   * Document with no listeners of its own yet — same reasoning as the
   * keydown handler re-added right next to it). See file header. */
  wirePinchZoom: (target: EventTarget) => void;
  getZoom: () => number;
}

export function initDocZoom(deps: DocZoomDeps): DocZoomApi {
  const docAreaEl = document.querySelector<HTMLElement>(".doc")!;
  const zoomOutBtn = document.querySelector<HTMLButtonElement>("#docZoomOutBtn")!;
  const zoomPctBtn = document.querySelector<HTMLButtonElement>("#docZoomPctBtn")!;
  const zoomInBtn = document.querySelector<HTMLButtonElement>("#docZoomInBtn")!;
  let zoom = loadDocZoom();

  function applyToRoot(): void {
    document.documentElement.style.setProperty("--doc-zoom", String(zoom));
    applyZoomToIframeDoc(deps.getHtmlSurfaceDoc(), zoom);
  }

  /** Live-updates the persistent topbar control — the ONE zoom indicator now
   * (see file header on why the old transient toast is gone). Called from
   * every path that changes `zoom` (keyboard, the control's own buttons,
   * pinch, gesture) so it never drifts from the actually-applied zoom. */
  function updateControl(): void {
    zoomPctBtn.textContent = zoomPercentLabel(zoom);
  }

  function commitZoom(next: number): void {
    zoom = next;
    applyToRoot();
    saveDocZoom(zoom);
    updateControl();
  }

  /** Discrete 0.1-step path — the keyboard shortcut and the control's own ±/reset buttons. */
  function setZoom(next: number): void {
    commitZoom(clampDocZoom(next));
  }

  /** Continuous path — pinch/gesture input (see file header on why it skips the 0.1 rounding). */
  function setZoomContinuous(next: number): void {
    commitZoom(clampDocZoomRange(next));
  }

  function handleZoomShortcut(e: KeyboardEvent): void {
    if (e.isComposing) return;
    if (!(e.metaKey || e.ctrlKey)) return;
    if (e.key === "0") {
      e.preventDefault();
      setZoom(DOC_ZOOM_DEFAULT);
    } else if (e.key === "+" || e.key === "=") {
      e.preventDefault();
      setZoom(zoom + DOC_ZOOM_STEP);
    } else if (e.key === "-") {
      e.preventDefault();
      setZoom(zoom - DOC_ZOOM_STEP);
    }
  }

  // --- pinch: ctrlKey wheel + WebKit GestureEvent — see file header ---
  const supportsGestureEvents = "GestureEvent" in window;
  let gestureStartZoom = zoom;

  function onWheelZoom(e: Event): void {
    const we = e as WheelEvent;
    if (!we.ctrlKey) return; // a plain two-finger scroll over the document must not zoom it
    we.preventDefault(); // stop the OS/browser page-zoom this would otherwise trigger
    if (supportsGestureEvents) return; // this engine's GestureEvents already drive the zoom below — avoid double-applying the same physical pinch
    const factor = Math.exp(-we.deltaY * DOC_ZOOM_WHEEL_SENSITIVITY);
    setZoomContinuous(zoom * factor);
  }

  function onGestureStart(e: Event): void {
    e.preventDefault();
    gestureStartZoom = zoom;
  }
  function onGestureChange(e: Event): void {
    e.preventDefault();
    const scale = (e as unknown as { scale: number }).scale;
    setZoomContinuous(gestureStartZoom * scale);
  }
  function onGestureEnd(e: Event): void {
    e.preventDefault();
  }

  function wirePinchZoom(target: EventTarget): void {
    target.addEventListener("wheel", onWheelZoom, { passive: false });
    if (supportsGestureEvents) {
      target.addEventListener("gesturestart", onGestureStart);
      target.addEventListener("gesturechange", onGestureChange);
      target.addEventListener("gestureend", onGestureEnd);
    }
  }

  window.addEventListener("keydown", handleZoomShortcut, true);
  wirePinchZoom(docAreaEl); // the markdown sheet's own pinch target; the HTML iframe surface gets its own via the exported wirePinchZoom (surface.ts's onHtmlReady)
  zoomOutBtn.addEventListener("click", () => setZoom(zoom - DOC_ZOOM_STEP));
  zoomInBtn.addEventListener("click", () => setZoom(zoom + DOC_ZOOM_STEP));
  zoomPctBtn.addEventListener("click", () => setZoom(DOC_ZOOM_DEFAULT));
  applyToRoot(); // apply the restored (or default) zoom before first paint
  updateControl(); // ...and its label, before first paint

  return {
    handleZoomShortcut,
    applyToIframeDoc: (doc) => applyZoomToIframeDoc(doc, zoom),
    wirePinchZoom,
    getZoom: () => zoom,
  };
}
