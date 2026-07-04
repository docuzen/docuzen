import { updateAnnotation } from "./annotations.js";
import { writeThread, updateThreadFrontmatter, appendTurn } from "./thread.js";

export interface SaveCommentInput {
  id: string;
  anchorExact?: string;
  body?: string;
}

/** Persist a comment's discussion as a fresh thread file (overwrites any existing one). */
export async function saveComment(
  docPath: string,
  input: SaveCommentInput,
  now: string,
): Promise<void> {
  const { id, anchorExact, body } = input;
  await writeThread(docPath, {
    frontmatter: {
      id,
      anchorExact: anchorExact ?? "",
      stance: "none",
      status: "open",
      piSession: `sessions/${id}.session.jsonl`,
    },
    turns: body ? [{ role: "you", timestamp: now, body }] : [],
  });
}

/** Flip a comment's resolved/open status on both the annotation and its thread. */
export async function resolveComment(
  docPath: string,
  id: string,
  resolved: boolean,
  now: string,
): Promise<void> {
  await updateAnnotation(docPath, id, { status: resolved ? "resolved" : "open" });
  try {
    await updateThreadFrontmatter(docPath, id, {
      status: resolved ? "resolved" : "open",
    });
    await appendTurn(docPath, id, {
      role: "system",
      timestamp: now,
      body: resolved ? "Marked resolved." : "Reopened.",
    });
  } catch {
    // thread file may not exist if the comment was never discussed
  }
}
