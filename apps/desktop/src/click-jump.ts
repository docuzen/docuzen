// Pure position -> target mapping for the meta/ctrl+click "jump to conversation"
// feature. Kept in its own
// module (not inline in editor.ts) because editor.ts pulls in Milkdown/ProseMirror
// plus CSS at module scope and so can't be imported directly in vitest (see
// annotation-decoration.test.ts's header, which resorts to reading editor.ts as raw
// text for exactly this reason) — this file has none of that, so its logic is
// directly unit-testable like anchor-map.ts's.
//
// editor.ts's click-jump ProseMirror plugin converts its live decoration state into
// these plain range arrays (once per click, not cached) and calls the two functions
// below to resolve what was clicked; chat.ts owns what happens next (promoteToChat
// vs. a read-only thread view vs. a "never resolved" hint).

export interface PosRange {
  from: number;
  to: number;
}

export interface AnnotationRange extends PosRange {
  id: string;
}

/**
 * The id of the annotation range (from `ranges`) that contains `pos`, inclusive of
 * both endpoints — matching ProseMirror's own `DecorationSet.find(pos, pos)`
 * semantics ("including decorations that start or end directly at the boundaries").
 * Comments, review findings, and highlights are all represented identically here;
 * which one has a thread (and which thread) is chat.ts's call, not this function's.
 */
export function annotationIdAtPos(ranges: AnnotationRange[], pos: number): string | undefined {
  return ranges.find((r) => pos >= r.from && pos <= r.to)?.id;
}

/**
 * The 1-based, document-order ordinal of the `[[ … ]]` directive range (from
 * `ranges`) that contains `pos`, or undefined when `pos` isn't inside any of them.
 * `ranges` must already be in document order (as `findDirectiveOffsets` +
 * `posRangeForOffsets` produce them) — this only locates, it never sorts. The
 * ordinal is what chat.ts's `directive-<n>` thread ids are keyed on.
 */
export function directiveOrdinalAtPos(ranges: PosRange[], pos: number): number | undefined {
  const idx = ranges.findIndex((r) => pos >= r.from && pos <= r.to);
  return idx === -1 ? undefined : idx + 1;
}
