import { describe, expect, it } from "vitest";
import { annotationIdAtPos, directiveOrdinalAtPos } from "./click-jump.js";

describe("annotationIdAtPos", () => {
  it("returns the id of the range containing pos", () => {
    const ranges = [
      { from: 5, to: 10, id: "anno-a" },
      { from: 20, to: 25, id: "anno-b" },
    ];
    expect(annotationIdAtPos(ranges, 7)).toBe("anno-a");
    expect(annotationIdAtPos(ranges, 22)).toBe("anno-b");
  });

  it("is inclusive of both range boundaries, matching DecorationSet.find(pos, pos)", () => {
    const ranges = [{ from: 5, to: 10, id: "anno-a" }];
    expect(annotationIdAtPos(ranges, 5)).toBe("anno-a");
    expect(annotationIdAtPos(ranges, 10)).toBe("anno-a");
  });

  it("returns undefined when pos falls outside every range", () => {
    const ranges = [{ from: 5, to: 10, id: "anno-a" }];
    expect(annotationIdAtPos(ranges, 4)).toBeUndefined();
    expect(annotationIdAtPos(ranges, 11)).toBeUndefined();
    expect(annotationIdAtPos([], 5)).toBeUndefined();
  });

  it("picks the first matching range when annotations overlap", () => {
    const ranges = [
      { from: 5, to: 15, id: "outer" },
      { from: 8, to: 10, id: "inner" },
    ];
    expect(annotationIdAtPos(ranges, 9)).toBe("outer");
  });
});

describe("directiveOrdinalAtPos", () => {
  it("returns the 1-based document-order ordinal of the containing range", () => {
    const ranges = [
      { from: 0, to: 5 },
      { from: 10, to: 15 },
      { from: 20, to: 25 },
    ];
    expect(directiveOrdinalAtPos(ranges, 2)).toBe(1);
    expect(directiveOrdinalAtPos(ranges, 12)).toBe(2);
    expect(directiveOrdinalAtPos(ranges, 22)).toBe(3);
  });

  it("is inclusive of both range boundaries", () => {
    const ranges = [{ from: 10, to: 15 }];
    expect(directiveOrdinalAtPos(ranges, 10)).toBe(1);
    expect(directiveOrdinalAtPos(ranges, 15)).toBe(1);
  });

  it("returns undefined when pos falls between directives or the list is empty", () => {
    const ranges = [
      { from: 0, to: 5 },
      { from: 10, to: 15 },
    ];
    expect(directiveOrdinalAtPos(ranges, 7)).toBeUndefined();
    expect(directiveOrdinalAtPos([], 0)).toBeUndefined();
  });
});
