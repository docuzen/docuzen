// Where a document's `.had` review-state lives. Git repo -> a single hidden
// `<repo-root>/.docuzen/<relpath>.had` (no per-file sidecars, no doc mutation);
// outside a repo -> `<doc-dir>/.docuzen/<basename>.had`. Pure: no side effects.
import { existsSync } from "node:fs";
import { basename, dirname, join, relative, parse } from "node:path";

/** Nearest ancestor containing a `.git` entry (dir or worktree file), or null. */
export function findRepoRoot(startDir: string): string | null {
  let dir = startDir;
  const { root } = parse(dir);
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    if (dir === root) return null;
    dir = dirname(dir);
  }
}

export function resolveHadDir(docPath: string): string {
  const docDir = dirname(docPath);
  const repoRoot = findRepoRoot(docDir);
  if (repoRoot) {
    const rel = relative(repoRoot, docPath); // e.g. "docs/plan.md"
    return join(repoRoot, ".docuzen", `${rel}.had`);
  }
  return join(docDir, ".docuzen", `${basename(docPath)}.had`);
}
