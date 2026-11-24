// Opening documents dropped onto the window. The app turns off Tauri's native drop
// handler (src-tauri/src/lib.rs: it would take every drag away from the page), so a drop
// event carries each file's name and bytes but not its path. The Rust shell reads the
// paths of the last drag from macOS's drag pasteboard (src-tauri/src/drag_paths.rs); only
// the paths whose names match the files actually dropped are opened, so a pasteboard left
// over from an earlier drag can never open something the user did not drop now.

/** Files docuzen opens as documents (the same set the OS "Open With" route accepts). */
export const DOCUMENT_EXT_RE = /\.(md|markdown|html|htm|hadz)$/i;

export function isDocumentName(name: string): boolean {
  return DOCUMENT_EXT_RE.test(name);
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/**
 * The pasteboard paths that belong to the dropped files, in pasteboard order and each
 * once, plus the dropped names no path was found for. Names are compared after Unicode
 * normalisation: macOS paths can spell "é" as two code points where the File name has one.
 */
export function matchDroppedPaths(names: string[], paths: string[]): { matched: string[]; missing: string[] } {
  const norm = (s: string): string => s.normalize("NFC");
  const wanted = new Set(names.map(norm));
  const found = new Set<string>();
  const matched: string[] = [];
  for (const p of paths) {
    const name = norm(basename(p));
    if (!wanted.has(name) || matched.includes(p)) continue;
    matched.push(p);
    found.add(name);
  }
  return { matched, missing: names.filter((n) => !found.has(norm(n))) };
}

export interface DocDropIo {
  /** Paths of the last drag, or null outside the app (a plain browser has no pasteboard). */
  droppedPaths(): Promise<string[] | null>;
  /** Open one document (imports a .hadz first), the way File → Open does. */
  open(path: string): Promise<void>;
  notify(message: string): void;
  log(line: string): void;
}

/** Open the dropped document files; say so when one cannot be found on disk. */
export async function openDroppedDocuments(names: string[], io: DocDropIo): Promise<void> {
  let paths: string[] | null;
  try {
    paths = await io.droppedPaths();
  } catch (e) {
    io.log(`dropped_file_paths failed: ${String(e)}`);
    paths = [];
  }
  if (paths === null) {
    io.notify("Dropped documents open only in the docuzen app. Use File → Open here.");
    return;
  }
  const { matched, missing } = matchDroppedPaths(names, paths);
  if (missing.length) {
    io.log(`dropped document not found on the drag pasteboard: ${missing.join(", ")}`);
    io.notify(`Couldn't tell where ${missing.join(", ")} is on disk. Open it with File → Open.`);
  }
  for (const path of matched) await io.open(path);
}

/** The Tauri command behind DocDropIo.droppedPaths; null when not running inside the app. */
export async function tauriDroppedPaths(): Promise<string[] | null> {
  const tauri = (window as { __TAURI__?: { core?: { invoke?: (cmd: string) => Promise<unknown> } } }).__TAURI__;
  if (!tauri?.core?.invoke) return null;
  return ((await tauri.core.invoke("dropped_file_paths")) as string[]) ?? [];
}
