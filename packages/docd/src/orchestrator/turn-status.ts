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

function isMissingFile(e: unknown): boolean {
  return (e as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

/**
 * Single writer for a turn's status: the TaskDB liveness row, and — only when the
 * call site asks for it — the thread's on-disk frontmatter `status` field.
 *
 * Frontmatter is written BEFORE the TaskDB row (a crash in between leaves the row
 * "running", which reconcile repairs; the other order would leave the thread file
 * saying "running" with nothing left to fix it). The TaskDB row is written even when
 * the frontmatter write fails: a thread file deleted mid-turn (its comment was
 * removed) must not leave the task "running" forever. That missing-file case is
 * expected for an "error" transition and is swallowed; any other frontmatter failure
 * is rethrown once the row is written.
 */
export async function transition(
  deps: TransitionDeps,
  threadId: string,
  status: TurnStatus,
  detail: TransitionDetail,
): Promise<void> {
  let frontmatterError: unknown;
  if (detail.frontmatter) {
    try {
      await updateThreadFrontmatter(deps.docPath, threadId, { status });
    } catch (e) {
      frontmatterError = e ?? new Error("thread frontmatter update failed");
    }
  }
  deps.db.upsert({
    threadId,
    status,
    piSessionId: detail.piSessionId,
    errorText: detail.error ?? null,
  });
  if (frontmatterError !== undefined && !(status === "error" && isMissingFile(frontmatterError))) {
    throw frontmatterError;
  }
}
