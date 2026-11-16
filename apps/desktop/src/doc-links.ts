// Opening a link written in a document.
//
// Rules (one place, both surfaces):
//   - Where the text is editable (markdown always; HTML with Edit on) a plain click places
//     the caret, and ⌘-click (Ctrl-click) opens the link. Where it is read-only (HTML review
//     mode) a plain click opens it.
//   - `#fragment` scrolls inside the document.
//   - http(s), mailto and tel go to the OS (browser, mail app).
//   - A local path (relative to the document's folder, absolute, or file:) that is a markdown
//     document opens in a docuzen tab; any other file opens in its default app.
//   - A link to a program or script is shown in Finder, never launched: a document must not
//     be able to run something with one click.
//   - Any other scheme (javascript:, data:, app-specific) is refused.
//   - Nothing here changes the document.
import { localImagePath } from "./doc-images.js";

export type LinkTarget =
  | { kind: "hash"; id: string }
  | { kind: "url"; url: string }
  /** A markdown document: opens in a docuzen tab. */
  | { kind: "doc"; path: string }
  /** Any other local file: opens in its default app. */
  | { kind: "file"; path: string }
  /** A program or script: revealed in Finder instead of opened. */
  | { kind: "reveal"; path: string }
  | { kind: "refused"; reason: string };

const WEB_RE = /^(https?|mailto|tel):/i;
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;
const MARKDOWN_RE = /\.(md|markdown)$/i;
/** File kinds the OS would run rather than show. */
const RUNNABLE_RE =
  /\.(app|command|tool|terminal|sh|bash|zsh|fish|csh|ksh|py|pyc|rb|pl|php|js|mjs|cjs|jar|scpt|scptd|applescript|workflow|action|shortcut|pkg|mpkg|dmg|exe|msi|bat|cmd|ps1|vbs|com|scr|lnk|desktop|appimage|run|bin|out|webloc|inetloc|url|fileloc|terminal|prefpane|osax|kext|plugin|bundle|dylib|so)$/i;

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
  if (SCHEME_RE.test(raw) && !/^file:/i.test(raw) && !/^[a-z]:[\\/]/i.test(raw)) {
    return { kind: "refused", reason: `docuzen does not open "${raw.slice(0, raw.indexOf(":") + 1)}" links.` };
  }
  if (!docPath) return { kind: "refused", reason: "Save the document before following a relative link." };
  const path = localImagePath(docPath, raw);
  if (!path) return { kind: "refused", reason: "This link has no address." };
  return localTarget(path);
}

/** Classify an absolute local path (see the rules at the top of this file). */
export function localTarget(path: string): LinkTarget {
  const clean = path.replace(/\/+$/, "") || "/";
  if (MARKDOWN_RE.test(clean)) return { kind: "doc", path: clean };
  if (RUNNABLE_RE.test(clean)) return { kind: "reveal", path: clean };
  return { kind: "file", path: clean };
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
  openInTab: (path: string) => Promise<void>;
  /** A short on-screen message. */
  notify: (message: string) => void;
  log: (line: string) => void;
}

const baseName = (path: string): string => path.slice(path.lastIndexOf("/") + 1) || path;

export function initDocLinks(deps: DocLinksDeps) {
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
          return await deps.openPath(target.path);
        case "reveal":
          await deps.revealPath(target.path);
          deps.notify(`${baseName(target.path)} is a program or script, so it was shown in Finder instead of opened.`);
          return;
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
