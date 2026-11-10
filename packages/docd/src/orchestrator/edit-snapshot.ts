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
   * computes the exact bytes it's about to write). When provided, this is snapshotted
   * directly instead of `withEditSnapshot` re-reading disk after `mutate` runs.
   * approveProposal's hunk/full-rewrite path omits this: its written bytes go through
   * `matter.stringify`, so it doesn't hold the exact on-disk string and genuinely needs
   * the re-read.
   */
  after?: string;
}

/**
 * Single owner of the "pre-apply-backup" → mutate → "agent-edit" snapshot pair that
 * every doc-mutating call site used to hand-write. The pre-apply-backup snapshot is
 * taken BEFORE `mutate` runs and always uses the caller-visible "before" content, so a
 * mutation that throws partway still leaves a recoverable backup version.
 */
export async function withEditSnapshot(
  deps: EditSnapshotDeps,
  docPath: string,
  thread: string,
  mutate: () => Promise<void>,
  opts: WithEditSnapshotOptions = {},
): Promise<void> {
  const before = opts.before ?? (await readFile(docPath, "utf8"));
  await snapshot(docPath, before, { cause: "pre-apply-backup", thread, at: deps.now() });
  await mutate();
  const after = opts.after ?? (await readFile(docPath, "utf8"));
  await snapshot(docPath, after, { cause: "agent-edit", thread, at: deps.now() });
}
