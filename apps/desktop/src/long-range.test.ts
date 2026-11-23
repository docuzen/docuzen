// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { serializeDocument } from "./html-surface.js";
import { unwrapAnno } from "./html-projection.js";
import { RANGE_ATTR, RANGE_FOCUS_ATTR, blocksInRange, clearRangeBlocks, focusRangeBlocks, isLongRange, markRangeBlocks } from "./long-range.js";

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

describe("the blocks a comment covers", () => {
  /** A range over the text of `doc`'s body from the first match of `from` to the end of the first match of `to`. */
  function rangeOver(from: string, to: string): Range {
    const texts: Text[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) texts.push(n as Text);
    const start = texts.find((t) => t.data.includes(from))!;
    const end = texts.find((t) => t.data.includes(to))!;
    const r = document.createRange();
    r.setStart(start, start.data.indexOf(from));
    r.setEnd(end, end.data.indexOf(to) + to.length);
    return r;
  }

  it("a short paragraph with links, code and emphasis is one block, and its inline elements get no bar", () => {
    document.body.innerHTML = "<p id=\"p\">Run <code>make</code>, then <strong>check</strong> the <a href=\"#x\">log</a> and <em>stop</em>.</p>";
    const blocks = blocksInRange(rangeOver("Run", "stop"));
    expect(blocks.map((b) => b.id)).toEqual(["p"]);
    expect(isLongRange(40, blocks.length)).toBe(false);
  });

  it("a very long single paragraph with a line break is that paragraph, so its bar is drawn", () => {
    const long = "word ".repeat(200);
    document.body.innerHTML = `<p id="p">${long}<br>${long}<img src="a.png"> <b>end</b></p>`;
    expect(blocksInRange(rangeOver("word", "end")).map((b) => b.id)).toEqual(["p"]);
  });

  it("a passage over several paragraphs is each of those paragraphs, not their inline children", () => {
    document.body.innerHTML = '<div><p id="a">One <b>bold</b></p><p id="b">Two <i>it</i> <code>c</code></p><p id="c">Three</p><p id="d">Four</p></div>';
    expect(blocksInRange(rangeOver("One", "Three")).map((b) => b.id)).toEqual(["a", "b", "c"]);
  });

  it("inside one list item, the item is the block", () => {
    document.body.innerHTML = '<ul><li id="i1">first <b>a</b> <i>b</i> <code>c</code> end</li><li id="i2">second</li></ul>';
    expect(blocksInRange(rangeOver("first", "end")).map((b) => b.id)).toEqual(["i1"]);
    expect(blocksInRange(rangeOver("first", "second")).map((b) => b.id)).toEqual(["i1", "i2"]);
  });
});
