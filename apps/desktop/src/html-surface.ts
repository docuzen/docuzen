// Faithful HTML editing/annotation surface. Unlike the markdown path (which runs
// through Milkdown/ProseMirror), HTML is rendered in an iframe so arbitrary CSS and
// scripts render exactly as authored. The iframe body is contenteditable for true
// WYSIWYG editing, and the document is serialized back to HTML on save — no lossy
// markdown round-trip. Annotation overlays (Phase 2) live inside the iframe and are
// stripped on serialization so they never leak into the saved file.
import { clearRangeBlocks } from "./long-range.js";

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
 * On a document's own element, the authored values of the attributes docuzen set on it (a
 * JSON map, `null` = the author had none), so serialization puts back exactly what was there.
 */
const INJECTED_ATTRS = "data-had-attrs";

/** Set `name` on one of the document's own elements, remembering the author's value for saving. */
export function setInjectedAttr(el: Element, name: string, value: string): void {
  const original = readInjectedAttrs(el);
  if (!(name in original)) {
    original[name] = el.getAttribute(name);
    el.setAttribute(INJECTED_ATTRS, JSON.stringify(original));
  }
  el.setAttribute(name, value);
}

function readInjectedAttrs(el: Element): Record<string, string | null> {
  try {
    const parsed: unknown = JSON.parse(el.getAttribute(INJECTED_ATTRS) ?? "{}");
    return parsed && typeof parsed === "object" ? (parsed as Record<string, string | null>) : {};
  } catch {
    return {};
  }
}

/** Put back the author's values of every attribute docuzen set (see setInjectedAttr). */
function restoreInjectedAttrs(root: Element): void {
  for (const el of Array.from(root.querySelectorAll(`[${INJECTED_ATTRS}]`))) {
    for (const [name, value] of Object.entries(readInjectedAttrs(el))) {
      if (value === null) el.removeAttribute(name);
      else el.setAttribute(name, value);
    }
    el.removeAttribute(INJECTED_ATTRS);
  }
}
/** Holds an image's authored `src` while the live one points at the sidecar (doc-images.ts). */
export const IMG_SRC_ATTR = "data-had-src";

/** Put every image's authored `src` back (the live one is a sidecar URL, never saved). */
export function restoreHtmlImages(root: ParentNode): void {
  for (const img of Array.from(root.querySelectorAll(`img[${IMG_SRC_ATTR}]`))) {
    img.setAttribute("src", img.getAttribute(IMG_SRC_ATTR) ?? "");
    img.removeAttribute(IMG_SRC_ATTR);
    img.removeAttribute("data-had-fallback");
  }
}

/**
 * Serialize a live iframe Document back to an HTML string, stripping editing
 * artifacts (injected <base>, the contenteditable/spellcheck docuzen set) and any annotation
 * overlays so the saved file is the user's HTML only. Annotation marks (Phase 2) are unwrapped.
 * Attributes the author wrote themselves, contenteditable included, are kept.
 */
export function serializeDocument(doc: Document): string {
  const root = doc.documentElement.cloneNode(true) as HTMLElement;
  root.querySelectorAll(`[${BASE_ATTR}]`).forEach((n) => n.remove());
  root.querySelectorAll("[data-had-overlay]").forEach((n) => n.remove());
  restoreHtmlImages(root);
  clearRangeBlocks(root); // long comments' margin-bar attributes on the document's own blocks
  // doc-zoom.ts's injected `:root { font-size: … }` style tag — a view-only zoom
  // preference, never part of the document's own saved HTML (mirrors data-had-overlay).
  root.querySelectorAll("[data-had-zoom]").forEach((n) => n.remove());
  restoreInjectedAttrs(root);
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
  // The parser moves whatever follows </html> (the file's final newline, which this function
  // writes too) into <body>. Put one newline back where it came from, so a load/save round
  // trip leaves the document as it was instead of growing its body by a line every time.
  const tail = root.querySelector("body")?.lastChild;
  if (tail?.nodeType === 3 && tail.textContent?.endsWith("\n")) {
    tail.textContent = tail.textContent.slice(0, -1);
    if (!tail.textContent) tail.remove();
  }
  const dt = doc.doctype;
  const ids = dt?.publicId
    ? ` PUBLIC "${dt.publicId}"${dt.systemId ? ` "${dt.systemId}"` : ""}`
    : dt?.systemId
      ? ` SYSTEM "${dt.systemId}"`
      : "";
  const doctype = dt ? `<!doctype ${dt.name}${ids}>\n` : "<!doctype html>\n";
  return doctype + root.outerHTML + "\n";
}

export class HtmlSurface {
  private iframe: HTMLIFrameElement | null = null;
  private editDebounce: number | null = null;
  // Default to NON-editable ("review" mode): links, buttons, scripts, and normal clicks
  // work, and text is still selectable for highlight/comment. Editing is opt-in so a
  // contenteditable body doesn't swallow clicks on links/controls.
  private editable = false;
  // One load = one document. `load()`/`unload()` bump `loadSeq`; handlers belonging to an
  // older load see a different number and do nothing. Until this load's own onload runs,
  // `readyDoc` is null: the iframe still holds about:blank or the previous document then, and
  // nothing may read it as this one. `edited` is set the moment the user types (not after the
  // 200 ms onEdit debounce), so a tab switch right after typing still keeps the edit.
  private loadSeq = 0;
  private loadedKey: string | undefined;
  private readyDoc: Document | null = null;
  private edited = false;
  /** Whether the iframe holds a page (so `unload` has something to stop). */
  private hasPage = false;

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

