export interface TextMatch {
  start: number;
  end: number;
}

/**
 * `s` lowercased, plus — when lowercasing changed its length (e.g. "İ" becomes "i" and a
 * combining dot) — the span of `s` each lowered code unit came from, so a match found in
 * the lowered text can be reported in `s`'s own offsets.
 */
function lowerWithMap(s: string): { lower: string; from?: number[]; to?: number[] } {
  const lower = s.toLocaleLowerCase();
  if (lower.length === s.length) return { lower };
  let out = "";
  const from: number[] = [];
  const to: number[] = [];
  let i = 0;
  for (const ch of s) {
    const l = ch.toLocaleLowerCase();
    for (let k = 0; k < l.length; k++) {
      from.push(i);
      to.push(i + ch.length);
    }
    out += l;
    i += ch.length;
  }
  return { lower: out, from, to };
}

/** Case-insensitive, non-overlapping matches of `rawQuery` in `text`, as offsets into `text`. */
export function findTextMatches(text: string, rawQuery: string): TextMatch[] {
  const query = rawQuery.trim();
  if (!query) return [];

  const { lower: haystack, from, to } = lowerWithMap(text);
  const needle = lowerWithMap(query).lower;
  const matches: TextMatch[] = [];
  let cursor = 0;
  while (cursor <= haystack.length - needle.length) {
    const at = haystack.indexOf(needle, cursor);
    if (at < 0) break;
    const end = at + needle.length;
    // A match that starts or ends inside one character's lowercase form covers all of it.
    matches.push(from && to ? { start: from[at], end: to[end - 1] } : { start: at, end });
    cursor = end;
  }
  return matches;
}

export function nextSearchIndex(current: number, total: number, direction: 1 | -1): number {
  if (total <= 0) return -1;
  if (current < 0) return direction > 0 ? 0 : total - 1;
  return (current + direction + total) % total;
}
