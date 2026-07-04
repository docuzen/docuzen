import { diffLines } from "diff";
import type { EditHunk } from "../agent/types.js";

/**
 * Diff `before`→`after` into change hunks. Maximal runs of consecutive
 * added/removed lines (separated by unchanged context) become one hunk:
 * oldText = removed run, newText = added run. Pure insertion → oldText "",
 * pure deletion → newText "". Unchanged context produces no hunk.
 */
export function diffToHunks(before: string, after: string): EditHunk[] {
  const parts = diffLines(before, after);
  const hunks: EditHunk[] = [];
  let cur: EditHunk | null = null;
  for (const p of parts) {
    if (!p.added && !p.removed) {            // unchanged context closes a hunk
      if (cur) { hunks.push(cur); cur = null; }
      continue;
    }
    cur ??= { oldText: "", newText: "" };
    if (p.removed) cur.oldText += p.value;
    if (p.added) cur.newText += p.value;
  }
  if (cur) hunks.push(cur);
  return hunks;
}
