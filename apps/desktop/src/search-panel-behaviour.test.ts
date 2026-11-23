// @vitest-environment happy-dom
//
// The in-document search panel (search-panel.ts) on index.html's markup, the real editor
// and a stand-in HTML iframe document (see surface-harness.test-support.ts).
import { beforeEach, describe, expect, it } from "vitest";
import { mountSurface, type MountedSurface } from "./surface-harness.test-support.js";

let h: MountedSurface;
beforeEach(async () => {
  h = await mountSurface();
});

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const count = () => $("#searchCount").textContent;

function search(query: string): void {
  $("#searchBtn").click();
  const input = $<HTMLInputElement>("#searchInput");
  input.value = query;
  input.dispatchEvent(new Event("input"));
}
const next = () => $("#searchNext").click();

/** The caret's position as an offset into the text of `doc`'s body. */
function caretOffset(doc: Document): number {
  const sel = doc.getSelection()!;
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  let at = 0;
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n === sel.anchorNode) return at + sel.anchorOffset;
    at += (n.nodeValue ?? "").length;
  }
  throw new Error("caret is not in a text node of the document");
}

describe("search results follow the document on screen", () => {
  it("forgets the count and the current match when highlights are cleared (last tab closed)", () => {
    h.ed.setMarkdown("foo bar foo baz foo\n");
    search("foo");
    next();
    next();
    expect(count()).toBe("3 / 3");

    h.search.clearSearchHighlights(); // shell.ts's empty state
    expect(count()).not.toBe("3 / 3");
    expect(h.search.searchState.activeIndex).toBe(-1);
    expect(h.search.searchState.matches).toEqual([]);
  });

  it("starts at the first match in a newly shown document", () => {
    h.ed.setMarkdown("foo bar foo baz foo\n");
    search("foo");
    next();
    next();
    expect(count()).toBe("3 / 3");

    // shell.ts's activateTab: clear, show the other document, refresh the open search.
    h.search.clearSearchHighlights();
    h.ed.setMarkdown("foo foo foo foo foo\n");
    h.search.refreshMarkdownSearch(false, false);
    expect(count()).toBe("1 / 5");
  });
});

describe("refreshing HTML matches while editing", () => {
  it("keeps the caret where it was, even inside a match", () => {
    h.state.format = "html";
    const doc = h.showHtml("/d/a.html", "<p>foo bar foo</p><p>more foo text</p>");
    search("foo");
    expect(doc.querySelectorAll("[data-had-search]")).toHaveLength(3);

    // Caret inside the second "foo" ("fo|o"), as if the user were typing there.
    const second = doc.querySelectorAll("[data-had-search]")[1].firstChild!;
    const sel = doc.getSelection()!;
    sel.removeAllRanges();
    const r = doc.createRange();
    r.setStart(second, 2);
    r.collapse(true);
    sel.addRange(r);
    const before = caretOffset(doc);

    h.search.refreshHtmlSearch(false, false); // what an edit in the iframe triggers
    expect(doc.querySelectorAll("[data-had-search]")).toHaveLength(3);
    expect(sel.anchorNode?.isConnected).toBe(true);
    expect(caretOffset(doc)).toBe(before);
  });

  it("keeps a selection across the refresh", () => {
    h.state.format = "html";
    const doc = h.showHtml("/d/a.html", "<p>foo bar foo</p>");
    search("foo");
    const sel = doc.getSelection()!;
    const first = doc.querySelector("[data-had-search]")!.firstChild!;
    const last = doc.querySelectorAll("[data-had-search]")[1].firstChild!;
    sel.setBaseAndExtent(first, 1, last, 2);
    const text = sel.toString();

    h.search.refreshHtmlSearch(false, false);
    expect(sel.toString()).toBe(text);
  });
});
