import { buildHtmlProjection } from "./html-projection.js";

/** Normalize line endings without changing intentional content. */
function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

/**
 * Convert a small Markdown-ish hunk into the plain-text projection Milkdown uses
 * for decorations. Agent proposals are anchored to markdown source, but the live
 * editor decorations are placed over rendered text, so headings/lists/blockquotes
 * need a display-form candidate.
 */
export function markdownHunkToProjectionText(markdown: string): string {
  return normalizeLineEndings(markdown)
    .split("\n")
    .filter((line) => !/^\s*\${2,}\s*$/.test(line))
    .map((line) => {
      const singleLineMath = /^\s*\$\$(.+)\$\$\s*$/.exec(line);
      if (singleLineMath) return singleLineMath[1].trim();
      return line
        .replace(/^\s{0,3}#{1,6}\s+/, "")
        .replace(/^\s{0,3}>\s?/, "")
        .replace(/^\s{0,3}[-*+]\s+/, "")
        .replace(/^\s{0,3}\d+[.)]\s+/, "");
    })
    .join("\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

/** Undo markdown escaping for punctuation that appears literally in the rendered editor. */
export function markdownEscapesToProjectionText(markdown: string): string {
  return markdownHunkToProjectionText(markdown).replace(/\\([\\[\]{}()#+.!_`>*~-])/g, "$1");
}

/** Candidate strings to try when locating a proposal hunk in the editor projection. */
export function projectionNeedlesForHunk(oldText: string): string[] {
  const exact = normalizeLineEndings(oldText);
  const rendered = markdownHunkToProjectionText(oldText);
  const unescaped = markdownEscapesToProjectionText(oldText);
  return [...new Set([exact, exact.trim(), rendered, unescaped].filter((s) => s.length > 0))];
}

/**
 * The text an HTML fragment renders as, in the HTML surface's projection form (tags
 * dropped, entities decoded, a block boundary as one "\n"). Parsed in an inert document,
 * so nothing in the fragment loads or runs.
 */
export function htmlFragmentProjectionText(html: string): string {
  const doc = document.implementation.createHTMLDocument("");
  doc.body.innerHTML = html;
  return buildHtmlProjection(doc.body).text;
}

/**
 * Candidates for locating an HTML proposal hunk in the iframe's projection. An HTML
 * hunk's `oldText` is a slice of the file's source — `<p>Some <b>bold</b> text</p>` —
 * while the projection holds the rendered text, so besides the plain-text candidates
 * this tries the fragment's own rendered text.
 */
export function projectionNeedlesForHtmlHunk(oldText: string): string[] {
  const rendered = /<[a-z!/]/i.test(oldText) ? htmlFragmentProjectionText(oldText) : "";
  return [...new Set([...projectionNeedlesForHunk(oldText), rendered, rendered.trim()].filter((s) => s.length > 0))];
}
