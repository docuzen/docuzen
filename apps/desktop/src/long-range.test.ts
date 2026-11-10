// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { serializeDocument } from "./html-surface.js";
import { unwrapAnno } from "./html-projection.js";
import { RANGE_ATTR, RANGE_FOCUS_ATTR, clearRangeBlocks, focusRangeBlocks, isLongRange, markRangeBlocks } from "./long-range.js";

function docWith(body: string): Document {
  const d = document.implementation.createHTMLDocument("t");
  d.body.innerHTML = body;
  return d;
}

describe("long comment ranges", () => {
  it("a few words or one short paragraph is not long; three blocks or a very long passage is", () => {
    expect(isLongRange(40, 1)).toBe(false);
    expect(isLongRange(500, 2)).toBe(false);
    expect(isLongRange(60, 3)).toBe(true);
    expect(isLongRange(900, 1)).toBe(true);
  });

  it("marks blocks with one attribute, and neither the mark nor its colours are saved", () => {
    const d = docWith('<p class="lead">a</p><p>b</p><p>c</p>');
    const blocks = [...d.body.children];
    markRangeBlocks(d, blocks, "c0001", "#f06292");
    focusRangeBlocks(d, "c0001");
    expect(blocks.every((b) => b.getAttribute(RANGE_ATTR) === "c0001" && b.hasAttribute(RANGE_FOCUS_ATTR))).toBe(true);
    expect(d.querySelector("style[data-had-range-style]")!.textContent).toContain("#f06292");

    const saved = serializeDocument(d);
    expect(saved).not.toContain("data-had-range");
    expect(saved).not.toContain("f06292");
    expect(saved).toContain('<p class="lead">a</p><p>b</p><p>c</p>');
    // Saving works on a copy: the live document keeps its bars.
    expect(blocks[0].hasAttribute(RANGE_ATTR)).toBe(true);
  });

  it("two long comments over the same blocks: deleting one keeps the other's bar", () => {
    const d = docWith("<p>a</p><p>b</p><p>c</p>");
    const blocks = [...d.body.children];
    markRangeBlocks(d, blocks, "c0001", "#111");
    markRangeBlocks(d, blocks.slice(1), "c0002", "#222");
    focusRangeBlocks(d, "c0002");
    expect(blocks[0].hasAttribute(RANGE_FOCUS_ATTR)).toBe(false);

    unwrapAnno(d, "c0002");
    expect(blocks.map((b) => b.getAttribute(RANGE_ATTR))).toEqual(["c0001", "c0001", "c0001"]);
    expect(d.querySelectorAll(`[${RANGE_FOCUS_ATTR}]`).length).toBe(0);
    expect(d.querySelector('style[data-had-range-style="c0002"]')).toBeNull();
    clearRangeBlocks(d, "c0001");
    expect(d.querySelectorAll(`[${RANGE_ATTR}]`).length).toBe(0);
  });
});
