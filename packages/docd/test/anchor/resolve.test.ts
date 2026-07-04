import { describe, it, expect } from "vitest";
import { resolveAnchor } from "../../src/anchor/resolve.js";
import { createAnchor } from "../../src/anchor/create.js";

const TEXT = "Alpha beta gamma delta epsilon.";

describe("resolveAnchor — unique exact", () => {
  it("resolves an unambiguous exact match to its range", () => {
    const anchor = { exact: "gamma", prefix: "beta ", suffix: " delta" };
    const r = resolveAnchor(TEXT, anchor);
    expect(r).toEqual({ start: 11, end: 16 });
    expect(TEXT.slice(r!.start, r!.end)).toBe("gamma");
  });

  it("round-trips with createAnchor", () => {
    const start = TEXT.indexOf("delta");
    const anchor = createAnchor(TEXT, start, start + 5);
    const r = resolveAnchor(TEXT, anchor);
    expect(r).toEqual({ start, end: start + 5 });
  });
});

describe("resolveAnchor — duplicate exact disambiguated by context", () => {
  const DUP = "set the value. set the value. done.";
  it("picks the occurrence whose prefix/suffix best match", () => {
    // second "set the value" — preceded by "value. ", followed by ". done"
    const anchor = { exact: "set the value", prefix: "value. ", suffix: ". done" };
    const r = resolveAnchor(DUP, anchor);
    expect(r).toEqual({ start: 15, end: 28 });
  });

  it("picks the first occurrence when its context matches better", () => {
    const anchor = { exact: "set the value", prefix: "", suffix: ". set" };
    const r = resolveAnchor(DUP, anchor);
    expect(r).toEqual({ start: 0, end: 13 });
  });
});

describe("resolveAnchor — fuzzy fallback", () => {
  it("matches when the exact text was lightly edited", () => {
    const text = "Limits are stored in Redis with a 1-hour TTL today.";
    // anchor.exact differs by one phrase ("will be" vs "are")
    const anchor = {
      exact: "Limits will be stored in Redis with a 1-hour TTL",
      prefix: "",
      suffix: " today",
    };
    const r = resolveAnchor(text, anchor, { threshold: 0.7 });
    expect(r).not.toBeNull();
    expect(text.slice(r!.start, r!.end)).toContain("Redis");
  });

  it("orphans (returns null) when the text changed too much", () => {
    const text = "Completely different sentence about cats.";
    const anchor = {
      exact: "Limits will be stored in Redis with a 1-hour TTL",
      prefix: "",
      suffix: "",
    };
    expect(resolveAnchor(text, anchor, { threshold: 0.7 })).toBeNull();
  });
});
