// What counts as a block in an HTML document. Shared by the text projection (a boundary
// between blocks is one "\n") and long comments (a margin bar goes on each covered block),
// so both agree on where one block ends and the next begins.

export const HTML_NS = "http://www.w3.org/1999/xhtml";

/** Block-level tags (upper case: an HTML element's tagName in an HTML document). */
export const BLOCK_TAGS = new Set([
  "P", "DIV", "SECTION", "ARTICLE", "HEADER", "FOOTER", "MAIN", "NAV", "ASIDE",
  "H1", "H2", "H3", "H4", "H5", "H6", "UL", "OL", "LI", "TABLE", "THEAD", "TBODY",
  "TR", "TD", "TH", "PRE", "BLOCKQUOTE", "FIGURE", "FIGCAPTION", "HR", "BR", "DL",
  "DT", "DD",
]);

/** An HTML block element. SVG and MathML elements never are (their tagName is lower case). */
export function isBlockElement(el: Element): boolean {
  return el.namespaceURI === HTML_NS && BLOCK_TAGS.has(el.tagName);
}
