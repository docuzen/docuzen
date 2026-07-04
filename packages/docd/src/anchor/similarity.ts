/** Classic Levenshtein edit distance between two strings. */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  let prev = new Array<number>(n + 1);
  let curr = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1, // deletion
        curr[j - 1] + 1, // insertion
        prev[j - 1] + cost, // substitution
      );
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

/**
 * Levenshtein distance capped at `k`: returns the exact distance when it is
 * <= k, and any value > k otherwise. Runs the DP inside a diagonal band of
 * half-width k (cells further than k off the diagonal cost > k by
 * construction) and bails out as soon as a whole row exceeds k, so the cost is
 * O(max(m,n) * k) instead of O(m * n). This is what makes scoring a fuzzy-scan
 * candidate cheap: any window that could clear the acceptance threshold has
 * distance <= k, and for those the band always contains the true value.
 */
export function levenshteinWithin(a: string, b: string, k: number): number {
  if (a === b) return 0;
  if (k <= 0) return k + 1; // not equal and no edits allowed
  const m = a.length;
  const n = b.length;
  if (Math.abs(m - n) > k) return k + 1;
  if (m === 0) return n; // n <= k here, per the guard above
  if (n === 0) return m;
  if (k >= m + n) return levenshtein(a, b); // degenerate: band covers everything

  const INF = k + 1;
  let prev = new Array<number>(n + 2).fill(INF);
  let curr = new Array<number>(n + 2).fill(INF);
  for (let j = 0; j <= Math.min(n, k); j++) prev[j] = j;

  for (let i = 1; i <= m; i++) {
    const lo = Math.max(1, i - k);
    const hi = Math.min(n, i + k);
    curr[lo - 1] = lo === 1 && i <= k ? i : INF;
    let rowMin = curr[lo - 1];
    for (let j = lo; j <= hi; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = prev[j - 1] + cost; // substitution / match
      const del = prev[j] + 1; // deletion from `a`
      if (del < v) v = del;
      const ins = curr[j - 1] + 1; // insertion into `a`
      if (ins < v) v = ins;
      curr[j] = v > INF ? INF : v;
      if (v < rowMin) rowMin = v;
    }
    // The cell just past the band still holds a value from two rows ago (the
    // arrays are swapped, not cleared); reset it so the next row's `prev[j]`
    // read at its widened right edge sees "outside the band", not stale data.
    if (hi < n) curr[hi + 1] = INF;
    if (rowMin > k) return k + 1; // no path through this row can recover
    [prev, curr] = [curr, prev];
  }
  return prev[n] <= k ? prev[n] : k + 1;
}

/** Similarity ratio in [0,1]: 1 - distance / maxLen. Two empty strings => 1. */
export function similarity(a: string, b: string): number {
  if (a.length === 0 && b.length === 0) return 1;
  const dist = levenshtein(a, b);
  const maxLen = Math.max(a.length, b.length);
  return 1 - dist / maxLen;
}
