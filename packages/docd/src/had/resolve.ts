// Where a document's `.had` review-state lives. Git repo -> a single hidden
// `<repo-root>/.docuzen/<relpath>.had` (no per-file sidecars, no doc mutation);
// outside a repo -> `<doc-dir>/.docuzen/<basename>.had`. Pure: no side effects.
// Relative paths are taken against the working directory first: walking up a relative
// path stops at "." and would never see a repo root above it.
import { existsSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";

/** Nearest ancestor containing a `.git` entry (dir or worktree file), or null. */
export function findRepoRoot(startDir: string): string | null {
  let dir = resolve(startDir);
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null; // reached the filesystem root
    dir = parent;
  }
}

export function resolveHadDir(path: string): string {
  const docPath = resolve(path);
  const docDir = dirname(docPath);
  const repoRoot = findRepoRoot(docDir);
  if (repoRoot) {
    const rel = relative(repoRoot, docPath); // e.g. "docs/plan.md"
    return join(repoRoot, ".docuzen", `${rel}.had`);
  }
  return join(docDir, ".docuzen", `${basename(docPath)}.had`);
}
