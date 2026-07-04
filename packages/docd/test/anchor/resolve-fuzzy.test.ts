// Regression guards for the fuzzy-scan rewrite (perf: anchor resolution).
//
// The original fuzzyFind ran a full Levenshtein DP at every character offset
// of the document — O(docLen * needleLen^2) — which froze the desktop UI for
// tens of seconds resolving a single stale annotation anchor on a 100KB+ doc.
// The rewrite (Sellers lower-bound
// pass + bucket-ordered banded verification) must:
//
//   1. return EXACTLY what the dense scan returned, on any input — verified
//      here against a verbatim copy of the old algorithm over seeded random
//      corpora, including tie-prone repetitive ones;
//   2. do work proportional to the near-match regions, not the document —
//      verified with the operation-counting `stats` seam (no wall-clock
//      assertions; counts are deterministic and cannot flake).

import { describe, it, expect } from "vitest";
import { resolveAnchor, type ResolveStats } from "../../src/anchor/resolve.js";
import { levenshtein } from "../../src/anchor/similarity.js";

// --- verbatim reference: the pre-rewrite dense fuzzy scan -------------------
function similarityRef(a: string, b: string): number {
  if (a.length === 0 && b.length === 0) return 1;
  return 1 - levenshtein(a, b) / Math.max(a.length, b.length);
}
function fuzzyFindRef(
  text: string,
  exact: string,
  threshold: number,
): { start: number; end: number } | null {
  const w = exact.length;
  if (w === 0 || text.length === 0) return null;
  let bestStart = -1;
  let bestEnd = -1;
  let bestScore = -1;
  for (let start = 0; start < text.length; start++) {
    for (const len of [w, w - 1, w + 1]) {
      if (len <= 0 || start + len > text.length) continue;
      const candidate = text.slice(start, start + len);
      const score = similarityRef(candidate, exact);
      if (score > bestScore) {
        bestScore = score;
        bestStart = start;
        bestEnd = start + len;
        if (score === 1) return { start: bestStart, end: bestEnd };
      }
    }
  }
  if (bestStart === -1 || bestScore < threshold) return null;
  return { start: bestStart, end: bestEnd };
}

// --- deterministic corpus helpers (no Math.random — seeded LCG) -------------
function makeRng(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}
const WORDS = (
  "the gateway consults token bucket before admitting request and decrements " +
  "counter atomically so concurrent replicas never double admit while shard " +
  "drains journal segment replay window quorum lease"
).split(" ");
function prose(rnd: () => number, words: number): string {
  const out: string[] = [];
  for (let i = 0; i < words; i++) out.push(WORDS[Math.floor(rnd() * WORDS.length)]);
  return out.join(" ");
}
/** Perturb ~`rate` of characters with a mix of deletes/inserts/substitutions. */
function perturb(rnd: () => number, s: string, rate: number): string {
  const out: string[] = [];
  for (const c of s) {
    const r = rnd();
    if (r < rate / 3) continue;
    if (r < (2 * rate) / 3) {
      out.push(c, "x");
      continue;
    }
    if (r < rate) {
      out.push("q");
      continue;
    }
    out.push(c);
  }
  return out.join("");
}

describe("fuzzy scan — exact equivalence with the pre-rewrite dense scan", () => {
  it("returns identical ranges (or null) across seeded random corpora", () => {
    const rnd = makeRng(42);
    let fuzzyCases = 0;
    for (let t = 0; t < 30; t++) {
      // Small texts keep the O(n * w^2) REFERENCE affordable; the rewrite's
      // large-input behavior is covered by the complexity guards below.
      const text = prose(rnd, 150 + Math.floor(rnd() * 120));
      const start = Math.floor(rnd() * (text.length - 140));
      const len = 20 + Math.floor(rnd() * 80);
      const rate = [0, 0.05, 0.1, 0.2, 0.35, 0.5][t % 6];
      const exact = perturb(rnd, text.slice(start, start + len), rate);
      if (exact.length === 0 || text.includes(exact)) continue; // exact path — trivially identical
      fuzzyCases++;
      const got = resolveAnchor(text, { exact, prefix: "", suffix: "" });
      const want = fuzzyFindRef(text, exact, 0.7);
      expect(got, `case ${t} (rate ${rate}, len ${len})`).toEqual(want);
    }
    expect(fuzzyCases).toBeGreaterThan(15); // the sweep actually exercised the fuzzy path
  });

  it("returns identical ranges on a tie-prone repetitive corpus", () => {
    // Every sentence is a near-duplicate — the worst case for tie-breaking:
    // many windows share the global max score and the FIRST one (dense scan
    // traversal order) must win.
    const rnd = makeRng(7);
    const sentence = "the gateway consults the token bucket before admitting a request. ";
    for (let t = 0; t < 6; t++) {
      const text = sentence.repeat(18);
      const at = Math.floor(rnd() * (text.length - 80));
      const exact = perturb(rnd, text.slice(at, at + 40 + Math.floor(rnd() * 25)), 0.15);
      if (exact.length === 0 || text.includes(exact)) continue;
      const got = resolveAnchor(text, { exact, prefix: "", suffix: "" });
      const want = fuzzyFindRef(text, exact, 0.7);
      expect(got, `tie case ${t}`).toEqual(want);
    }
  });

  it("honors a custom threshold identically", () => {
    const rnd = makeRng(99);
    const text = prose(rnd, 250);
    const exact = perturb(rnd, text.slice(500, 580), 0.25);
    for (const threshold of [0.5, 0.7, 0.9]) {
      const got = resolveAnchor(text, { exact, prefix: "", suffix: "" }, { threshold });
      const want = text.includes(exact)
        ? { start: text.indexOf(exact), end: text.indexOf(exact) + exact.length }
        : fuzzyFindRef(text, exact, threshold);
      expect(got, `threshold ${threshold}`).toEqual(want);
    }
  });
});

