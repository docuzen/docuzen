// Text projection over an iframe HTML document — the HTML analogue of anchor-map.ts
// for the markdown/ProseMirror surface. HAD anchors live over a flat text projection;
// this builds that projection from the rendered DOM and maps projection offsets back
// to DOM Ranges (for decorating) and DOM selections forward to offsets (for creating
// anchors). Build and resolve use the SAME walk, so anchors stay self-consistent.

/** Tags whose text is structural/non-content and must not appear in the projection. */
const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"]);

/** Block-level tags: a boundary between them inserts a single "\n" separator. */
const BLOCK_TAGS = new Set([
  "P", "DIV", "SECTION", "ARTICLE", "HEADER", "FOOTER", "MAIN", "NAV", "ASIDE",
  "H1", "H2", "H3", "H4", "H5", "H6", "UL", "OL", "LI", "TABLE", "THEAD", "TBODY",
  "TR", "TD", "TH", "PRE", "BLOCKQUOTE", "FIGURE", "FIGCAPTION", "HR", "BR", "DL",
  "DT", "DD",
]);

/** One contiguous run of a single text node within the projection. */
export interface TextRun {
  node: Text;
  /** Inclusive start offset in the projection string. */
  from: number;
  /** Exclusive end offset in the projection string. */
  to: number;
}

export interface HtmlProjection {
  text: string;
  runs: TextRun[];
}

/**
 * Walk `root` in document order, concatenating visible text. Text nodes within one
 * block are contiguous; a block boundary inserts a single "\n" (mirrors the markdown
 * projection so cross-block selections don't glue words together). Script/style text
 * and overlay nodes are excluded.
 */
export function buildHtmlProjection(root: HTMLElement): HtmlProjection {
  const runs: TextRun[] = [];
  let text = "";
  let pendingSep = false;

  const visit = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      const value = node.nodeValue ?? "";
      if (!value) return;
      if (pendingSep && text.length) text += "\n";
      pendingSep = false;
      const from = text.length;
      text += value;
      runs.push({ node: node as Text, from, to: text.length });
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as Element;
    if (SKIP_TAGS.has(el.tagName)) return;
    if (el.hasAttribute("data-had-overlay")) return;
    const isBlock = BLOCK_TAGS.has(el.tagName);
    if (isBlock && text.length) pendingSep = true;
    for (const child of Array.from(el.childNodes)) visit(child);
    if (isBlock) pendingSep = true;
  };

  visit(root);
  return { text, runs };
}

/** Map a projection offset to a DOM point, snapping off separator gaps. */
function pointAt(
  proj: HtmlProjection,
  offset: number,
  edge: "start" | "end",
): { node: Text; offset: number } | null {
  for (const run of proj.runs) {
    if (edge === "start" && offset >= run.from && offset < run.to) {
      return { node: run.node, offset: offset - run.from };
    }
    if (edge === "end" && offset > run.from && offset <= run.to) {
      return { node: run.node, offset: offset - run.from };
    }
  }
  // On a separator (between runs): snap to the adjacent run boundary.
  if (edge === "start") {
    const next = proj.runs.find((r) => r.from >= offset);
    return next ? { node: next.node, offset: 0 } : null;
  }
  const prev = [...proj.runs].reverse().find((r) => r.to <= offset);
  return prev ? { node: prev.node, offset: prev.node.length } : null;
}

/** Convert a [startOff, endOff) projection range to a DOM Range, or null. */
export function rangeForOffsets(
  doc: Document,
  proj: HtmlProjection,
  startOff: number,
  endOff: number,
): Range | null {
  if (startOff >= endOff) return null;
  const s = pointAt(proj, startOff, "start");
  const e = pointAt(proj, endOff, "end");
  if (!s || !e) return null;
  const range = doc.createRange();
  try {
    range.setStart(s.node, s.offset);
    range.setEnd(e.node, e.offset);
  } catch {
    return null;
  }
  return range;
}

/** Convert a DOM selection Range to [startOff, endOff) in the projection, or null. */
export function offsetsForRange(
  proj: HtmlProjection,
  range: Range,
): { start: number; end: number } | null {
  // Selection endpoints in rich HTML frequently land on ELEMENT_NODE boundaries
  // (e.g. selecting across cards/grid rows), not direct text nodes. Derive offsets
  // from the text runs the DOM Range actually intersects; this handles both text-node
  // endpoints and element-boundary endpoints.
  const runs = proj.runs.filter((run) => {
    try {
      return range.intersectsNode(run.node);
    } catch {
      return false;
    }
  });
  const first = runs[0];
  const last = runs[runs.length - 1];
  if (!first || !last) return null;
  const start =
    first.node === range.startContainer
      ? first.from + Math.min(range.startOffset, first.node.length)
      : first.from;
  const end =
    last.node === range.endContainer
      ? last.from + Math.min(range.endOffset, last.node.length)
      : last.to;
  if (start >= end) return null;
  return { start, end };
}

/**
 * Wrap every text-node segment within `range` in a marker span (so highlights survive
 * cross-element ranges). Spans carry `data-had-mark` + `data-anno` and are stripped on
 * serialization. Returns the created spans.
 */
export function wrapRange(
  doc: Document,
  range: Range,
  makeSpan: () => HTMLElement,
): HTMLElement[] {
  const spans: HTMLElement[] = [];
  const container = range.commonAncestorContainer;

  if (container.nodeType === Node.TEXT_NODE) {
    const span = makeSpan();
    try {
      range.surroundContents(span);
      spans.push(span);
    } catch {
      /* unsplittable range — skip */
    }
    return spans;
  }

  const walker = doc.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const texts: Text[] = [];
  let n = walker.nextNode();
  while (n) {
    if (range.intersectsNode(n)) texts.push(n as Text);
    n = walker.nextNode();
  }
  for (const t of texts) {
    const start = t === range.startContainer ? range.startOffset : 0;
    const end = t === range.endContainer ? range.endOffset : t.length;
    if (start >= end) continue;
    const r = doc.createRange();
    try {
      r.setStart(t, start);
      r.setEnd(t, end);
      const span = makeSpan();
      r.surroundContents(span);
      spans.push(span);
    } catch {
      /* skip segments that can't be wrapped */
    }
  }
  return spans;
}

/** Remove highlight spans for `id`, restoring their text in place. */
export function unwrapAnno(doc: Document, id: string): void {
  doc.querySelectorAll(`[data-had-mark][data-anno="${CSS.escape(id)}"]`).forEach((span) => {
    const parent = span.parentNode;
    if (!parent) return;
    while (span.firstChild) parent.insertBefore(span.firstChild, span);
    parent.removeChild(span);
    parent.normalize();
  });
}
