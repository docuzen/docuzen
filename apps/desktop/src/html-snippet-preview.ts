export interface HtmlSnippetPreviewContext {
  baseHref?: string;
  headHtml: string;
  htmlAttrs?: string;
  bodyAttrs?: string;
  colorContextCss?: string;
}

const HTML_FENCE_RE = /^```(?:html?|xml)\s*\n([\s\S]*?)\n```$/i;
const HTML_TAG_RE = /<[a-z][\w:-]*(?:\s[^<>]*)?>/i;
const HTML_CLOSE_RE = /<\/[a-z][\w:-]*\s*>/i;
const VOID_TAG_RE = /<(?:area|base|br|col|embed|hr|img|input|link|meta|source|track|wbr)\b/i;
const THEME_ATTR_RE = /^(?:class|id|dir|lang|style|data-[\w:-]+)$/i;
const INHERITED_STYLE_PROPS = [
  "color",
  "background-color",
  "background-image",
  "background-position",
  "background-size",
  "background-repeat",
  "background-attachment",
  "font-family",
  "font-size",
  "font-style",
  "font-weight",
  "font-stretch",
  "line-height",
  "letter-spacing",
  "text-rendering",
  "color-scheme",
];

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function serializeAttrs(el: Element, names: string[]): string {
  const attrs: string[] = [];
  for (const name of names) {
    if (!el.hasAttribute(name)) continue;
    const value = el.getAttribute(name);
    attrs.push(value == null || value === "" ? name : `${name}="${escapeAttr(value)}"`);
  }
  return attrs.length ? ` ${attrs.join(" ")}` : "";
}

function serializeThemeAttrs(el: Element | null | undefined): string {
  if (!el) return "";
  const attrs: string[] = [];
  for (const attr of Array.from(el.attributes)) {
    if (!THEME_ATTR_RE.test(attr.name)) continue;
    attrs.push(attr.value === "" ? attr.name : `${attr.name}="${escapeAttr(attr.value)}"`);
  }
  return attrs.length ? ` ${attrs.join(" ")}` : "";
}

function stylesheetHeadHtml(node: Element): string {
  if (node.tagName === "LINK") {
    const attrs = serializeAttrs(node, [
      "rel",
      "href",
      "media",
      "type",
      "crossorigin",
      "integrity",
      "referrerpolicy",
      "disabled",
    ]);
    return attrs ? `<link${attrs}>` : "";
  }
  if (node.tagName === "STYLE") {
    const attrs = serializeAttrs(node, ["media", "title"]);
    const css = (node.textContent ?? "").replace(/<\/style/gi, "<\\/style");
    return `<style${attrs}>${css}</style>`;
  }
  return "";
}

function escapeStyleContent(css: string): string {
  return css.replace(/<\/style/gi, "<\\/style");
}

function styleDeclarations(style: CSSStyleDeclaration, props: string[]): string[] {
  const declarations: string[] = [];
  for (const prop of props) {
    const value = style.getPropertyValue(prop).trim();
    if (prop === "background-color" && isTransparentColor(value)) continue;
    if (prop === "background-image" && value === "none") continue;
    if (value) declarations.push(`${prop}: ${value};`);
  }
  return declarations;
}

function isTransparentColor(value: string): boolean {
  return (
    value === "transparent" ||
    value === "rgba(0, 0, 0, 0)" ||
    value === "rgb(0 0 0 / 0)" ||
    value === "rgb(0 0 0 / 0%)"
  );
}

function customPropertyDeclarations(style: CSSStyleDeclaration): string[] {
  const declarations: string[] = [];
  for (let i = 0; i < style.length; i++) {
    const prop = style.item(i);
    if (!prop.startsWith("--")) continue;
    const value = style.getPropertyValue(prop).trim();
    if (value) declarations.push(`${prop}: ${value};`);
  }
  return declarations;
}

function colorContextCss(doc: Document | null | undefined): string {
  const view = doc?.defaultView;
  const root = doc?.documentElement;
  if (!view || !root) return "";

  const rootStyle = view.getComputedStyle(root);
  const rootDeclarations = [
    ...customPropertyDeclarations(rootStyle),
    ...styleDeclarations(rootStyle, ["color", "background-color", "background-image", "color-scheme"]),
  ];
  const rules = rootDeclarations.length ? [`:root { ${rootDeclarations.join(" ")} }`] : [];

  if (doc.body) {
    const bodyStyle = view.getComputedStyle(doc.body);
    const bodyDeclarations = [
      ...customPropertyDeclarations(bodyStyle),
      ...styleDeclarations(bodyStyle, INHERITED_STYLE_PROPS),
    ];
    if (bodyDeclarations.length) rules.push(`body { ${bodyDeclarations.join(" ")} }`);
  }

  return escapeStyleContent(rules.join("\n"));
}

export function htmlPreviewSnippet(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const fenced = HTML_FENCE_RE.exec(trimmed);
  const candidate = (fenced?.[1] ?? trimmed).trim();
  if (!candidate.startsWith("<")) return null;
  if (!HTML_TAG_RE.test(candidate)) return null;
  if (!HTML_CLOSE_RE.test(candidate) && !VOID_TAG_RE.test(candidate) && !/^<!doctype\s+html/i.test(candidate)) {
    return null;
  }
  return candidate;
}

export function buildHtmlSnippetPreviewContext(
  doc: Document | null | undefined,
  baseHref?: string,
): HtmlSnippetPreviewContext {
  const headHtml = doc?.head
    ? Array.from(
        // Excludes both injected UI-only style tags: data-had-overlay (highlight/
        // comment/search chrome) and data-had-zoom (doc-zoom.ts's view-only
        // `:root { font-size }` rule) — neither belongs in a rendered preview.
        doc.head.querySelectorAll('link[rel~="stylesheet"], style:not([data-had-overlay]):not([data-had-zoom])'),
      )
        .map(stylesheetHeadHtml)
        .filter(Boolean)
        .join("\n")
    : "";
  return {
    baseHref,
    headHtml,
    htmlAttrs: serializeThemeAttrs(doc?.documentElement),
    bodyAttrs: serializeThemeAttrs(doc?.body),
    colorContextCss: colorContextCss(doc),
  };
}

export function buildHtmlSnippetPreviewSrcdoc(
  snippet: string,
  context: HtmlSnippetPreviewContext,
): string {
  const base = context.baseHref ? `<base href="${escapeAttr(context.baseHref)}">` : "";
  const colorContextCss = context.colorContextCss ? `\n${context.colorContextCss}` : "";
  return `<!doctype html>
<html${context.htmlAttrs ?? ""}>
<head>
<meta charset="utf-8">
${base}
${context.headHtml}
<style>
html, body { margin: 0; }
body { padding: 10px; overflow: auto; background: Canvas; color: CanvasText; }
${colorContextCss}
.had-snippet-root { display: block; min-width: 0; }
img, video, svg, iframe { max-width: 100%; }
</style>
</head>
<body${context.bodyAttrs ?? ""}><main class="had-snippet-root">${snippet}</main></body>
</html>`;
}

export function createHtmlSnippetPreviewFrame(
  doc: Document,
  snippet: string,
  context: HtmlSnippetPreviewContext,
): HTMLIFrameElement {
  const iframe = doc.createElement("iframe");
  iframe.className = "html-snippet-frame";
  iframe.setAttribute("sandbox", "");
  iframe.setAttribute("referrerpolicy", "no-referrer");
  iframe.srcdoc = buildHtmlSnippetPreviewSrcdoc(snippet, context);
  return iframe;
}
