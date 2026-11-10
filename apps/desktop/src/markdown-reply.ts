// Agent replies are markdown (bold, lists, code); this renders one into a chat bubble.
// The reply is model output, so the HTML marked produces is sanitized before it touches
// the DOM, and links never navigate the app window: they open in the system browser.
import DOMPurify from "dompurify";
import { Marked } from "marked";
import { openUrl } from "@tauri-apps/plugin-opener";

const ALLOWED_TAGS = [
  "a", "b", "blockquote", "br", "code", "del", "em", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "i",
  "li", "ol", "p", "pre", "s", "strong", "sub", "sup", "table", "tbody", "td", "th", "thead", "tr", "ul",
];
const EXTERNAL_LINK_RE = /^(?:https?:|mailto:)/i;

const escapeHtml = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Raw HTML in a reply is shown as written, never interpreted: replies often quote markup.
const md = new Marked({
  gfm: true,
  breaks: true,
  renderer: { html: (token) => escapeHtml(token.text) },
});

/** Sanitized HTML for a markdown reply. */
export function markdownReplyHtml(text: string): string {
  const html = md.parse(text, { async: false }) as string;
  return DOMPurify.sanitize(html, { ALLOWED_TAGS, ALLOWED_ATTR: ["href", "title", "start", "align"] }).trim();
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
