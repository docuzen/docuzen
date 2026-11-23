// Shared KaTeX rendering helper used by both the Milkdown document surface
// (`doc-math.ts`) and agent chat replies (`markdown-reply.ts`). Kept free of
// Milkdown/DOM-mount imports so pure unit tests can import it directly.
import katex, { type KatexOptions } from "katex";

const escapeHtml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * Hardened KaTeX options: `trust: false` blocks `\href`/`\url`/`\htmlStyle`/etc.
 * (math can come from untrusted or agent-generated markdown), `maxSize`/`maxExpand`
 * bound layout and macro DoS, and `throwOnError: false` surfaces syntax mistakes
 * inline instead of crashing the editor.
 */
export function katexOptions(displayMode: boolean): KatexOptions {
  return {
    displayMode,
    throwOnError: false,
    strict: "ignore",
    trust: false,
    maxSize: 50,
    maxExpand: 1000,
    errorColor: "#b23a2c",
  };
}

/** Render a LaTeX expression to HTML (never throws; falls back to an escaped error box). */
export function renderLatexHtml(tex: string, displayMode: boolean): string {
  const source = tex.trim();
  if (!source) return "";
  try {
    return katex.renderToString(source, katexOptions(displayMode));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const tag = displayMode ? "div" : "span";
    return `<${tag} class="math-error" title="${escapeHtml(msg)}">${escapeHtml(source)}</${tag}>`;
  }
}

/** Render a LaTeX expression directly into `container`. */
export function renderLatexInto(container: HTMLElement, tex: string, displayMode: boolean): void {
  const source = tex.trim();
  if (!source) {
    container.innerHTML = "";
    const empty = container.ownerDocument.createElement("span");
    empty.className = "math-empty";
    empty.textContent = displayMode ? "Empty LaTeX block — double-click to edit" : "Empty math";
    container.appendChild(empty);
    return;
  }
  container.innerHTML = renderLatexHtml(source, displayMode);
}
