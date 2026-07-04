// Faithful HTML editing/annotation surface. Unlike the markdown path (which runs
// through Milkdown/ProseMirror), HTML is rendered in an iframe so arbitrary CSS and
// scripts render exactly as authored. The iframe body is contenteditable for true
// WYSIWYG editing, and the document is serialized back to HTML on save — no lossy
// markdown round-trip. Annotation overlays (Phase 2) live inside the iframe and are
// stripped on serialization so they never leak into the saved file.

export interface HtmlSurfaceCallbacks {
  /** Fired (debounced) when the user edits the rendered document. */
  onEdit?: () => void;
  /** Fired when the selection inside the iframe changes. */
  onSelection?: () => void;
  /** Fired once the iframe document is loaded and editable. */
  onReady?: () => void;
}

/** Marker attributes for elements we inject so serialization can strip them. */
const BASE_ATTR = "data-had-base";

/**
 * Serialize a live iframe Document back to an HTML string, stripping editing
 * artifacts (injected <base>, contenteditable) and any annotation overlays so the
 * saved file is the user's HTML only. Annotation marks (Phase 2) are unwrapped.
 */
export function serializeDocument(doc: Document): string {
  const root = doc.documentElement.cloneNode(true) as HTMLElement;
  root.querySelectorAll(`[${BASE_ATTR}]`).forEach((n) => n.remove());
  root.querySelectorAll("[data-had-overlay]").forEach((n) => n.remove());
  // doc-zoom.ts's injected `:root { font-size: … }` style tag — a view-only zoom
  // preference, never part of the document's own saved HTML (mirrors data-had-overlay).
  root.querySelectorAll("[data-had-zoom]").forEach((n) => n.remove());
  root.querySelectorAll("[contenteditable]").forEach((n) => n.removeAttribute("contenteditable"));
  // Unwrap transient in-document search spans; search state is UI-only.
  root.querySelectorAll("[data-had-search]").forEach((span) => {
    const parent = span.parentNode;
    if (!parent) return;
    while (span.firstChild) parent.insertBefore(span.firstChild, span);
    parent.removeChild(span);
  });
  // Unwrap annotation highlight spans, preserving their text content in place.
  root.querySelectorAll("[data-had-mark]").forEach((span) => {
    const parent = span.parentNode;
    if (!parent) return;
    while (span.firstChild) parent.insertBefore(span.firstChild, span);
    parent.removeChild(span);
  });
  const dt = doc.doctype;
  const doctype = dt
    ? `<!doctype ${dt.name}${dt.publicId ? ` PUBLIC "${dt.publicId}"` : ""}${dt.systemId ? ` "${dt.systemId}"` : ""}>\n`
    : "<!doctype html>\n";
  return doctype + root.outerHTML + "\n";
}

export class HtmlSurface {
  private iframe: HTMLIFrameElement | null = null;
  private editDebounce: number | null = null;
  // Default to NON-editable ("review" mode): links, buttons, scripts, and normal clicks
  // work, and text is still selectable for highlight/comment. Editing is opt-in so a
  // contenteditable body doesn't swallow clicks on links/controls.
  private editable = false;

  constructor(
    private host: HTMLElement,
    private cb: HtmlSurfaceCallbacks = {},
  ) {}

  private ensureIframe(): HTMLIFrameElement {
    if (this.iframe) return this.iframe;
    const f = document.createElement("iframe");
    f.className = "htmlframe";
    // allow-scripts: run the doc's scripts (user decision D2). allow-same-origin:
    // required so we can read/edit/serialize contentDocument and host annotations.
    // allow-popups-to-escape-sandbox keeps user-initiated target=_blank/window.open
    // flows from inheriting a sandbox that makes them appear to do nothing.
    f.setAttribute(
      "sandbox",
      "allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals",
    );
    this.host.appendChild(f);
    this.iframe = f;
    return f;
  }

  /** Render `html` into the iframe; `baseHref` lets relative asset refs resolve. */
  load(html: string, baseHref?: string): void {
    const f = this.ensureIframe();
    f.onload = () => {
      const doc = f.contentDocument;
      if (!doc) return;
      if (baseHref && doc.head) {
        const base = doc.createElement("base");
        base.setAttribute("href", baseHref);
        base.setAttribute(BASE_ATTR, "");
        doc.head.prepend(base);
      }
      if (doc.body) {
        doc.body.contentEditable = this.editable ? "true" : "false";
        doc.body.spellcheck = false;
        doc.body.addEventListener("input", () => {
          if (this.editDebounce) clearTimeout(this.editDebounce);
          this.editDebounce = setTimeout(() => this.cb.onEdit?.(), 200) as unknown as number;
        });
      }
      doc.addEventListener("selectionchange", () => this.cb.onSelection?.());
      this.cb.onReady?.();
    };
    f.srcdoc = html;
  }

  /** Toggle WYSIWYG editing. When off, the doc is a normal interactive page (links/clicks work). */
  setEditable(on: boolean): void {
    this.editable = on;
    const body = this.doc?.body;
    if (body) body.contentEditable = on ? "true" : "false";
  }

  /** Whether WYSIWYG editing is currently on. */
  get isEditable(): boolean {
    return this.editable;
  }

  /** The live iframe document, or null before load. */
  get doc(): Document | null {
    return this.iframe?.contentDocument ?? null;
  }

  /** The iframe element (for viewport-relative positioning), or null before load. */
  get frameEl(): HTMLIFrameElement | null {
    return this.iframe;
  }

  /** Serialize the current document state back to an HTML string. */
  getHtml(): string {
    const doc = this.doc;
    return doc ? serializeDocument(doc) : "";
  }

  show(): void {
    this.host.hidden = false;
  }

  hide(): void {
    this.host.hidden = true;
  }
}

/** Best-effort file URL for a document's directory, used as the iframe <base>. */
export function baseHrefForDoc(docPath: string): string {
  const dir = docPath.slice(0, Math.max(0, docPath.lastIndexOf("/")));
  return `file://${dir}/`;
}