describe("fuzzy scan — complexity guard (operation counts, not wall clock)", () => {
  // A ~130KB doc of varied prose, the shape that hung the UI. The dense scan
  // evaluated ~3 windows per character: ~390k DP evaluations of an
  // O(needleLen^2) DP each. The rewrite must keep DP evaluations proportional
  // to the near-match regions.
  function bigDoc(): string {
    const topics = [
      "rate limiter", "token bucket", "sliding window", "gateway shard", "consensus log",
      "replica set", "write-ahead journal", "backpressure valve", "circuit breaker",
      "quorum reader", "lease manager", "snapshot compactor", "gossip mesh", "retry budget",
    ];
    const verbs = [
      "admits", "throttles", "rebalances", "compacts", "replicates",
      "quarantines", "amortizes", "checkpoints", "hydrates", "escalates",
    ];
    let doc = "";
    for (let i = 0; i < 260; i++) {
      const t = topics[i % topics.length];
      const v = verbs[i % verbs.length];
      const t2 = topics[(i * 7 + 3) % topics.length];
      doc +=
        `Paragraph ${i}. The ${t} ${v} incoming work before the ${t2} observes it, ` +
        `so a burst that arrives during failover number ${i} never lands on a cold cache. ` +
        `Operationally this means shard ${i % 32} keeps its p99 under the budget while the ` +
        `${t2} drains, and the on-call runbook step ${i} stays a no-op unless the ${t} ` +
        `reports a saturation ratio above 0.${(i % 9) + 1}. When that happens the mesh ` +
        `pins the ${t} to its warm replica and replays journal segment ${i * 13} in order.\n\n`;
    }
    return doc;
  }

  it("scores zero windows for an orphan needle (nothing in the doc comes close)", () => {
    const doc = bigDoc();
    expect(doc.length).toBeGreaterThan(100_000);
    const exact =
      "curl -fsSL https://example.invalid/install.sh | sh -s -- --channel nightly --verify-signatures";
    const stats: ResolveStats = { windowsScored: 0 };
    const r = resolveAnchor(doc, { exact, prefix: "", suffix: "" }, { stats });
    expect(r).toBeNull();
    // The Sellers lower-bound pass alone proves no window can reach the
    // threshold — not a single edit-distance DP may run.
    expect(stats.windowsScored).toBe(0);
  });

  it("scores O(near-match region) windows for a stale needle, not O(docLen)", () => {
    const doc = bigDoc();
    // A ~200-char anchor whose passage was lightly rewritten (the persisted-
    // annotation-after-approved-edit scenario that froze the UI).
    const para = doc.slice(doc.indexOf("Paragraph 130."), doc.indexOf("Paragraph 131."));
    const words = para.slice(0, 230).split(" ");
    for (let i = 4; i < words.length; i += 9) words[i] = "reworked";
    const exact = words.join(" ").slice(0, 200);
    expect(doc.includes(exact)).toBe(false);
    const stats: ResolveStats = { windowsScored: 0 };
    const r = resolveAnchor(doc, { exact, prefix: "", suffix: "" }, { stats });
    expect(r).not.toBeNull();
    // It must find the rewritten passage (not some other paragraph) …
    expect(Math.abs(r!.start - doc.indexOf("Paragraph 130."))).toBeLessThan(50);
    // … and the dense scan would have evaluated ~3 windows per character
    // (~390k on this corpus). The current implementation scores ~800 (the
    // corpus's near-duplicate paragraphs are genuine candidates and must be
    // verified). docLen/40 (~3.2k) gives ~4x headroom over that without ever
    // letting an O(docLen) scan (120x the bound) back in. Counts are
    // deterministic for a fixed corpus — this cannot flake.
    expect(stats.windowsScored).toBeLessThan(doc.length / 40);
  });
});
