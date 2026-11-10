// A comment anchored to a long passage (several blocks, up to the whole document) is not
// tinted block by block: that paints the page. It is marked by a thin bar in the margin
// beside the blocks it covers. This module holds the rule, the bar's CSS (shared with the
// HTML iframe, which does not load styles.css) and the HTML-document side of marking blocks.

/** Blocks covered from which a comment gets the margin bar instead of a fill. */
export const LONG_RANGE_BLOCKS = 3;
/** ...or this many characters, however few blocks. */
export const LONG_RANGE_CHARS = 800;

export function isLongRange(chars: number, blocks: number): boolean {
  return blocks >= LONG_RANGE_BLOCKS || chars > LONG_RANGE_CHARS;
}

/** Attribute on each covered block: a space-separated list of the comment ids covering it. */
export const RANGE_ATTR = "data-had-range";
/** Set (to the comment id) on a covered block while that comment is the focused one. */
export const RANGE_FOCUS_ATTR = "data-had-range-focus";

// Two shadows: a page-coloured gap, then the bar — the bar sits clear of the text without
// changing layout (a border or padding would reflow the user's document).
export const LONG_RANGE_CSS = `
.had-mark.had-long, .had-mark.had-long.focus { outline: none; box-shadow: none; }
.had-mark.had-long.focus { background: rgba(120, 120, 140, 0.09) !important; }
[${RANGE_ATTR}] { box-shadow: -8px 0 0 0 var(--had-range-bg, #fff), -11px 0 0 0 var(--had-range-color, #f06292); }
[${RANGE_ATTR}][${RANGE_FOCUS_ATTR}] { box-shadow: -7px 0 0 0 var(--had-range-bg, #fff), -12px 0 0 0 var(--had-range-color, #f06292); }
`;

/** The first opaque background colour at or above `el` (what the bar's gap must match). */
export function opaqueBackground(el: Element | null): string {
  const view = el?.ownerDocument.defaultView;
  for (let n: Element | null = el; n && view; n = n.parentElement) {
    const bg = view.getComputedStyle(n).backgroundColor;
    if (bg && bg !== "transparent" && !/^rgba?\([^)]*[,/]\s*0(?:\.0+)?%?\s*\)$/.test(bg)) return bg;
  }
  return "#fff";
}

/** Child elements of `range`'s common ancestor that the range touches — its "blocks". */
export function blocksInRange(range: Range): Element[] {
  let c: Node | null = range.startContainer;
  while (c && !c.contains(range.endContainer)) c = c.parentNode;
  if (!c) return [];
  if (c.nodeType !== 1) return c.parentElement ? [c.parentElement] : [];
  return [...(c as Element).children].filter(
    (el) => !el.hasAttribute("data-had-overlay") && range.intersectsNode(el) && (el.textContent ?? "").trim() !== "",
  );
}

const styleSel = (id: string): string => `style[data-had-range-style="${CSS.escape(id)}"]`;

/** Mark `blocks` in an HTML document as covered by comment `id` (undone by clearRangeBlocks). */
export function markRangeBlocks(doc: Document, blocks: Element[], id: string, color: string): void {
  for (const b of blocks) {
    const ids = new Set((b.getAttribute(RANGE_ATTR) ?? "").split(/\s+/).filter(Boolean));
    ids.add(id);
    b.setAttribute(RANGE_ATTR, [...ids].join(" "));
  }
  // The colours ride in an overlay <style> (dropped on save), not on the document's own
  // elements: those get only the one data attribute.
  doc.querySelector(styleSel(id))?.remove();
  const style = doc.createElement("style");
  style.setAttribute("data-had-overlay", "");
  style.setAttribute("data-had-range-style", id);
  const bg = opaqueBackground(blocks[0] ?? doc.body);
  style.textContent = `[${RANGE_ATTR}~="${CSS.escape(id)}"] { --had-range-color: ${color}; --had-range-bg: ${bg}; }`;
  (doc.head ?? doc.documentElement).appendChild(style);
}

/** Remove comment `id`'s block marks (all comments' when `id` is omitted, e.g. before saving). */
export function clearRangeBlocks(root: ParentNode, id?: string): void {
  root.querySelectorAll(`[${RANGE_ATTR}]`).forEach((b) => {
    const rest = id ? (b.getAttribute(RANGE_ATTR) ?? "").split(/\s+/).filter((t) => t && t !== id) : [];
    if (rest.length) b.setAttribute(RANGE_ATTR, rest.join(" "));
    else b.removeAttribute(RANGE_ATTR);
    if (!id || b.getAttribute(RANGE_FOCUS_ATTR) === id) b.removeAttribute(RANGE_FOCUS_ATTR);
  });
  root.querySelectorAll(`[${RANGE_FOCUS_ATTR}]`).forEach((b) => {
    if (!id || b.getAttribute(RANGE_FOCUS_ATTR) === id) b.removeAttribute(RANGE_FOCUS_ATTR);
  });
  if (id) root.querySelector(styleSel(id))?.remove();
}

/** Show which comment is focused on the margin bars under `root`. */
export function focusRangeBlocks(root: ParentNode, id: string): void {
  root.querySelectorAll(`[${RANGE_ATTR}]`).forEach((b) => {
    const on = (b.getAttribute(RANGE_ATTR) ?? "").split(/\s+/).includes(id);
    if (on) b.setAttribute(RANGE_FOCUS_ATTR, id);
    else b.removeAttribute(RANGE_FOCUS_ATTR);
  });
}
