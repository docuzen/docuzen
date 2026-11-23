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
  /** [start, end) offsets of text that is code (code blocks, inline code), in order. */
  code?: { start: number; end: number }[];
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
  nodes: { text: string; pos: number; span?: number; code?: boolean }[],
): Projection {
  let text = "";
  const posOfOffset: number[] = [];
  const code: { start: number; end: number }[] = [];
  let lastEnd = -1;
  for (const node of nodes) {
    if (lastEnd !== -1 && node.pos > lastEnd) {
      posOfOffset.push(lastEnd); // separator anchors to the block boundary
      text += "\n";
    }
    const isAtom = node.span !== undefined;
    for (let i = 0; i < node.text.length; i++) {
      posOfOffset.push(isAtom ? node.pos : node.pos + i);
    }
    if (node.code && node.text) {
      const last = code[code.length - 1];
      if (last && last.end === text.length) last.end += node.text.length;
      else code.push({ start: text.length, end: text.length + node.text.length });
    }
    text += node.text;
    lastEnd = node.pos + (node.span ?? node.text.length);
  }
  return code.length ? { text, posOfOffset, code } : { text, posOfOffset };
}

const isCode = (spec: { code?: boolean }): boolean => spec.code === true;

export function buildProjection(doc: ProseNode): Projection {
  const nodes: { text: string; pos: number; span?: number; code?: boolean }[] = [];
  doc.descendants((node: ProseNode, pos: number, parent: ProseNode | null) => {
    if (node.isText && node.text) {
      const code = (parent ? isCode(parent.type.spec) : false) || node.marks.some((m) => isCode(m.type.spec));
      nodes.push({ text: node.text, pos, ...(code ? { code } : {}) });
    } else if (node.type.name === "math_inline") {
      const val = String(node.attrs.value ?? "");
      const delim = node.attrs.doubleDollar ? "$$" : "$";
      if (val) nodes.push({ text: `${delim}${val}${delim}`, pos, span: node.nodeSize });
    } else if (node.type.name === "math_block") {
      const val = String(node.attrs.value ?? "");
      if (val) nodes.push({ text: val, pos, span: node.nodeSize });
    }
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
  const last = endOff - 1;
  // End of the last selected char — unless that char is the "\n" standing for a block
  // boundary (the next char sits more than one position further on): the range then ends
  // where the block's text does, not past its closing token. A hard break's "\n" is a
  // real one-position node and stays included.
  const blockSep = proj.text[last] === "\n" && endOff < arr.length && arr[endOff] - arr[last] > 1;
  const to = blockSep ? arr[last] : arr[last] + 1;
  return from < to ? { from, to } : null;
}
