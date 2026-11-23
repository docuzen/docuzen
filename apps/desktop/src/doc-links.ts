// Opening a link written in a document.
//
// Rules (one place, both surfaces):
//   - Where the text is editable (markdown always; HTML with Edit on) a plain click places
//     the caret, and ⌘-click (Ctrl-click) opens the link. Where it is read-only (HTML review
//     mode) a plain click opens it.
//   - `#fragment` scrolls inside the document.
//   - http(s), mailto and tel go to the OS (browser, mail app).
//   - A local path (relative to the document's folder, absolute, or file:) that is a markdown
//     document opens in a docuzen tab. A document, image, audio or video file opens in its
//     default app. Everything else — programs, scripts, folders, files with no or an unknown
//     extension, anything inside an app bundle — is shown in Finder, never opened: a document
//     must not be able to run something with one click. The name is not trusted alone: the
//     sidecar resolves symlinks first, and the file that is really there must qualify too.
//     The opener's scope in src-tauri/capabilities/default.json admits the same extensions.
//   - Any other scheme (javascript:, data:, app-specific) is refused.
//   - Nothing here changes the document.
import { localImagePath } from "./doc-images.js";

export type LinkTarget =
  | { kind: "hash"; id: string }
  | { kind: "url"; url: string }
  /** A markdown document: opens in a docuzen tab. */
  | { kind: "doc"; path: string }
  /** Named like a document or media file: opens in its default app, if the real file is one too. */
  | { kind: "file"; path: string }
  /** Anything else on disk: revealed in Finder instead of opened. */
  | { kind: "reveal"; path: string }
  | { kind: "refused"; reason: string };

/** What a local path really is (the sidecar's `inspectPath`: symlinks resolved). */
export interface PathInfo {
  realPath: string | null;
  kind: "file" | "directory" | "other" | "missing";
}

const WEB_RE = /^(https?|mailto|tel):/i;
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;
const MARKDOWN_RE = /\.(md|markdown)$/i;

/**
 * The only files a link opens with the OS: documents, images, audio and video. Mirrored by
 * the opener scope in src-tauri/capabilities/default.json (a test keeps the two in step), so
 * the native side refuses anything else even if this check were bypassed.
 */
export const OPENABLE_EXTENSIONS = [
  // documents
  "pdf", "txt", "text", "rtf", "doc", "docx", "odt", "pages", "xls", "xlsx", "ods", "numbers",
  "csv", "tsv", "ppt", "pptx", "odp", "key", "epub", "html", "htm", "json", "xml", "yaml", "yml", "log",
  // images
  "png", "jpg", "jpeg", "gif", "webp", "heic", "heif", "tif", "tiff", "bmp", "svg", "avif", "ico",
  // audio
  "mp3", "m4a", "aac", "wav", "aif", "aiff", "flac", "ogg", "oga", "opus",
  // video
  "mp4", "m4v", "mov", "avi", "mkv", "webm", "ogv",
] as const;
const OPENABLE_RE = new RegExp(`\\.(${OPENABLE_EXTENSIONS.join("|")})$`, "i");
/** Folders macOS treats as one program or plug-in. Nothing inside one is opened from a link. */
const BUNDLE_RE = /\.(app|appex|bundle|framework|plugin|kext|xpc|prefpane|saver|qlgenerator|mdimporter|osax|workflow|action|systemextension)$/i;

/** Whether a path lies inside an app (or other) bundle. */
function insideBundle(path: string): boolean {
  return path.split("/").slice(0, -1).some((seg) => BUNDLE_RE.test(seg));
}

/** Whether the OS may open `path` from a link: a document or media name, not inside a bundle. */
export function isOpenable(path: string): boolean {
  return OPENABLE_RE.test(path) && !insideBundle(path);
}

function decode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** What a link `href` written in the document at `docPath` points at. */
export function linkTarget(docPath: string | undefined, href: string): LinkTarget {
  const raw = href.trim();
  if (!raw) return { kind: "refused", reason: "This link has no address." };
  if (raw.startsWith("#")) return { kind: "hash", id: decode(raw.slice(1)) };
  if (raw.startsWith("//")) return { kind: "url", url: `https:${raw}` };
  if (WEB_RE.test(raw)) return { kind: "url", url: raw };
  if (/^[a-z]:[\\/]/i.test(raw)) return { kind: "refused", reason: `"${raw}" is a Windows path; there is no such file on this Mac.` };
  if (SCHEME_RE.test(raw) && !/^file:/i.test(raw)) {
    return { kind: "refused", reason: `docuzen does not open "${raw.slice(0, raw.indexOf(":") + 1)}" links.` };
  }
  if (!docPath) return { kind: "refused", reason: "Save the document before following a relative link." };
  const path = localImagePath(docPath, raw);
  if (!path) return { kind: "refused", reason: "This link has no address." };
  return localTarget(path);
}

