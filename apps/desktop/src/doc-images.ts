// Images in documents: drop or paste one onto either surface and it is stored in the
// document's `.had/assets/` folder (by the sidecar) and linked from the document by a
// relative path. This module also makes relative image links render at all: the webview's
// page is not a file origin, so `<img src="pics/a.png">` would resolve against the app,
// not the document. Every local image is fetched through the sidecar's `/image` route
// instead, while the document itself keeps the plain relative path.
//
// An image is an edit. An HTML document opens in review mode, where nothing the user does
// to the page changes it; images are refused there, with a visible pointer to the Edit
// button, exactly as typing is. Markdown documents are always editable.
//
// Placement: a drop has no visible caret on either surface, so a dropped image becomes its
// own block next to the block it was dropped on (above when dropped on its top half). A
// paste or File ▸ Insert Image has a caret, so it goes there.
import { isDocumentName } from "./doc-drop.js";
import type { Editor } from "@milkdown/kit/core";
import { editorViewCtx } from "@milkdown/kit/core";
import { imageSchema } from "@milkdown/kit/preset/commonmark";
import { $view } from "@milkdown/kit/utils";
import type { EditorView } from "@milkdown/kit/prose/view";
import { IMG_SRC_ATTR, type HtmlSurface } from "./html-surface.js";
import { docdToken } from "./rpc.js";

export { IMG_SRC_ATTR, restoreHtmlImages } from "./html-surface.js";

const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|svg|avif|bmp|ico)$/i;
const MIME_EXT: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/svg+xml": ".svg",
  "image/avif": ".avif",
  "image/bmp": ".bmp",
  "image/x-icon": ".ico",
};

/** Directory of a document path (POSIX separators, as everywhere in the desktop app). */
function dirOf(docPath: string): string {
  return docPath.slice(0, Math.max(0, docPath.lastIndexOf("/")));
}

/** Collapse `.` and `..` segments of an absolute POSIX path. */
function normalizePath(path: string): string {
  const out: string[] = [];
  for (const seg of path.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return `/${out.join("/")}`;
}

function decode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s; // an authored invalid escape: use it as written
  }
}

/**
 * Absolute filesystem path an image `src` refers to, or null when it is not a local file
 * (http(s), data:, blob:, protocol-relative, or empty).
 */
