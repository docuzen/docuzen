import { describe, expect, it } from "vitest";
import { EXCERPT_MAX, excerpt } from "./excerpt.js";

describe("excerpt", () => {
  it("leaves short text alone, collapsing whitespace", () => {
    expect(excerpt("  Limits are\n\nstored   in Redis. ")).toBe("Limits are stored in Redis.");
  });

  it("shows the opening and closing words of long text, cut at word boundaries", () => {
    const words = Array.from({ length: 400 }, (_, i) => `word${i}`).join(" ");
    const out = excerpt(words);
    expect(out.length).toBeLessThanOrEqual(EXCERPT_MAX);
    expect(out.startsWith("word0 word1 ")).toBe(true);
    expect(out.endsWith(" word398 word399")).toBe(true);
    const [head, tail] = out.split(" … ");
    expect(words.startsWith(head + " ")).toBe(true);
    expect(words.endsWith(" " + tail)).toBe(true);
  });

  it("hard-cuts text with no spaces (minified JSON, long URLs)", () => {
    const out = excerpt("x".repeat(5000));
    expect(out.length).toBeLessThanOrEqual(EXCERPT_MAX);
    expect(out).toContain(" … ");
  });
});
