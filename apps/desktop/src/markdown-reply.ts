// Agent replies are markdown (bold, lists, code, LaTeX math); this renders one into a
// chat bubble. The reply is model output, so the HTML marked produces is sanitized before
// it touches the DOM, and links never navigate the app window: they open in the system
// browser.
import DOMPurify from "dompurify";
import { Marked, type TokenizerAndRendererExtension } from "marked";
import { openUrl } from "@tauri-apps/plugin-opener";
import { renderLatexHtml } from "./latex-render.js";

const ALLOWED_TAGS = [
  "a", "b", "blockquote", "br", "code", "del", "em", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "i",
  "li", "ol", "p", "pre", "s", "strong", "sub", "sup", "table", "tbody", "td", "th", "thead", "tr", "ul",
];
const EXTERNAL_LINK_RE = /^(?:https?:|mailto:)/i;

const escapeHtml = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function isWhitespace(ch: string): boolean {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r";
}

function isDigit(ch: string | undefined): boolean {
  return ch !== undefined && ch >= "0" && ch <= "9";
}

function isAlphaNum(ch: string | undefined): boolean {
  return ch !== undefined && /^[A-Za-z0-9]$/.test(ch);
}

/** Match an inline single-dollar `$...$` expression at index 0 of `src` using Pandoc currency-safe rules. */
function matchInlineSingleDollar(src: string): { raw: string; text: string } | null {
  if (!src.startsWith("$") || src.startsWith("$$") || src.length < 3) return null;
  if (isWhitespace(src[1])) return null;
  let bs = 0;
  for (let i = 1; i < src.length; i++) {
    const ch = src[i];
    if (ch === "`") return null; // never swallow across an inline code span (e.g. `$10, code \`$z$\``)
    if (ch === "\\") {
      bs++;
      continue;
    }
    if (ch === "\n" && src[i + 1] === "\n") return null;
    if (ch === "$" && bs % 2 === 0) {
      if (i === 1 || isWhitespace(src[i - 1])) return null;
      const next = src[i + 1];
      if (next === "$" || isDigit(next)) return null;
      if ((src[i - 1] === "(" || src[i - 1] === "[" || src[i - 1] === "{") && isAlphaNum(next)) {
        return null;
      }
      return { raw: src.slice(0, i + 1), text: src.slice(1, i) };
    }
    bs = 0;
  }
  return null;
}

/** Match an inline double-dollar `$$...$$` expression at index 0 of `src`. */
function matchInlineDoubleDollar(src: string): { raw: string; text: string } | null {
  if (!src.startsWith("$$") || src.startsWith("$$$") || src.length < 5) return null;
  let bs = 0;
  for (let i = 2; i < src.length - 1; i++) {
    const ch = src[i];
    if (ch === "\\") {
      bs++;
      continue;
    }
    if (ch === "\n" && src[i + 1] === "\n") return null;
    if (ch === "$" && src[i + 1] === "$" && bs % 2 === 0) {
      if (src[i + 2] === "$") return null;
      const inner = src.slice(2, i).trim();
      if (!inner) return null;
      return { raw: src.slice(0, i + 2), text: inner };
    }
    bs = 0;
  }
  return null;
}

/** Match `\(...\)` or `\[...\]` at index 0 of `src` (never matching `\[\[`). */
function matchBracketMath(src: string, open: "\\(" | "\\[", close: "\\)" | "\\]"): { raw: string; text: string } | null {
  if (!src.startsWith(open)) return null;
  if (open === "\\[" && src[2] === "[") return null;
  let bs = 0;
  for (let i = 2; i < src.length - 1; i++) {
    const ch = src[i];
    if (ch === "\n" && src[i + 1] === "\n") return null;
    if (ch === "\\" && src[i + 1] === close[1] && bs % 2 === 0) {
      const inner = src.slice(2, i).trim();
      if (!inner) return null;
      return { raw: src.slice(0, i + 2), text: inner };
    }
    bs = ch === "\\" ? bs + 1 : 0;
  }
  return null;
}

