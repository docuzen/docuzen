import type { TextQuoteAnchor, ResolvedRange } from "./types.js";
import { similarity, levenshteinWithin } from "./similarity.js";

export interface ResolveOptions {
  /** Minimum similarity [0,1] for a fuzzy match to count. Default 0.7. */
  threshold?: number;
  /**
   * Internal observability seam (tests + profiling): counts how many candidate
   * windows the fuzzy scan actually scored with an edit-distance DP. The
   * complexity regression guard asserts this stays proportional to the number
   * of near-match regions, not to the document length.
   */
  stats?: ResolveStats;
}

export interface ResolveStats {
  /** Candidate (start, len) windows scored by an edit-distance DP. */
  windowsScored: number;
}

function allIndexesOf(haystack: string, needle: string): number[] {
  if (needle.length === 0) return [];
  const out: number[] = [];
  let from = 0;
  for (;;) {
    const i = haystack.indexOf(needle, from);
    if (i === -1) break;
    out.push(i);
    from = i + 1;
  }
  return out;
}

/** Score how well the text around `start` matches the anchor's prefix/suffix. */
function contextScore(
  text: string,
  start: number,
  exactLen: number,
  anchor: TextQuoteAnchor,
): number {
  const before = text.slice(Math.max(0, start - anchor.prefix.length), start);
  const after = text.slice(start + exactLen, start + exactLen + anchor.suffix.length);
  const pScore = anchor.prefix.length === 0 ? 1 : similarity(before, anchor.prefix);
  const sScore = anchor.suffix.length === 0 ? 1 : similarity(after, anchor.suffix);
  return (pScore + sScore) / 2;
}

/**
 * Sellers semi-global edit-distance sweep: dist[j] = the minimum Levenshtein
 * distance between `pattern` and ANY substring of `text` ending at offset j
 * (exclusive). One O(pattern.length * text.length) pass, O(text.length) output.
 *
 * Every fixed window ending at j is one of those substrings, so dist[j] is a
 * true LOWER BOUND on that window's distance — which is what lets the fuzzy
 * scan below skip the per-window DP almost everywhere.
 */
function sellersMinDistByEnd(text: string, pattern: string): Int32Array {
  const m = pattern.length;
  const n = text.length;
  const dist = new Int32Array(n + 1);
  let prev = new Int32Array(m + 1);
  let curr = new Int32Array(m + 1);
  for (let i = 0; i <= m; i++) prev[i] = i; // vs the empty substring ending at 0
  dist[0] = prev[m];
  for (let j = 1; j <= n; j++) {
    curr[0] = 0; // a substring may start anywhere: matching zero pattern chars is free
    const tc = text.charCodeAt(j - 1);
    for (let i = 1; i <= m; i++) {
      const cost = pattern.charCodeAt(i - 1) === tc ? 0 : 1;
      let v = prev[i - 1] + cost; // substitution / match
      const del = curr[i - 1] + 1; // pattern char unmatched
      if (del < v) v = del;
      const ins = prev[i] + 1; // extra text char inside the match
      if (ins < v) v = ins;
      curr[i] = v;
    }
    dist[j] = curr[m];
    const t = prev;
    prev = curr;
    curr = t;
  }
  return dist;
}

/**
 * Sliding-window fuzzy search: find the window whose similarity to `exact` is
 * highest. Returns a range if the best score >= threshold, else null (orphan).
 *
 * Semantics are those of the original dense scan — for every start offset,
 * score windows of length w, w-1, w+1 (in that order) and select the first
 * window (in that traversal order) attaining the maximum score — but the
 * O(docLen * needleLen^2) cost (a full Levenshtein DP at EVERY character
 * offset, which froze the UI for tens of seconds on 100KB+ docs) is gone:
 *
 *   1. One Sellers pass (O(docLen * needleLen)) lower-bounds the distance of
 *      every window via its end offset; ends whose bound cannot reach the
 *      acceptance threshold are never touched again, so the number of
 *      DP-scored windows tracks the near-match regions, not the doc length.
 *   2. Surviving ends are visited in ascending lower-bound order (bucketed
 *      by distance). The scan stops at the first bucket whose bound is
 *      strictly below the running max — such windows can neither raise the
 *      max nor tie it. Buckets that could still contain a tying window ARE
 *      visited, and ties are resolved by explicit (start, len-order)
 *      lexicographic comparison, reproducing the dense scan's traversal
 *      order exactly. Scores are bit-identical floats (same dist, same
 *      maxLen formula), so tie comparison is exact.
 *   3. Each candidate is scored with a banded early-exit DP capped at the
 *      tightest bound that still matters: the threshold-implied max edit
 *      distance, shrunk further as the running max rises. A window whose
 *      distance exceeds the cap is provably unable to reach the threshold /
 *      beat or tie the max, so skipping it cannot change the result
 *      (sub-threshold scores only ever influenced the original's internal
 *      bookkeeping, never its return value); a window within the cap gets
 *      its exact distance, hence its exact score.
 */
