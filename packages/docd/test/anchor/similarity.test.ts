import { describe, it, expect } from "vitest";
import { levenshtein, similarity } from "../../src/anchor/similarity.js";

describe("levenshtein", () => {
  it("is 0 for identical strings", () => {
    expect(levenshtein("abc", "abc")).toBe(0);
  });
  it("counts single substitution", () => {
    expect(levenshtein("abc", "abd")).toBe(1);
  });
  it("counts insertion and deletion", () => {
    expect(levenshtein("abc", "ab")).toBe(1);
    expect(levenshtein("ab", "abc")).toBe(1);
  });
  it("handles empty strings", () => {
    expect(levenshtein("", "abc")).toBe(3);
    expect(levenshtein("", "")).toBe(0);
  });
});

describe("similarity", () => {
  it("is 1 for identical strings", () => {
    expect(similarity("hello", "hello")).toBe(1);
  });
  it("is 1 for two empty strings", () => {
    expect(similarity("", "")).toBe(1);
  });
  it("is between 0 and 1 for partial matches", () => {
    const s = similarity("kitten", "sitting");
    expect(s).toBeGreaterThan(0);
    expect(s).toBeLessThan(1);
  });
});