/** Match a block-level display math expression (`$$\n...\n$$`, `$$...$$`, or `\[...\]`) at index 0 of `src`. */
function matchBlockMath(src: string): { raw: string; text: string } | null {
  // 1. Multi-line fenced `$$\n...\n$$`
  const fenced = /^[ \t]{0,3}\$\$[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]{0,3}\$\$[ \t]*(?:\r?\n|$)/.exec(src);
  if (fenced) {
    return { raw: fenced[0], text: fenced[1].trim() };
  }
  // 2. Single-line or same-line-start `$$...$$` ending a line (no blank lines, no trailing text)
  const lead = /^[ \t]{0,3}\$\$/.exec(src);
  if (lead && !src.startsWith("$$$", lead[0].length - 2)) {
    const start = lead[0].length;
    let bs = 0;
    for (let i = start; i < src.length - 1; i++) {
      const ch = src[i];
      if (ch === "\\") {
        bs++;
        continue;
      }
      if (ch === "\n" && /^[ \t]*(?:\r?\n|$)/.test(src.slice(i + 1))) break;
      if (ch === "$" && src[i + 1] === "$" && bs % 2 === 0) {
        const tail = /^[ \t]*(?:\r?\n|$)/.exec(src.slice(i + 2));
        if (!tail) return null; // trailing prose on the same line -> let inline handle it
        const inner = src.slice(start, i).trim();
        if (!inner) return null;
        return { raw: src.slice(0, i + 2 + tail[0].length), text: inner };
      }
      bs = 0;
    }
  }
  // 3. Block `\[...\]` on its own lines
  const bracket = /^[ \t]{0,3}\\\[(?!\[)([\s\S]+?)\\\][ \t]*(?:\r?\n|$)/.exec(src);
  if (bracket && !/\r?\n[ \t]*\r?\n/.test(bracket[1])) {
    const inner = bracket[1].trim();
    if (inner) return { raw: bracket[0], text: inner };
  }
  return null;
}

interface MathSlot {
  block: boolean;
  html: string;
}

// Per-call slot table populated during `md.parse` and substituted AFTER DOMPurify
// runs, so DOMPurify's strict allowlist on model-generated markdown never widens.
let activeSlots: MathSlot[] | null = null;
let activeSentinel = "";

function pushMathSlot(tex: string, displayMode: boolean, block: boolean): string {
  const rendered = renderLatexHtml(tex, displayMode);
  const wrapped = block
    ? `<div class="math-reply-block">${rendered}</div>`
    : `<span class="math-reply-inline">${rendered}</span>`;
  const idx = activeSlots!.push({ block, html: wrapped }) - 1;
  const token = `@@${activeSentinel}:${idx}@@`;
  return block ? `\n<p>${token}</p>\n` : token;
}

const mathBlockExtension: TokenizerAndRendererExtension = {
  name: "mathBlock",
  level: "block",
  start(src) {
    const m = /(?:^|\n)[ \t]{0,3}(?:\$\$|\\\[(?!\[))/.exec(src);
    return m ? m.index + (m[0].startsWith("\n") ? 1 : 0) : undefined;
  },
  tokenizer(src) {
    const matched = matchBlockMath(src);
    if (!matched) return undefined;
    return { type: "mathBlock", raw: matched.raw, text: matched.text };
  },
  renderer(token) {
    return pushMathSlot(String(token.text ?? ""), true, true);
  },
};

const mathInlineExtension: TokenizerAndRendererExtension = {
  name: "mathInline",
  level: "inline",
  start(src) {
    const m = /\$|\\[(\[]/.exec(src);
    return m ? m.index : undefined;
  },
  tokenizer(src) {
    const dbl = matchInlineDoubleDollar(src);
    if (dbl) return { type: "mathInline", raw: dbl.raw, text: dbl.text, display: true };
    const sgl = matchInlineSingleDollar(src);
    if (sgl) return { type: "mathInline", raw: sgl.raw, text: sgl.text, display: false };
    const paren = matchBracketMath(src, "\\(", "\\)");
    if (paren) return { type: "mathInline", raw: paren.raw, text: paren.text, display: false };
    const sq = matchBracketMath(src, "\\[", "\\]");
    if (sq) return { type: "mathInline", raw: sq.raw, text: sq.text, display: true };
    return undefined;
  },
  renderer(token) {
    return pushMathSlot(String(token.text ?? ""), Boolean(token.display), false);
  },
};

// Raw HTML in a reply is shown as written, never interpreted: replies often quote markup.
const md = new Marked({
  gfm: true,
  breaks: true,
  renderer: {
    html: (token) => escapeHtml(token.text),
    code(token) {
      if (token.lang?.trim().toLowerCase() === "math") {
        return pushMathSlot(token.text, true, true);
      }
      return false;
    },
  },
});
md.use({ extensions: [mathBlockExtension, mathInlineExtension] });

/** Sanitized HTML for a markdown reply. */
export function markdownReplyHtml(text: string): string {
  let sentinel = "HADMATHSLOT";
  while (text.includes(sentinel)) sentinel += "X";
  const slots: MathSlot[] = [];
  activeSlots = slots;
  activeSentinel = sentinel;
  let html: string;
  try {
    html = md.parse(text, { async: false }) as string;
  } finally {
    activeSlots = null;
    activeSentinel = "";
  }
  let safe = DOMPurify.sanitize(html, { ALLOWED_TAGS, ALLOWED_ATTR: ["href", "title", "start", "align"] }).trim();
  if (slots.length > 0) {
    for (let i = 0; i < slots.length; i++) {
      const token = `@@${sentinel}:${i}@@`;
      const slot = slots[i];
      if (slot.block) {
        safe = safe.replace(`<p>${token}</p>`, () => slot.html);
      }
      safe = safe.replace(token, () => slot.html);
    }
  }
  return safe;
}

/** Render `text` as markdown into `into` (replacing its content). */
export function renderMarkdownReply(into: HTMLElement, text: string): void {
  into.classList.add("md");
  into.innerHTML = markdownReplyHtml(text);
  for (const a of into.querySelectorAll<HTMLAnchorElement>("a")) {
    const href = a.getAttribute("href") ?? "";
    // Only web and mail links are links; anything else (javascript:, file:, relative) is text.
    if (!EXTERNAL_LINK_RE.test(href)) a.removeAttribute("href");
    a.addEventListener("click", (ev) => {
      // Never let the webview itself navigate: that would replace the app.
      ev.preventDefault();
      ev.stopPropagation();
      if (EXTERNAL_LINK_RE.test(href)) void openUrl(href).catch(() => {});
    });
  }
}