function fuzzyFind(
  text: string,
  exact: string,
  threshold: number,
  stats?: ResolveStats,
): ResolvedRange | null {
  const w = exact.length;
  if (w === 0 || text.length === 0) return null;

  // Max edit distance an accepted window can have: score = 1 - d/maxLen >=
  // threshold with maxLen <= w+1  =>  d <= (1 - threshold) * (w + 1).
  const kAccept = Math.max(0, Math.floor((1 - threshold) * (w + 1)));
  const minDistByEnd = sellersMinDistByEnd(text, exact);

  // Bucket candidate window ends by their lower-bound distance.
  const buckets: number[][] = Array.from({ length: kAccept + 1 }, () => []);
  for (let e = 1; e <= text.length; e++) {
    const d = minDistByEnd[e];
    if (d <= kAccept) buckets[d].push(e);
  }

  const lens = [w, w - 1, w + 1];
  let maxScore = -1;
  let bestStart = -1;
  let bestEnd = -1;
  let bestLenIdx = -1;
  for (let d = 0; d <= kAccept; d++) {
    // Strictly-below-max buckets can neither raise nor tie the max. (A bucket
    // whose bound EQUALS the max may still contain the earliest tying window;
    // the epsilon keeps float rounding from ever mistaking "equal" for
    // "below" — breaking a bucket late is safe, breaking early is not.)
    if (1 - d / (w + 1) < maxScore - 1e-9) break;
    for (const e of buckets[d]) {
      for (let lenIdx = 0; lenIdx < 3; lenIdx++) {
        const len = lens[lenIdx];
        const start = e - len;
        if (len <= 0 || start < 0) continue;
        // Cap the DP at the largest distance that could still matter: tying
        // or beating the max needs dist <= (1 - maxScore) * (w + 1), and
        // clearing the threshold gate needs dist <= kAccept. The +1 margin
        // absorbs float rounding — an over-wide cap only wastes a few DP
        // cells, an under-wide one could skip a legitimate tying window.
        const kDyn =
          maxScore <= threshold
            ? kAccept
            : Math.min(kAccept, Math.floor((1 - maxScore) * (w + 1)) + 1);
        if (stats) stats.windowsScored++;
        const dist = levenshteinWithin(text.slice(start, e), exact, kDyn);
        if (dist > kDyn) continue; // provably can't reach threshold / tie the max
        const score = 1 - dist / Math.max(len, w);
        if (score > maxScore) {
          maxScore = score;
          bestStart = start;
          bestEnd = e;
          bestLenIdx = lenIdx;
        } else if (
          score === maxScore &&
          (start < bestStart || (start === bestStart && lenIdx < bestLenIdx))
        ) {
          // Same max score, earlier in the dense scan's traversal order.
          bestStart = start;
          bestEnd = e;
          bestLenIdx = lenIdx;
        }
        // (score === 1 is unreachable here: it requires dist 0 with len === w,
        // i.e. an exact occurrence — but fuzzyFind only runs when there are
        // no exact occurrences.)
      }
    }
  }
  if (bestStart === -1 || maxScore < threshold) return null;
  return { start: bestStart, end: bestEnd };
}

/** Resolve a text-quote anchor to a range, or null if no acceptable match. */
export function resolveAnchor(
  text: string,
  anchor: TextQuoteAnchor,
  opts: ResolveOptions = {},
): ResolvedRange | null {
  const hits = allIndexesOf(text, anchor.exact);
  if (hits.length === 1) {
    return { start: hits[0], end: hits[0] + anchor.exact.length };
  }
  if (hits.length > 1) {
    let best = hits[0];
    let bestScore = -1;
    for (const h of hits) {
      const score = contextScore(text, h, anchor.exact.length, anchor);
      if (score > bestScore) {
        bestScore = score;
        best = h;
      }
    }
    return { start: best, end: best + anchor.exact.length };
  }
  const threshold = opts.threshold ?? 0.7;
  return fuzzyFind(text, anchor.exact, threshold, opts.stats);
}
