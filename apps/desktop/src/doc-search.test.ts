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