export function localImagePath(docPath: string, src: string): string | null {
  const raw = src.trim();
  if (!raw || raw.startsWith("//")) return null;
  // file:///p, file://host/p and the single-slash file:/p all name the path /p.
  if (/^file:/i.test(raw)) return normalizePath(decode(raw.replace(/^file:(\/\/[^/]*)?/i, "").replace(/[?#].*$/, "")));
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return null;
  const path = decode(raw.replace(/[?#].*$/, ""));
  if (!path) return null;
  return normalizePath(path.startsWith("/") ? path : `${dirOf(docPath)}/${path}`);
}

/**
 * The sidecar's `GET /image` URL for an absolute image path. Carries the launch token, which
 * docd requires; it only ever lives in the live DOM (the saved document keeps the authored src).
 */
export function sidecarImageUrl(path: string, port: number): string {
  const token = docdToken();
  const auth = token ? `&token=${encodeURIComponent(token)}` : "";
  return `http://127.0.0.1:${port}/image?path=${encodeURIComponent(path)}${auth}`;
}

/** URL the webview should load for an image `src` written in the document at `docPath`. */
export function resolveImageSrc(docPath: string | undefined, src: string, port: number): string {
  if (!docPath) return src;
  const path = localImagePath(docPath, src);
  if (!path || !IMAGE_EXT_RE.test(path)) return src;
  return sidecarImageUrl(path, port);
}

const SERVED_RE = /^http:\/\/127\.0\.0\.1:\d+\/image\?path=([^&#]+)/;

/** Reads an image file's bytes through the sidecar's RPC channel. */
export type ImageReader = (path: string) => Promise<{ mime: string; dataBase64: string }>;

/**
 * If a sidecar-served image fails to load (a webview that refuses plain-HTTP images, a
 * sidecar restart that changed the port), fetch the same file over the RPC channel and
 * show it as a data URL. One attempt per element and URL; a file that is really missing
 * stays a broken image.
 */
export function withImageFallback(img: HTMLImageElement, read: ImageReader): void {
  if (img.dataset.hadFallback === "1") return;
  img.dataset.hadFallback = "1";
  let tried = "";
  img.addEventListener("error", () => {
    const src = img.getAttribute("src") ?? "";
    const m = SERVED_RE.exec(src);
    if (!m || tried === src) return;
    tried = src;
    void read(decodeURIComponent(m[1]))
      .then((r) => {
        if (img.getAttribute("src") === src) img.setAttribute("src", `data:${r.mime};base64,${r.dataBase64}`);
      })
      .catch(() => {});
  });
}

/** The image files in a drop or paste (by MIME type, or by extension when the type is blank). */
export function imageFilesFrom(dt: DataTransfer | null | undefined): File[] {
  if (!dt) return [];
  const files = Array.from(dt.files ?? []);
  return files.filter((f) => f.type.startsWith("image/") || IMAGE_EXT_RE.test(f.name));
}

/** True while a drag carries files (their names are not readable until the drop). */
function dragHasFiles(dt: DataTransfer | null): boolean {
  return !!dt && Array.from(dt.types ?? []).includes("Files");
}

/** Dropped files docuzen opens as documents rather than inserting. */
export function documentFilesFrom(dt: DataTransfer | null | undefined): File[] {
  return Array.from(dt?.files ?? []).filter((f) => isDocumentName(f.name));
}

/**
 * Whether a drag in progress is images only. Names are hidden until the drop, but WebKit
 * and Chromium report each file's MIME type; an unknown type might be a document.
 */
function dragIsOnlyImages(dt: DataTransfer | null): boolean {
  const files = Array.from(dt?.items ?? []).filter((i) => i.kind === "file");
  return files.length > 0 && files.every((i) => i.type.startsWith("image/"));
}

/** What the user is told when a drop holds nothing docuzen can use. */
function unusableDropMessage(files: File[]): string {
  const names = files.map((f) => f.name).join(", ");
  return `Can't use ${names || "that"} here: docuzen opens .md, .html and .hadz files, and adds images dropped onto a document.`;
}

/**
 * File name to store an image under. Clipboard images all arrive as `image.png`, so those
 * get a timestamp; a file with a type but no usable extension gets one from its type.
 */
export function storedImageName(file: { name: string; type: string }, now: Date = new Date()): string {
  const ext = IMAGE_EXT_RE.test(file.name) ? "" : MIME_EXT[file.type] ?? ".png";
  const name = `${file.name || "image"}${ext}`;
  if (!/^image\.[a-z]+$/i.test(name)) return name;
  const p = (n: number): string => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  return name.replace(/^image/i, `pasted-${stamp}`);
}

/** Alt text from a stored file name: `release-plan_v2.png` -> `release plan v2`. */
export function altFromName(name: string): string {
  return name.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ").trim();
}

async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(bin);
}

/**
 * Point every local `<img>` in an HTML document at the sidecar, remembering the authored
 * `src` in `data-had-src` (html-surface.ts's serializer restores it, so the saved file
 * never contains a sidecar URL). Idempotent.
 */
export function rewriteHtmlImages(doc: Document, docPath: string, port: number, read?: ImageReader): void {
  for (const img of Array.from(doc.querySelectorAll<HTMLImageElement>("img[src]"))) {
    if (img.hasAttribute(IMG_SRC_ATTR)) continue;
    const authored = img.getAttribute("src") ?? "";
    const live = resolveImageSrc(docPath, authored, port);
    if (live === authored) continue;
    img.setAttribute(IMG_SRC_ATTR, authored);
    if (read) withImageFallback(img, read);
    img.setAttribute("src", live);
  }
}

/**
 * The image node, with one fix: markdown's `![alt](src)` has no title, the parser hands
 * that over as null, and the stock schema then rejects the node ("expected string for
 * attribute title") — the image silently vanished from the editor, and from the file on
 * the next save. Missing alt/title become empty strings instead. Must be `.use()`d after
 * the commonmark preset so it replaces the stock node.
 */
export const safeImageSchema = imageSchema.extendSchema((prev) => (ctx) => {
  const base = prev(ctx);
  return {
    ...base,
    parseMarkdown: {
      match: base.parseMarkdown.match,
      runner: (state, node, type) => {
        state.addNode(type, {
          src: typeof node.url === "string" ? node.url : "",
          alt: typeof node.alt === "string" ? node.alt : "",
          title: typeof node.title === "string" ? node.title : "",
        });
      },
    },
  };
});

/**
 * Milkdown node view for images: the node keeps the document's own `src`, the rendered
 * `<img>` loads the resolved one. `resolve` is read at render time, so a tab switch (which
 * replaces the whole document) picks up the new document's directory.
 */
export function makeImageView(resolve: (src: string) => string, read?: ImageReader) {
  return $view(safeImageSchema.node, () => (initialNode) => {
    const dom = document.createElement("img");
    if (read) withImageFallback(dom, read);
    let shown: string | null = null;
    const apply = (node: typeof initialNode): void => {
      // Only a changed link reloads the image: re-rendering the same node (any edit nearby)
      // must not throw away an RPC fallback that is already showing it.
      const src = resolve(String(node.attrs.src ?? ""));
      if (src !== shown) dom.src = shown = src;
      dom.alt = String(node.attrs.alt ?? "");
      if (node.attrs.title) dom.title = String(node.attrs.title);
      else dom.removeAttribute("title");
    };
    apply(initialNode);
    return {
      dom,
      update: (updated) => {
        if (updated.type !== initialNode.type) return false;
        apply(updated);
        return true;
      },
    };
  });
}

const HTML_BLOCKS = "p,h1,h2,h3,h4,h5,h6,pre,blockquote,figure,table,ul,ol,dl,hr";
const HTML_CONTAINERS = "table,ul,ol,dl,blockquote,figure,pre";
const HTML_NS = "http://www.w3.org/1999/xhtml";
/** HTML elements whose content is flow content, so a new paragraph may go inside one. */
const FLOW_CONTAINERS = new Set([
  "BODY", "DIV", "SECTION", "ARTICLE", "MAIN", "ASIDE", "HEADER", "FOOTER", "NAV", "LI", "TD", "TH", "DD",
  "FIGURE", "BLOCKQUOTE", "DETAILS", "DIALOG", "FORM", "FIELDSET", "ADDRESS", "CENTER", "SEARCH",
]);

/**
 * Whether a new image paragraph can live inside `el` and be saved: an HTML flow container
 * (or a custom element), never a void or inline element (an `<img>`'s children are not
 * drawn and not saved), never SVG or MathML, never one of docuzen's own overlays.
 */
function holdsBlocks(el: Element): boolean {
  return (
    el.namespaceURI === HTML_NS &&
    !el.hasAttribute("data-had-overlay") &&
    (FLOW_CONTAINERS.has(el.tagName) || el.tagName.includes("-"))
  );
}

/** Where a drop at (x, y) should put a new block in an HTML document. */
export function htmlDropTarget(doc: Document, x: number, y: number): { parent: Node; before: Node | null } {
  const body = doc.body;
  let hit = doc.elementFromPoint?.(x, y) ?? null;
  if (hit && !body.contains(hit)) hit = null;
  // A drop on a comment badge or proposal card belongs next to the card (those are removed
  // on save, and an image inside one would go with it); a drop on a diagram or a formula,
  // even on an HTML label inside its SVG, belongs next to the whole diagram.
  for (const unit of ["[data-had-overlay]", "svg, math"]) {
    for (let el = hit?.closest(unit); el && hit; el = el.parentElement?.closest(unit)) hit = el;
  }
  let block = hit?.closest(HTML_BLOCKS) ?? null;
  // Never land inside a list, table or quote: use the outermost such container.
  for (let outer = block?.parentElement?.closest(HTML_CONTAINERS); outer && block; outer = block.parentElement?.closest(HTML_CONTAINERS)) {
    block = outer;
  }
  if (block && block !== body && block.parentNode) {
    const r = block.getBoundingClientRect();
    return { parent: block.parentNode, before: y < r.top + r.height / 2 ? block : block.nextSibling };
  }
  // Dropped on an image, a video, a diagram or inline text outside any block: climb to the
  // container that holds it and go before or after the element that was hit.
  let container: Element = hit ?? body;
  let inner: Element | null = null;
  while (container !== body && !holdsBlocks(container) && container.parentElement) {
    inner = container;
    container = container.parentElement;
  }
  if (inner) {
    const r = inner.getBoundingClientRect();
    return { parent: container, before: y < r.top + r.height / 2 ? inner : inner.nextSibling };
  }
  // Dropped on a gap or a plain container: before the first child that starts below the pointer.
  for (const child of Array.from(container.children)) {
    if (child.hasAttribute("data-had-overlay")) continue;
    const r = child.getBoundingClientRect();
    if (r.height > 0 && y < r.top + r.height / 2) return { parent: container, before: child };
  }
  return { parent: container, before: null };
}

function htmlImageBlock(doc: Document, src: string, alt: string, live: string, read: ImageReader): HTMLElement {
  const p = doc.createElement("p");
  p.appendChild(htmlImage(doc, src, alt, live, read));
  return p;
}

function htmlImage(doc: Document, src: string, alt: string, live: string, read: ImageReader): HTMLImageElement {
  const img = doc.createElement("img");
  withImageFallback(img, read);
  img.setAttribute("alt", alt);
  img.setAttribute("style", "max-width: 100%; height: auto;");
  img.setAttribute("src", live);
  if (live !== src) img.setAttribute(IMG_SRC_ATTR, src);
  return img;
}

export interface SavedImageRef {
  relPath: string;
  name: string;
}

export interface DocImagesDeps {
  /** `#editor`, the markdown surface's mount point. */
  rootEl: HTMLElement;
  log: (line: string) => void;
  reportError: (scope: string, e: unknown) => void;
  getEditor: () => Editor | undefined;
  getHtmlSurface: () => HtmlSurface | null | undefined;
  getDocPath: () => string | undefined;
  getFormat: () => "markdown" | "html";
  port: () => number;
  saveImage: (p: { name: string; dataBase64?: string; sourcePath?: string }) => Promise<SavedImageRef>;
  /** Fallback read of an image's bytes when the webview cannot load it over HTTP. */
  readImage: ImageReader;
  /** Tell the user something they need to act on (shown over the document, not only logged). */
  notify: (message: string) => void;
  /** An image was inserted into the HTML document (marks the tab dirty). */
  onHtmlEdited: () => void;
  /** Document files (.md, .html, .hadz) were dropped anywhere in the window: open them. */
  onDocumentsDropped: (files: File[]) => void;
}

export type Placement = { kind: "drop"; x: number; y: number } | { kind: "caret" };

export interface DocImagesApi {
  /** Wire drop + paste onto a freshly loaded HTML document, and resolve its existing images. */
  wireHtmlDocument(doc: Document): void;
  /** Store image files and insert them into the active document. */
  addFiles(files: File[], at: Placement): Promise<void>;
  /** Store images by filesystem path (the native picker) and insert them at the caret. */
  addPaths(paths: string[]): Promise<void>;
  /** Whether the active document can take an image now; tells the user why when it cannot. */
  canInsert(): boolean;
  /** Resolve an image `src` of the active document for display. */
  resolve(src: string): string;
  /** The RPC fallback reader (for the markdown image view). */
  read: ImageReader;
}

export function initDocImages(deps: DocImagesDeps): DocImagesApi {
  const resolve = (src: string): string => resolveImageSrc(deps.getDocPath(), src, deps.port());

  function withView<T>(fn: (view: EditorView) => T): T | undefined {
    return deps.getEditor()?.action((ctx) => fn(ctx.get(editorViewCtx)));
  }

  function insertMarkdown(images: SavedImageRef[], at: Placement): void {
    withView((view) => {
      const { schema, doc } = view.state;
      const imageType = schema.nodes.image;
      const paragraph = schema.nodes.paragraph;
      if (!imageType || !paragraph) return;
      const nodes = images.map((i) => imageType.create({ src: i.relPath, alt: altFromName(i.name), title: "" }));
      let tr = view.state.tr;
      if (at.kind === "caret") {
        for (const node of nodes) tr = tr.replaceSelectionWith(node, false);
        view.dispatch(tr.scrollIntoView());
        return;
      }
      const hit = view.posAtCoords({ left: at.x, top: at.y });
      let pos = doc.content.size;
      let replaceTo: number | null = null;
      if (hit) {
        const $pos = doc.resolve(hit.pos);
        if ($pos.depth === 0) pos = hit.pos;
        else {
          const before = $pos.before(1);
          const after = $pos.after(1);
          const block = $pos.node(1);
          const rect = (view.nodeDOM(before) as HTMLElement | null)?.getBoundingClientRect?.();
          // An empty paragraph is a placeholder: the image takes its place.
          if (block.type === paragraph && block.content.size === 0) {
            pos = before;
            replaceTo = after;
          } else pos = rect && at.y < rect.top + rect.height / 2 ? before : after;
        }
      }
      const blocks = nodes.map((n) => paragraph.create(null, n));
      tr = replaceTo === null ? tr.insert(pos, blocks) : tr.replaceWith(pos, replaceTo, blocks);
      view.dispatch(tr.scrollIntoView());
    });
  }

  function insertHtml(images: SavedImageRef[], at: Placement): void {
    const doc = deps.getHtmlSurface()?.doc;
    if (!doc?.body) return;
    const live = (i: SavedImageRef): string => resolve(i.relPath);
    if (at.kind === "drop") {
      const { parent, before } = htmlDropTarget(doc, at.x, at.y);
      for (const i of images) parent.insertBefore(htmlImageBlock(doc, i.relPath, altFromName(i.name), live(i), deps.readImage), before);
    } else {
      const sel = doc.getSelection();
      const range = sel && sel.rangeCount > 0 && doc.body.contains(sel.getRangeAt(0).endContainer) ? sel.getRangeAt(0).cloneRange() : null;
      if (range) {
        range.collapse(false);
        // Reverse so the first image ends up first (each insert lands at the same point).
        for (const i of [...images].reverse()) range.insertNode(htmlImage(doc, i.relPath, altFromName(i.name), live(i), deps.readImage));
      } else {
        for (const i of images) doc.body.appendChild(htmlImageBlock(doc, i.relPath, altFromName(i.name), live(i), deps.readImage));
      }
    }
    deps.onHtmlEdited();
  }

  /** Why the active document cannot take an image right now, or null when it can. */
  function refusal(): string | null {
    if (!deps.getDocPath()) return "Open or create a document before adding an image.";
    if (deps.getFormat() === "html" && !deps.getHtmlSurface()?.isEditable) {
      return "This document is in review mode. Click Edit to add images.";
    }
    return null;
  }

  /** True (after telling the user why) when an image must not be added. */
  function refused(): boolean {
    const why = refusal();
    if (why) {
      deps.notify(why);
      deps.log(`image not added: ${why}`);
    }
    return why !== null;
  }

  async function insertSaved(docPath: string, saved: SavedImageRef[], at: Placement): Promise<void> {
    if (!saved.length) return;
    // The saves are async: only insert if the user is still on the document they dropped on.
    if (deps.getDocPath() !== docPath) return void deps.log("image saved, but the document changed before it could be inserted");
    if (refused()) return; // Edit was switched off while the image was being stored
    if (deps.getFormat() === "html") insertHtml(saved, at);
    else insertMarkdown(saved, at);
    deps.log(`inserted ${saved.length} image(s): ${saved.map((s) => s.name).join(", ")}`);
  }

  async function addFiles(files: File[], at: Placement): Promise<void> {
    if (refused()) return; // checked before anything is written to disk
    const docPath = deps.getDocPath();
    if (!docPath) return;
    const saved: SavedImageRef[] = [];
    for (const file of files) {
      try {
        saved.push(await deps.saveImage({ name: storedImageName(file), dataBase64: await fileToBase64(file) }));
      } catch (e) {
        deps.reportError(`add image ${file.name}`, e);
      }
    }
    await insertSaved(docPath, saved, at);
  }

  async function addPaths(paths: string[]): Promise<void> {
    if (refused()) return;
    const docPath = deps.getDocPath();
    if (!docPath) return;
    const saved: SavedImageRef[] = [];
    for (const sourcePath of paths) {
      try {
        saved.push(await deps.saveImage({ name: sourcePath.split("/").pop() ?? "image.png", sourcePath }));
      } catch (e) {
        deps.reportError(`add image ${sourcePath}`, e);
      }
    }
    await insertSaved(docPath, saved, { kind: "caret" });
  }

  /** Drop + paste wiring for one surface (the markdown mount point, or an HTML document). */
  function wire(target: Document | HTMLElement): void {
    target.addEventListener("dragover", (e) => {
      const ev = e as DragEvent;
      if (!dragHasFiles(ev.dataTransfer)) return;
      ev.preventDefault();
      // Refuse only an image drop the document can't take now; a document always opens.
      if (ev.dataTransfer) ev.dataTransfer.dropEffect = refusal() && dragIsOnlyImages(ev.dataTransfer) ? "none" : "copy";
    });
    target.addEventListener(
      "drop",
      (e) => {
        const ev = e as DragEvent;
        if (!dragHasFiles(ev.dataTransfer)) return;
        // A dropped file must never reach the editor's own handling or navigate the webview.
        ev.preventDefault();
        ev.stopPropagation();
        // Documents open in their own tab; images dropped with them are not added here.
        if (openDroppedDocuments(ev.dataTransfer)) return;
        const files = imageFilesFrom(ev.dataTransfer);
        if (!files.length) return void deps.notify(unusableDropMessage(Array.from(ev.dataTransfer?.files ?? [])));
        void addFiles(files, { kind: "drop", x: ev.clientX, y: ev.clientY });
      },
      true,
    );
    target.addEventListener(
      "paste",
      (e) => {
        const ev = e as ClipboardEvent;
        const files = imageFilesFrom(ev.clipboardData);
        // Copying from a web page or a spreadsheet puts text AND a picture of it on the
        // clipboard; the text is what the user means.
        const hasText = Array.from(ev.clipboardData?.types ?? []).some((t) => t === "text/plain" || t === "text/html");
        if (!files.length || hasText) return;
        ev.preventDefault();
        ev.stopPropagation();
        void addFiles(files, { kind: "caret" });
      },
      true,
    );
  }

  /** Hand dropped documents to the shell; true when the drop held any. */
  function openDroppedDocuments(dt: DataTransfer | null): boolean {
    const docs = documentFilesFrom(dt);
    if (!docs.length) return false;
    const skipped = Array.from(dt?.files ?? []).filter((f) => !docs.includes(f));
    if (skipped.length) deps.log(`dropped with documents, not added: ${skipped.map((f) => f.name).join(", ")}`);
    deps.onDocumentsDropped(docs);
    return true;
  }

  wire(deps.rootEl);
  // Anywhere else in the window (chat, rails, the empty state), a dropped file would
  // otherwise replace the app with that file. Documents open; anything else is explained.
  window.addEventListener("dragover", (e) => {
    const dt = (e as DragEvent).dataTransfer;
    // Already answered by a document surface it bubbled up from.
    if (!dragHasFiles(dt) || e.defaultPrevented) return;
    e.preventDefault();
    if (dt) dt.dropEffect = dragIsOnlyImages(dt) ? "none" : "copy";
  });
  window.addEventListener("drop", (e) => {
    const dt = (e as DragEvent).dataTransfer;
    if (!dragHasFiles(dt)) return;
    e.preventDefault();
    if (openDroppedDocuments(dt)) return;
    if (imageFilesFrom(dt).length) return void deps.notify("Drop images onto the document to add them.");
    deps.notify(unusableDropMessage(Array.from(dt?.files ?? [])));
  });

  function wireHtmlDocument(doc: Document): void {
    wire(doc);
    const docPath = deps.getDocPath();
    if (docPath) rewriteHtmlImages(doc, docPath, deps.port(), deps.readImage);
  }

  return { wireHtmlDocument, addFiles, addPaths, canInsert: () => !refused(), resolve, read: deps.readImage };
}
