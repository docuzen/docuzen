import { updateThreadFrontmatter } from "../had/index.js";
import type { TaskDB } from "../state/task-db.js";

/** The subset of TaskStatus that a turn's lifecycle actually transitions through. */
export type TurnStatus = "running" | "responded" | "error";

export interface TransitionDeps {
  db: TaskDB;
  docPath: string;
}

export interface TransitionDetail {
  /** The task's live session id after this transition (null when there isn't one yet). */
  piSessionId: string | null;
  /**
   * Also patch the thread's on-disk frontmatter `status` field to match. Every inline
   * site this replaces that touched frontmatter did so with ONLY `{ status }` — never an
   * error message or session id — so that's all `transition` writes there too.
   *
   * Omit (or pass `false`) for sites that never called `updateThreadFrontmatter`: brand
   * new threads get their frontmatter `status` from the surrounding `initThread` call
   * instead, and some threads (e.g. an existing thread mid-`reply`, or the ephemeral
   * "review" task) intentionally never mirror "running"/"responded" into frontmatter.
   */
  frontmatter?: boolean;
  /**
   * The failure that produced an "error" status — persisted to the TaskDB row's
   * `errorText` column so the UI can show why a task failed. Every non-"error"
   * transition omits this, which clears any stale errorText left from an earlier
   * failed attempt (a later successful retry shouldn't keep showing the old error).
   */
  error?: string;
}

/**
 * Single writer for a turn's status: the TaskDB liveness row, and — only when the
 * call site asks for it — the thread's on-disk frontmatter `status` field.
 *
 * Every paired call site this replaces wrote frontmatter BEFORE the TaskDB row, so
 * that order is preserved here unconditionally rather than left to the caller.
 */
export async function transition(
  deps: TransitionDeps,
  threadId: string,
  status: TurnStatus,
  detail: TransitionDetail,
): Promise<void> {
  if (detail.frontmatter) {
    await updateThreadFrontmatter(deps.docPath, threadId, { status });
  }
  deps.db.upsert({
    threadId,
    status,
    piSessionId: detail.piSessionId,
    errorText: detail.error ?? null,
  });
}
