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
    .map((line) =>
      line
        .replace(/^\s{0,3}#{1,6}\s+/, "")
        .replace(/^\s{0,3}>\s?/, "")
        .replace(/^\s{0,3}[-*+]\s+/, "")
        .replace(/^\s{0,3}\d+[.)]\s+/, ""),
    )
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
