// A short, readable stand-in for a long quoted selection: its opening words, an ellipsis,
// and its closing words. Panels show this instead of the full text — a whole-document
// selection would otherwise fill the rail and the chat header with the document itself.

export const EXCERPT_MAX = 220;
const HEAD = 130;
const TAIL = 70;

/** Cut `s` to at most `n` chars from the start, backing up to a word boundary when one is near. */
function headWords(s: string, n: number): string {
  const cut = s.slice(0, n);
  const sp = cut.lastIndexOf(" ");
  return (sp > n * 0.6 ? cut.slice(0, sp) : cut).trimEnd();
}

function tailWords(s: string, n: number): string {
  const cut = s.slice(-n);
  const sp = cut.indexOf(" ");
  return (sp >= 0 && sp < n * 0.4 ? cut.slice(sp + 1) : cut).trimStart();
}

/** Whitespace-collapsed text, shortened to "start … end" when longer than EXCERPT_MAX. */
export function excerpt(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= EXCERPT_MAX) return flat;
  return `${headWords(flat, HEAD)} … ${tailWords(flat, TAIL)}`;
}
