// Pure index arithmetic for the tab strip — no DOM, no editor — so the rules that were
// wrong before (closing a tab moved the user to a different one) are unit-testable.

/**
 * Which tab should be active after the tab at `closedIdx` is removed from a strip that
 * had `countBefore` tabs with `activeIdx` active. Returns -1 when no tabs remain.
 *  - closing the active tab → its right neighbour takes its slot (or the new last tab);
 *  - closing a tab before the active one → the active tab stays, at its shifted index;
 *  - closing a tab after the active one → nothing moves.
 */
export function activeIndexAfterClose(activeIdx: number, closedIdx: number, countBefore: number): number {
  const remaining = countBefore - 1;
  if (remaining <= 0) return -1;
  if (closedIdx === activeIdx) return Math.min(closedIdx, remaining - 1);
  return activeIdx > closedIdx ? activeIdx - 1 : activeIdx;
}
