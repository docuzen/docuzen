// Inline agent directives: the writer embeds `[[ instruction ]]` directly in the document
// to steer the agent from inside the text (instead of the chat). A directive pass asks the
// agent to make each requested change AND remove its `[[ … ]]` marker, surfaced as a normal
// reviewable proposal.

export interface Directive {
  /** The full matched marker including brackets, e.g. "[[ add a citation ]]". */
  marker: string;
  /** The trimmed instruction text inside the brackets. */
  instruction: string;
  /** Character index of the marker's start in the source body. */
  index: number;
}

/**
 * Find inline `[[ … ]]` directives in `body`, in document order. Milkdown escapes literal
 * opening brackets when serializing markdown (`\[\[ ... ]]`), so accept both source forms.
 * The returned marker is the exact source span so approve/remove edits target the saved text.
 * The inner text must be non-empty (after trimming); nested `]]` ends the match at the first
 * occurrence. Returns an empty array when there are none.
 */
export function findDirectives(body: string): Directive[] {
  const out: Directive[] = [];
  // Opening brackets may be raw "[[" or markdown-escaped "\\[\\["; closing brackets may
  // also be escaped by some serializers. Inner text never starts a raw/escaped close, so
  // a marker can't bridge across adjacent empty markers.
  const re = /(?:\[\[|\\\[\\\[)((?:(?!\]\]|\\\]\\\])[\s\S])+)(?:\]\]|\\\]\\\])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const instruction = m[1].trim();
    if (!instruction) continue; // "[[]]" / "[[  ]]" — not a directive
    out.push({ marker: m[0], instruction, index: m.index });
  }
  return out;
}
