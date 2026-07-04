import { describe, it, expect } from "vitest";
import { diffToHunks } from "../../src/orchestrator/diff.js";

describe("diffToHunks", () => {
  it("returns no hunks for identical text", () => {
    expect(diffToHunks("a\nb\n", "a\nb\n")).toEqual([]);
  });
  it("captures a replaced line as one hunk", () => {
    const h = diffToHunks("a\nold line\nc\n", "a\nnew line\nc\n");
    expect(h).toHaveLength(1);
    expect(h[0].oldText).toContain("old line");
    expect(h[0].newText).toContain("new line");
  });
  it("captures a pure deletion (newText empty)", () => {
    const h = diffToHunks("a\ngone\nc\n", "a\nc\n");
    expect(h).toHaveLength(1);
    expect(h[0].oldText).toContain("gone");
    expect(h[0].newText).toBe("");
  });
  it("captures a pure insertion (oldText empty)", () => {
    const h = diffToHunks("a\nc\n", "a\nadded\nc\n");
    expect(h).toHaveLength(1);
    expect(h[0].oldText).toBe("");
    expect(h[0].newText).toContain("added");
  });
  it("separates two non-adjacent changes into two hunks", () => {
    const h = diffToHunks("a\nx\nb\ny\nc\n", "a\nX\nb\nY\nc\n");
    expect(h).toHaveLength(2);
  });
});