/** Classify an absolute local path by its name (see the rules at the top of this file). */
export function localTarget(path: string): LinkTarget {
  const clean = path.replace(/\/+$/, "") || "/";
  if (insideBundle(clean)) return { kind: "reveal", path: clean };
  if (MARKDOWN_RE.test(clean)) return { kind: "doc", path: clean };
  return isOpenable(clean) ? { kind: "file", path: clean } : { kind: "reveal", path: clean };
}

/** GitHub-style heading slug, for `#fragment` links to a heading that carries no id. */
export function headingSlug(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

/** The element a `#fragment` refers to inside `root`: by id, by name, then by heading text. */
export function findFragment(root: ParentNode, id: string): Element | null {
  if (!id) return null;
  for (const el of root.querySelectorAll("[id], a[name]")) {
    if (el.id === id || el.getAttribute("name") === id) return el;
  }
  const want = headingSlug(id);
  for (const h of root.querySelectorAll("h1, h2, h3, h4, h5, h6")) {
    if (headingSlug(h.textContent ?? "") === want) return h;
  }
  return null;
}

export interface DocLinksDeps {
  getDocPath: () => string | undefined;
  openUrl: (url: string) => Promise<void>;
  openPath: (path: string) => Promise<void>;
  revealPath: (path: string) => Promise<void>;
  /** What a local path really is, symlinks resolved (the sidecar's `inspectPath`). */
  inspectPath: (path: string) => Promise<PathInfo>;
  openInTab: (path: string) => Promise<void>;
  /** A short on-screen message. */
  notify: (message: string) => void;
  log: (line: string) => void;
}

const baseName = (path: string): string => path.slice(path.lastIndexOf("/") + 1) || path;

export function initDocLinks(deps: DocLinksDeps) {
  /** Show `path` in Finder, saying why it was not opened. */
  async function reveal(path: string, why: string): Promise<void> {
    try {
      await deps.revealPath(path);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      deps.log(`reveal link failed: ${path}: ${msg}`);
      return deps.notify(`Could not show ${baseName(path)} in Finder: ${msg}`);
    }
    deps.notify(why);
  }

  /**
   * A local file or folder: open it only if both the name in the link and the file really
   * there (after symlinks) are a document or media file; otherwise show it in Finder.
   */
  async function openLocal(path: string): Promise<void> {
    const name = baseName(path);
    let info: PathInfo;
    try {
      info = await deps.inspectPath(path);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      deps.log(`inspect link failed: ${path}: ${msg}`);
      return reveal(path, `docuzen could not check what ${name} is, so it was shown in Finder instead of opened.`);
    }
    if (info.kind === "missing" || !info.realPath) return deps.notify(`Could not open ${name}: there is no such file.`);
    const real = info.realPath;
    if (info.kind === "file" && isOpenable(path) && isOpenable(real)) return deps.openPath(real);
    if (info.kind === "directory" && !BUNDLE_RE.test(real) && !insideBundle(real)) {
      return reveal(real, `${name} is a folder, so it was shown in Finder.`);
    }
    const points = baseName(real) !== name ? ` points to ${baseName(real)}, which` : "";
    return reveal(real, `${name}${points} is not a document or media file, so it was shown in Finder instead of opened.`);
  }

  /** Carry out an already-classified target. `root` is where a `#fragment` is looked up. */
  async function openTarget(target: LinkTarget, root: ParentNode): Promise<void> {
    try {
      switch (target.kind) {
        case "hash": {
          const el = findFragment(root, target.id);
          if (el) el.scrollIntoView({ block: "start" });
          else deps.notify(`Nothing in this document is named "#${target.id}".`);
          return;
        }
        case "url":
          return await deps.openUrl(target.url);
        case "doc":
          return await deps.openInTab(target.path);
        case "file":
        case "reveal":
          return await openLocal(target.path);
        case "refused":
          deps.notify(target.reason);
          return;
      }
    } catch (err) {
      const what = "path" in target ? baseName(target.path) : "url" in target ? target.url : "the link";
      const why = err instanceof Error ? err.message : String(err);
      deps.log(`open link failed: ${what}: ${why}`);
      deps.notify(`Could not open ${what}: ${why}`);
    }
  }

  return {
    openTarget,
    /** Open a link as written in the active document. */
    open: (href: string, root: ParentNode): Promise<void> => openTarget(linkTarget(deps.getDocPath(), href), root),
  };
}

export type DocLinks = ReturnType<typeof initDocLinks>;
