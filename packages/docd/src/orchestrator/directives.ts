// Inline agent directives: the writer embeds `[[ instruction ]]` directly in the document
// to steer the agent from inside the text (instead of the chat). A directive pass asks the
// agent to make each requested change AND remove its `[[ … ]]` marker, surfaced as a normal
// reviewable proposal.
//
// The desktop editor finds the same directives on its own (apps/desktop/src/editor.ts,
// findDirectiveOffsets) to number them for ⌘-click: `directive-N` is an ordinal, so the two
// detectors must agree on which markers count. Both apply the same rules — code is never a
// directive (here: fenced blocks and inline code spans; there: code blocks and inline-code
// text), a marker never contains another opening `[[`, and a whitespace-only marker is not
// a directive. apps/desktop/src/directive-agreement.test.ts holds them to it.

export interface Directive {
  /** The full matched marker including brackets, e.g. "[[ add a citation ]]". */
  marker: string;
  /** The trimmed instruction text inside the brackets. */
  instruction: string;
  /** Character index of the marker's start in the source body. */
  index: number;
}

/** Stands in for code characters while matching: neither a bracket nor whitespace. */
const CODE_MASK = "x";

/** An opening fence (``` or ~~~, 3+), after any blockquote/list-item markers. */
const FENCE_OPEN = /^(?:[ \t]*(?:>|[-*+]|\d{1,9}[.)])(?=[ \t]|$))*[ \t]*(`{3,}|~{3,})(.*)$/;

/** [start, end) ranges of fenced code blocks, fence lines included. An unclosed fence runs to the end. */
function fencedCodeRanges(body: string): [number, number][] {
  const out: [number, number][] = [];
  let open: { start: number; char: string; len: number } | null = null;
  let lineStart = 0;
  while (lineStart <= body.length) {
    const nl = body.indexOf("\n", lineStart);
    const lineEnd = nl === -1 ? body.length : nl;
    const line = body.slice(lineStart, lineEnd);
    if (open) {
      const close = /^(?:[ \t]*>)*[ \t]*(`{3,}|~{3,})[ \t]*$/.exec(line);
      if (close && close[1][0] === open.char && close[1].length >= open.len) {
        out.push([open.start, lineEnd]);
        open = null;
      }
    } else {
      const m = FENCE_OPEN.exec(line);
      // A backtick fence's info string can't contain a backtick (that's inline code).
      if (m && !(m[1][0] === "`" && m[2].includes("`"))) open = { start: lineStart, char: m[1][0], len: m[1].length };
    }
    if (nl === -1) break;
    lineStart = nl + 1;
  }
  if (open) out.push([open.start, body.length]);
  return out;
}

/**
 * [start, end) ranges of inline code spans (backticks included) in `body[from, to)`:
 * a run of N backticks up to the next run of exactly N, within one paragraph. A
 * backslash-escaped backtick is literal text.
 */
function inlineCodeRanges(body: string, from: number, to: number, out: [number, number][]): void {
  let i = from;
  while (i < to) {
    const c = body[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c !== "`") {
      i++;
      continue;
    }
    let j = i;
    while (j < to && body[j] === "`") j++;
    const n = j - i;
    let k = j;
    let close = -1;
    while (k < to) {
      if (body[k] === "`") {
        let m = k;
        while (m < to && body[m] === "`") m++;
        if (m - k === n) {
          close = k;
          break;
        }
        k = m;
      } else if (body[k] === "\n" && /^\n[ \t]*(?:\n|$)/.test(body.slice(k, k + 64))) {
        break; // a blank line ends the paragraph: no code span crosses it
      } else {
        k++;
      }
    }
    if (close === -1) {
      i = j; // an unmatched run is literal backticks
      continue;
    }
    out.push([i, close + n]);
    i = close + n;
  }
}

/** `body` with every code character replaced, so brackets in code neither open nor close a directive. */
function maskCode(body: string): string {
  const code = fencedCodeRanges(body);
  const spans: [number, number][] = [];
  let at = 0;
  for (const [s, e] of code) {
    inlineCodeRanges(body, at, s, spans);
    at = e;
  }
  inlineCodeRanges(body, at, body.length, spans);
  const all = [...code, ...spans].sort((a, b) => a[0] - b[0]);
  if (!all.length) return body;
  let out = "";
  let last = 0;
  for (const [s, e] of all) {
    out += body.slice(last, s) + CODE_MASK.repeat(e - s);
    last = e;
  }
  return out + body.slice(last);
}

/**
 * Find inline `[[ … ]]` directives in `body`, in document order. Milkdown escapes literal
 * opening brackets when serializing markdown (`\[\[ ... ]]`), so accept both source forms.
 * The returned marker is the exact source span so approve/remove edits target the saved text.
 * The inner text must be non-empty (after trimming); nested `]]` ends the match at the first
 * occurrence, and an opening `[[` that is never closed is plain text (it does not swallow the
 * next directive). Code — fenced blocks and inline code spans — is never a directive, though
 * a directive may contain code. Returns an empty array when there are none.
 */
export function findDirectives(body: string): Directive[] {
  const out: Directive[] = [];
  // Opening brackets may be raw "[[" or markdown-escaped "\\[\\["; closing brackets may
  // also be escaped by some serializers. Inner text never starts a raw/escaped open or
  // close, so a marker can't bridge across adjacent or unclosed markers.
  const re = /(?:\[\[|\\\[\\\[)((?:(?!\]\]|\\\]\\\]|\[\[|\\\[\\\[)[\s\S])+)(?:\]\]|\\\]\\\])/g;
  const masked = maskCode(body);
  let m: RegExpExecArray | null;
  while ((m = re.exec(masked)) !== null) {
    if (!m[1].trim()) continue; // "[[]]" / "[[  ]]" — not a directive
    const marker = body.slice(m.index, m.index + m[0].length);
    const open = marker.startsWith("[[") ? 2 : 4;
    const close = marker.endsWith("\\]\\]") ? 4 : 2;
    out.push({ marker, instruction: marker.slice(open, marker.length - close).trim(), index: m.index });
  }
  return out;
}