  /** Forget the current load: its pending edit callback, readiness and edit state. */
  private resetLoad(): number {
    if (this.editDebounce) clearTimeout(this.editDebounce);
    this.editDebounce = null;
    this.readyDoc = null;
    this.edited = false;
    this.loadedKey = undefined;
    return ++this.loadSeq;
  }

  /**
   * Render `html` into the iframe; `baseHref` lets relative asset refs resolve. `key` names
   * the document (its path) so callers can ask whether the iframe holds it (`editedHtmlFor`).
   */
  load(html: string, baseHref?: string, key?: string): void {
    const f = this.ensureIframe();
    const seq = this.resetLoad();
    this.loadedKey = key;
    this.hasPage = true;
    // A late `load` from the document the frame held before (its initial about:blank, or the
    // previous page) must not be taken for this one.
    const previous = f.contentDocument;
    f.onload = () => {
      if (seq !== this.loadSeq) return;
      const doc = f.contentDocument;
      if (!doc || doc === previous || doc === this.readyDoc) return;
      // Normally already there (withBaseHref); this covers a <head> the string scan missed.
      if (baseHref && doc.head && !doc.querySelector("base[href]")) doc.head.prepend(baseElement(doc, baseHref));
      this.readyDoc = doc;
      if (doc.body) {
        setInjectedAttr(doc.body, "contenteditable", this.editable ? "true" : "false");
        setInjectedAttr(doc.body, "spellcheck", "false");
        doc.body.addEventListener("input", () => {
          // Only typing in Edit mode edits the document. In review mode an input event comes
          // from the page's own form controls, which must never change the saved file.
          if (seq !== this.loadSeq || !this.editable) return;
          this.edited = true;
          if (this.editDebounce) clearTimeout(this.editDebounce);
          this.editDebounce = setTimeout(() => {
            this.editDebounce = null;
            if (seq === this.loadSeq) this.cb.onEdit?.();
          }, 200) as unknown as number;
        });
      }
      doc.addEventListener("selectionchange", () => {
        if (seq === this.loadSeq) this.cb.onSelection?.();
      });
      this.cb.onReady?.();
    };
    f.srcdoc = baseHref ? withBaseHref(html, baseHref) : html;
  }

  /** Empty the iframe so a closed or hidden document stops running (scripts, timers, media). */
  unload(): void {
    this.resetLoad();
    const f = this.iframe;
    if (!f || !this.hasPage) return;
    this.hasPage = false;
    f.onload = null;
    f.srcdoc = "";
  }

  /**
   * The edited document as HTML, when the iframe holds `key`'s document, it has finished
   * loading, and the user edited it during this load. Otherwise null: the caller's stored text
   * is the document (a load in flight shows another document; an unedited page may still have
   * been changed by its own scripts, which is not the user's edit).
   */
  editedHtmlFor(key: string): string | null {
    const doc = this.doc;
    return doc && this.edited && this.loadedKey === key ? serializeDocument(doc) : null;
  }

  /** Count a change made without an input event (an inserted image) as an edit of `key`. */
  markEdited(key: string): void {
    if (this.doc && this.loadedKey === key) this.edited = true;
  }

  /** Toggle WYSIWYG editing. When off, the doc is a normal interactive page (links/clicks work). */
  setEditable(on: boolean): void {
    this.editable = on;
    const body = this.doc?.body;
    if (body) setInjectedAttr(body, "contenteditable", on ? "true" : "false");
  }

  /** Whether WYSIWYG editing is currently on. */
  get isEditable(): boolean {
    return this.editable;
  }

  /**
   * The live iframe document, or null until the current load has finished (and after
   * `unload`, or if the frame navigated elsewhere) — never the previous document.
   */
  get doc(): Document | null {
    const doc = this.iframe?.contentDocument ?? null;
    return doc && doc === this.readyDoc ? doc : null;
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

/**
 * Best-effort file URL for a document's directory, used as the iframe <base>. Each folder name
 * is percent-encoded so `#`, `?` and `%` stay part of the path instead of ending it.
 */
export function baseHrefForDoc(docPath: string): string {
  const dir = docPath.slice(0, Math.max(0, docPath.lastIndexOf("/")));
  return `file://${dir.split("/").map(encodeURIComponent).join("/")}/`;
}

function baseElement(doc: Document, href: string): HTMLBaseElement {
  const base = doc.createElement("base");
  base.setAttribute(BASE_ATTR, "");
  base.setAttribute("href", href);
  return base;
}

/**
 * `html` with `<base data-had-base href>` as the first thing in its head, so the document's
 * first requests (stylesheets, scripts, images) already resolve against its folder. Placed
 * after the doctype (a tag before it would switch the page to quirks mode). A document that
 * sets its own <base> keeps it.
 */
export function withBaseHref(html: string, href: string): string {
  if (/<base\s[^>]*\bhref\s*=/i.test(html)) return html;
  const tag = `<base ${BASE_ATTR} href="${href.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}">`;
  const at = /<head(?:\s[^>]*)?>/i.exec(html) ?? /<html(?:\s[^>]*)?>/i.exec(html) ?? /<!doctype[^>]*>/i.exec(html);
  if (!at) return tag + html;
  const end = at.index + at[0].length;
  return html.slice(0, end) + tag + html.slice(end);
}
