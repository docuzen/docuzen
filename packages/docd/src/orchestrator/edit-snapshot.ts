import { readFile } from "node:fs/promises";
import { snapshot } from "../had/index.js";

export interface EditSnapshotDeps {
  /** Injected clock so tests are deterministic. */
  now: () => string;
}

export interface WithEditSnapshotOptions {
  /**
   * The pre-mutation content, if the caller already has it in memory (approveProposal
   * and applyLegacySpan both read the doc earlier for other checks). When omitted,
   * `withEditSnapshot` reads it from disk itself.
   */
  before?: string;
  /**
   * The post-mutation content, if the caller already knows it in memory (applyLegacySpan
   * computes the exact bytes it's about to write; detectDirectEdit already reads the
   * current disk content once to decide `skipIfUnchanged`, and reuses that same read
   * here). When provided, this is snapshotted directly — and used for the
   * `skipIfUnchanged` comparison too — instead of `withEditSnapshot` re-reading disk
   * after `mutate` runs. approveProposal's hunk/full-rewrite path omits this: its
   * written bytes go through `matter.stringify`, so it doesn't hold the exact on-disk
   * string and genuinely needs the re-read.
   */
  after?: string;
  /**
   * Skip the whole pair — and report no change — when the document content is the same
   * before and after. Only detectDirectEdit needs this: its "mutation" already happened
   * (the agent wrote the file directly) before this ever runs, so there's no atomicity
   * to protect and nothing worth snapshotting or reporting when nothing actually changed.
   * Sites that perform the write themselves (approveProposal, applyLegacySpan) always
   * snapshot both ends unconditionally, matching their prior behavior.
   */
  skipIfUnchanged?: boolean;
}

/**
 * Single owner of the "pre-apply-backup" → mutate → "agent-edit" snapshot pair that
 * every doc-mutating call site used to hand-write. The pre-apply-backup snapshot is
 * taken BEFORE `mutate` runs and always uses the caller-visible "before" content, so a
 * mutation that throws partway still leaves a recoverable backup version. Returns
 * whether the pair was actually taken (false only when `skipIfUnchanged` finds the
 * document unchanged).
 */
export async function withEditSnapshot(
  deps: EditSnapshotDeps,
  docPath: string,
  thread: string,
  mutate: () => Promise<void>,
  opts: WithEditSnapshotOptions = {},
): Promise<boolean> {
  const before = opts.before ?? (await readFile(docPath, "utf8"));
  if (opts.skipIfUnchanged) {
    const current = opts.after ?? (await readFile(docPath, "utf8"));
    if (current === before) return false;
  }
  await snapshot(docPath, before, { cause: "pre-apply-backup", thread, at: deps.now() });
  await mutate();
  const after = opts.after ?? (await readFile(docPath, "utf8"));
  await snapshot(docPath, after, { cause: "agent-edit", thread, at: deps.now() });
  return true;
}
