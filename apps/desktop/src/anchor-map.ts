import type { EditorView } from "@milkdown/kit/prose/view";
import type { Node as ProseNode } from "@milkdown/kit/prose/model";

// Bridges the editor's plain-text projection (what HAD anchors live over) and
// ProseMirror document positions (what decorations need). Build/resolve always
// use the SAME projection function, so anchors stay self-consistent.

export interface Projection {
  /** Concatenated text of every text node, in document order. */
  text: string;
  /** posOfOffset[i] = the ProseMirror position of projection char i. */
  posOfOffset: number[];
}

/**
 * Assemble a projection from text nodes in document order. Nodes within one
 * block are contiguous in ProseMirror positions (`pos === previous end`) and
 * concatenate directly; a position gap means a block boundary (or hard break)
 * came between them, so we insert a single "\n" separator. Without this,
 * cross-block selections glue text together ("## Rollout" + "We enable…" →
 * "RolloutWe enable…"), corrupting the anchor's `exact` and the agent's input.
 */
export function assembleProjection(
  nodes: { text: string; pos: number }[],
): Projection {
  let text = "";
  const posOfOffset: number[] = [];
  let lastEnd = -1;
  for (const node of nodes) {
    if (lastEnd !== -1 && node.pos > lastEnd) {
      posOfOffset.push(lastEnd); // separator anchors to the block boundary
      text += "\n";
    }
    for (let i = 0; i < node.text.length; i++) posOfOffset.push(node.pos + i);
    text += node.text;
    lastEnd = node.pos + node.text.length;
  }
  return { text, posOfOffset };
}

export function buildProjection(doc: ProseNode): Projection {
  const nodes: { text: string; pos: number }[] = [];
  doc.descendants((node: ProseNode, pos: number) => {
    if (node.isText && node.text) nodes.push({ text: node.text, pos });
    return true;
  });
  return assembleProjection(nodes);
}

export function projectionOf(view: EditorView): Projection {
  return buildProjection(view.state.doc);
}

/** First projection offset whose PM position is >= `pos` (binary search). */
export function offsetForPos(proj: Projection, pos: number): number {
  const arr = proj.posOfOffset;
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < pos) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Convert a [startOff, endOff) projection range to a ProseMirror [from, to). */
export function posRangeForOffsets(
  proj: Projection,
  startOff: number,
  endOff: number,
): { from: number; to: number } | null {
  const arr = proj.posOfOffset;
  if (arr.length === 0 || startOff >= endOff || startOff < 0 || endOff > arr.length) {
    return null;
  }
  const from = arr[startOff];
  const to = arr[endOff - 1] + 1; // end of the last selected char
  return { from, to };
}
