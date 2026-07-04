export interface HtmlValidationResult {
  ok: boolean;
  error?: string;
}

interface OpenTag {
  name: string;
  line: number;
  column: number;
}

const VOID_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

const RAW_TEXT_TAGS = new Set(["script", "style"]);

function lineColumn(html: string, index: number): { line: number; column: number } {
  let line = 1;
  let column = 1;
  for (let i = 0; i < index; i++) {
    if (html.charCodeAt(i) === 10) {
      line++;
      column = 1;
    } else {
      column++;
    }
  }
  return { line, column };
}

function findTagEnd(html: string, start: number): number {
  let quote: string | null = null;
  for (let i = start; i < html.length; i++) {
    const ch = html[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === ">") {
      return i;
    }
  }
  return -1;
}

function tagNameFrom(raw: string): string | null {
  const match = /^\/?\s*([A-Za-z][A-Za-z0-9:-]*)/.exec(raw.trim());
  return match?.[1].toLowerCase() ?? null;
}

function unclosedSpecial(name: string, at: number, html: string): HtmlValidationResult {
  const loc = lineColumn(html, at);
  return {
    ok: false,
    error: `unclosed <${name}> starting at line ${loc.line}, column ${loc.column}`,
  };
}

export function validateHtml(html: string): HtmlValidationResult {
  const stack: OpenTag[] = [];
  let i = 0;

  while (i < html.length) {
    const start = html.indexOf("<", i);
    if (start === -1) break;

    if (html.startsWith("<!--", start)) {
      const end = html.indexOf("-->", start + 4);
      if (end === -1) return unclosedSpecial("!-- comment --", start, html);
      i = end + 3;
      continue;
    }

    if (html.startsWith("<![CDATA[", start)) {
      const end = html.indexOf("]]>", start + 9);
      if (end === -1) return unclosedSpecial("![CDATA[", start, html);
      i = end + 3;
      continue;
    }

    const end = findTagEnd(html, start + 1);
    if (end === -1) return unclosedSpecial("tag", start, html);

    const raw = html.slice(start + 1, end).trim();
    if (!raw || raw.startsWith("!") || raw.startsWith("?")) {
      i = end + 1;
      continue;
    }

    const closing = raw.startsWith("/");
    const name = tagNameFrom(raw);
    if (!name) {
      i = end + 1;
      continue;
    }

    const loc = lineColumn(html, start);
    if (closing) {
      const top = stack.at(-1);
      if (!top) {
        return {
          ok: false,
          error: `unexpected </${name}> at line ${loc.line}, column ${loc.column}`,
        };
      }
      if (top.name !== name) {
        return {
          ok: false,
          error:
            `expected </${top.name}> before </${name}> at line ${loc.line}, column ${loc.column}` +
            ` (opened <${top.name}> at line ${top.line}, column ${top.column})`,
        };
      }
      stack.pop();
      i = end + 1;
      continue;
    }

    const selfClosing = raw.endsWith("/") || VOID_TAGS.has(name);
    if (selfClosing) {
      i = end + 1;
      continue;
    }

    if (RAW_TEXT_TAGS.has(name)) {
      const closeRe = new RegExp(`</\\s*${name}\\s*>`, "gi");
      closeRe.lastIndex = end + 1;
      const close = closeRe.exec(html);
      if (!close) {
        return {
          ok: false,
          error: `unclosed <${name}> starting at line ${loc.line}, column ${loc.column}`,
        };
      }
      i = close.index + close[0].length;
      continue;
    }

    stack.push({ name, ...loc });
    i = end + 1;
  }

  const top = stack.at(-1);
  if (top) {
    return {
      ok: false,
      error: `unclosed <${top.name}> starting at line ${top.line}, column ${top.column}`,
    };
  }
  return { ok: true };
}
