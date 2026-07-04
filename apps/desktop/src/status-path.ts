/**
 * Status bar: active document path display and reveal-in-Finder.
 *
 * - middleTruncate: pure helper (exported, unit-tested) — keeps head + tail,
 *   "…" in the middle; returns as-is when path.length <= max.
 * - initDocPath: wires the #docPath button — updates label/title from
 *   activateTab, clears on empty state, calls revealItemInDir on click.
 */
import { revealItemInDir } from "@tauri-apps/plugin-opener";

/**
 * Middle-truncate `path` so the result is at most `max` characters long.
 * Keeps the head (leading characters) and the full basename (tail), with
 * "…" in between. Returns `path` unchanged when `path.length <= max`.
 */
export function middleTruncate(path: string, max: number): string {
  if (path.length <= max) return path;

  // Extract the basename as the immutable tail we must preserve.
  const sepIdx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const tail = sepIdx >= 0 ? path.slice(sepIdx + 1) : path;

  // "…" is 1 character (U+2026), plus a "/" separator before the tail.
  const ellipsis = "…";
  const separator = "/";
  const reserved = ellipsis.length + separator.length + tail.length;

  if (reserved >= max) {
    // Degenerate: tail alone already >= max — just truncate from the right with ellipsis.
    return path.slice(0, max - ellipsis.length) + ellipsis;
  }

  const headLen = max - reserved;
  const head = path.slice(0, headLen);
  return `${head}${ellipsis}${separator}${tail}`;
}

// ---------------------------------------------------------------------------
// DOM wiring — called once by main.ts after the DOM is ready.
// ---------------------------------------------------------------------------

interface DocPathDeps {
  log: (line: string) => void;
}

/** Initialise the #docPath status-bar button.  Returns the two updater fns. */
export function initDocPath(deps: DocPathDeps): {
  setDocPath: (path: string) => void;
  clearDocPath: () => void;
} {
  const btn = document.getElementById("docPath") as HTMLButtonElement | null;
  if (!btn) {
    deps.log("initDocPath: #docPath element not found");
    return { setDocPath: () => {}, clearDocPath: () => {} };
  }

  let currentPath = "";

  btn.addEventListener("click", () => {
    if (!currentPath) return;
    revealItemInDir(currentPath).catch((e: unknown) => {
      deps.log(`reveal in Finder failed: ${String(e)}`);
    });
  });

  function setDocPath(path: string): void {
    currentPath = path;
    btn!.textContent = middleTruncate(path, 60);
    btn!.title = path;
    btn!.disabled = false;
    btn!.hidden = false;
  }

  function clearDocPath(): void {
    currentPath = "";
    btn!.textContent = "";
    btn!.title = "";
    btn!.disabled = true;
    btn!.hidden = true;
  }

  // Start hidden until a doc is activated.
  clearDocPath();

  return { setDocPath, clearDocPath };
}
