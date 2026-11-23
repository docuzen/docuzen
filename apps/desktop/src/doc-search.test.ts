import { describe, expect, it } from "vitest";
import { findTextMatches, nextSearchIndex } from "./doc-search.js";

describe("document search helpers", () => {
  it("finds non-overlapping case-insensitive matches with source offsets", () => {
    expect(findTextMatches("Alpha beta alpha ALPHA", "alpha")).toEqual([
      { start: 0, end: 5 },
      { start: 11, end: 16 },
      { start: 17, end: 22 },
    ]);
  });

  it("reports offsets into the original text after a character whose lowercase is longer", () => {
    // "İ" lowercases to "i" + a combining dot: two code units for one.
    const text = "İstanbul and istanbul";
    const matches = findTextMatches(text, "stan");
    expect(matches).toEqual([
      { start: 1, end: 5 },
      { start: 14, end: 18 },
    ]);
    for (const m of matches) expect(text.slice(m.start, m.end)).toBe("stan");
  });

  it("covers the whole original character when a match ends inside its lowercase form", () => {
    expect(findTextMatches("xİy", "xi")).toEqual([{ start: 0, end: 2 }]);
    expect(findTextMatches("İİ", "İ")).toEqual([
      { start: 0, end: 1 },
      { start: 1, end: 2 },
    ]);
  });

  it("ignores blank queries", () => {
    expect(findTextMatches("anything", "   ")).toEqual([]);
  });

  it("wraps previous and next navigation through the result list", () => {
    expect(nextSearchIndex(-1, 3, 1)).toBe(0);
    expect(nextSearchIndex(2, 3, 1)).toBe(0);
    expect(nextSearchIndex(0, 3, -1)).toBe(2);
    expect(nextSearchIndex(0, 0, 1)).toBe(-1);
  });
});
