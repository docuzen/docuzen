export interface TextMatch {
  start: number;
  end: number;
}

export function findTextMatches(text: string, rawQuery: string): TextMatch[] {
  const query = rawQuery.trim();
  if (!query) return [];

  const haystack = text.toLocaleLowerCase();
  const needle = query.toLocaleLowerCase();
  const matches: TextMatch[] = [];
  let cursor = 0;
  while (cursor <= haystack.length - needle.length) {
    const at = haystack.indexOf(needle, cursor);
    if (at < 0) break;
    matches.push({ start: at, end: at + needle.length });
    cursor = at + needle.length;
  }
  return matches;
}

export function nextSearchIndex(current: number, total: number, direction: 1 | -1): number {
  if (total <= 0) return -1;
  if (current < 0) return direction > 0 ? 0 : total - 1;
  return (current + direction + total) % total;
}
