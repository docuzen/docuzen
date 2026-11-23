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

/** Elements whose content is raw text: nothing inside them is markup until their end tag. */
const RAW_TEXT_TAGS = new Set(["script", "style", "xmp", "iframe", "noembed", "noframes"]);
/** Elements whose content is text with character references (RCDATA): no tags inside either. */
const RCDATA_TAGS = new Set(["textarea", "title"]);

const SPACE = /[\t\n\f\r ]/;
const ASCII_ALPHA = /[A-Za-z]/;
const TAG_NAME = /^[^\t\n\f\r />]+/;

/**
 * Line/column of increasing offsets into `html`, counting forward from the previous
 * answer so a whole validation pass costs one walk of the input.
 */
function locator(html: string): (index: number) => { line: number; column: number } {
  let pos = 0;
  let line = 1;
  let column = 1;
  return (index) => {
    if (index < pos) {
      pos = 0;
      line = 1;
      column = 1;
    }
    for (; pos < index; pos++) {
      if (html.charCodeAt(pos) === 10) {
        line++;
        column = 1;
      } else {
        column++;
      }
    }
    return { line, column };
  };
}

/**
 * Scan a tag from `from` (just past "<" or "</") to its closing ">", as the HTML tokenizer
 * does: a quote only opens after "=", and "/" makes the tag self-closing only when it comes
 * right before ">" outside an unquoted attribute value (`<a href=/docs/>` is not
 * self-closing). Returns end -1 when the input runs out first.
 */
function scanTag(html: string, from: number): { end: number; selfClosing: boolean } {
  let state: "name" | "between" | "beforeValue" | "unquoted" | '"' | "'" = "name";
  let slash = false;
  for (let i = from; i < html.length; i++) {
    const ch = html[i];
    if (state === '"' || state === "'") {
      if (ch === state) state = "between";
      continue;
    }
    if (ch === ">") return { end: i, selfClosing: slash };
    slash = false;
    if (state === "name") {
      if (SPACE.test(ch)) state = "between";
      else if (ch === "/") {
        state = "between";
        slash = true;
      } else if (ch === "=") state = "beforeValue";
    } else if (state === "between") {
      if (ch === "/") slash = true;
      else if (ch === "=") state = "beforeValue";
      else if (!SPACE.test(ch)) state = "name";
    } else if (state === "beforeValue") {
      if (ch === '"' || ch === "'") state = ch;
      else if (!SPACE.test(ch)) state = "unquoted";
    } else if (SPACE.test(ch)) {
      state = "between"; // end of an unquoted value
    }
  }
  return { end: -1, selfClosing: false };
}

function unclosedSpecial(name: string, at: number, html: string): HtmlValidationResult {
  const loc = locator(html)(at);
  return {
    ok: false,
    error: `unclosed <${name}> starting at line ${loc.line}, column ${loc.column}`,
  };
}

/**
 * Check that HTML source has balanced, properly nested tags. Strict on purpose: optional
 * end tags (`<p>` without `</p>`) are reported as unclosed. Follows the HTML tokenizer on
 * what is markup at all: a "<" starts a tag only when a letter, "/", "!" or "?" follows,
 * so `a < b` is text, and script/style/textarea/title content is text up to its end tag.
 */
export function validateHtml(html: string): HtmlValidationResult {
  const stack: OpenTag[] = [];
  const locate = locator(html);
  let i = 0;

  while (i < html.length) {
    const start = html.indexOf("<", i);
    if (start === -1) break;
    const next = html[start + 1] ?? "";

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

    const closing = next === "/";
    const nameAt = closing ? start + 2 : start + 1;
    if (next === "!" || next === "?" || (closing && !ASCII_ALPHA.test(html[nameAt] ?? ""))) {
      // Doctype, processing instruction or bogus comment (incl. "</ p>", which is not an
      // end tag): it runs to the first ">".
      const end = html.indexOf(">", nameAt);
      if (end === -1) return unclosedSpecial("tag", start, html);
      i = end + 1;
      continue;
    }
    if (!closing && !ASCII_ALPHA.test(next)) {
      i = start + 1; // a "<" that starts no tag is text
      continue;
    }

    const { end, selfClosing } = scanTag(html, nameAt);
    if (end === -1) return unclosedSpecial("tag", start, html);
    const name = TAG_NAME.exec(html.slice(nameAt, end))![0].toLowerCase();

    if (closing) {
      const top = stack.at(-1);
      const loc = locate(start);
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

    if (selfClosing || VOID_TAGS.has(name)) {
      i = end + 1;
      continue;
    }

    if (RAW_TEXT_TAGS.has(name) || RCDATA_TAGS.has(name)) {
      const closeRe = new RegExp(`</${name}[\\t\\n\\f\\r />]`, "gi");
      closeRe.lastIndex = end + 1;
      const close = closeRe.exec(html);
      const closeEnd = close ? scanTag(html, close.index + 2).end : -1;
      if (closeEnd === -1) {
        const loc = locate(start);
        return {
          ok: false,
          error: `unclosed <${name}> starting at line ${loc.line}, column ${loc.column}`,
        };
      }
      i = closeEnd + 1;
      continue;
    }

    stack.push({ name, ...locate(start) });
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
