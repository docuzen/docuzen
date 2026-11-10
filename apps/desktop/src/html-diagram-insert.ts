// Inserting a diagram into an HTML document. A markdown tab takes a ```mermaid fence, which
// the editor renders; an HTML file has no such renderer, so it gets the rendered SVG itself,
// in a <figure> placed after the block that contains the selection. The mermaid source is
// kept on the figure so the diagram can be regenerated or edited later.
import { resolveAnchor } from "@ai-native-doc/docd/anchor";
import type { TextQuoteAnchor } from "@ai-native-doc/docd/anchor";
import { buildHtmlProjection, rangeForOffsets } from "./html-projection.js";

/** Elements a figure can sit next to as a sibling. */
const BLOCKS = new Set([
  "P", "H1", "H2", "H3", "H4", "H5", "H6", "UL", "OL", "DL", "TABLE", "PRE", "BLOCKQUOTE",
  "FIGURE", "DETAILS", "DIV", "SECTION", "ARTICLE", "HEADER", "FOOTER", "MAIN", "ASIDE", "HR",
]);
/** Blocks that are part of a larger structure a figure must not be dropped into. */
const INSIDE = "ul, ol, dl, table, pre, blockquote, figure, details > summary, p, h1, h2, h3, h4, h5, h6";

/**
 * The block after which a figure for a selection ending at `node` should go: the outermost
 * list/table/quote/heading/paragraph around it (so a selection in a table cell puts the
 * diagram after the table, not inside the cell), else its nearest block container.
 */
export function insertionBlockFor(node: Node, body: HTMLElement): Element | null {
  let el: Element | null = node.nodeType === 1 ? (node as Element) : node.parentElement;
  if (!el || !body.contains(el) || el === body) return null;
  let outer: Element | null = null;
  for (let cur: Element | null = el.closest(INSIDE); cur && cur !== body && body.contains(cur); cur = cur.parentElement?.closest(INSIDE) ?? null) {
    outer = cur;
  }
  if (outer) return outer;
  while (el && el !== body && !BLOCKS.has(el.tagName)) el = el.parentElement;
  return el && el !== body ? el : null;
}

/**
 * Insert `svg` as a figure after the block containing `anchor` (or at the end of the body
 * when the anchor no longer resolves). Returns the inserted figure.
 */
export function insertDiagramIntoHtmlDoc(doc: Document, anchor: TextQuoteAnchor, svg: string, mermaidSource: string): HTMLElement {
  const figure = doc.createElement("figure");
  figure.className = "docuzen-diagram";
  figure.setAttribute("data-mermaid-source", mermaidSource);
  figure.setAttribute("contenteditable", "false"); // one unit while editing; stripped on save
  figure.setAttribute("style", "margin:1.5em 0;text-align:center;overflow-x:auto");
  figure.innerHTML = svg;

  const proj = buildHtmlProjection(doc.body);
  const r = resolveAnchor(proj.text, anchor);
  let block: Element | null = null;
  if (r) {
    // A selection often ends in the whitespace between blocks (a triple-click runs to the
    // start of the next one), where the end point belongs to no block. Use the last
    // character that is actual text.
    let end = r.end;
    while (end > r.start + 1 && /\s/.test(proj.text[end - 1])) end--;
    const last = rangeForOffsets(doc, proj, end - 1, end);
    if (last) block = insertionBlockFor(last.startContainer, doc.body);
  }
  if (block) block.after(figure);
  else doc.body.appendChild(figure);
  return figure;
}
