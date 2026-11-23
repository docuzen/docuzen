// @vitest-environment happy-dom
//
// Behavioural tests for surface.ts — annotating and un-annotating either document surface,
// the annotation action menu, annotation undo, and what the HTML iframe's document is wired
// to do — driven through index.html's real markup, the real editor and a scripted sidecar
// (see surface-harness.test-support.ts).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NodeSelection, TextSelection } from "@milkdown/kit/prose/state";
import { deferred, mountSurface, settle, type MountedSurface } from "./surface-harness.test-support.js";

let h: MountedSurface;
const unhandled: unknown[] = [];
const onUnhandled = (e: unknown): void => void unhandled.push(e);

beforeEach(async () => {
  unhandled.length = 0;
  process.on("unhandledRejection", onUnhandled);
  h = await mountSurface();
});
afterEach(() => {
  h.surface.clearAnnotationUndo(); // earlier tests' surfaces stay subscribed to window keydown
  process.off("unhandledRejection", onUnhandled);
});

const anno = (id: string, exact: string, type: "highlight" | "comment" = "highlight", extra: Record<string, unknown> = {}) => ({
  id,
  type,
  anchor: { exact, prefix: "", suffix: "" },
  status: "open",
  thread: `threads/${id}.md`,
  session: `sessions/${id}.session.jsonl`,
  createdAt: "2026-01-01T00:00:00.000Z",
  ...extra,
});

function undoKey(target: EventTarget, init: KeyboardEventInit = {}): KeyboardEvent {
  const view = (target as Node).ownerDocument?.defaultView ?? window;
  const Ctor = (view as unknown as { KeyboardEvent: typeof KeyboardEvent }).KeyboardEvent;
  const e = new Ctor("keydown", { key: "z", metaKey: true, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(e);
  return e;
}

function click(target: Element, init: MouseEventInit = {}, type = "click"): MouseEvent {
  const view = target.ownerDocument.defaultView as unknown as { MouseEvent: typeof MouseEvent };
  const e = new view.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...init });
  target.dispatchEvent(e);
  return e;
}

function selectWord(word: string): void {
  const at = h.ed.posOf(word);
  h.ed.select(at, at + word.length);
}

/** Select `text` (inside one text node) in an iframe document. */
function selectInFrame(doc: Document, text: string): void {
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const at = (n.nodeValue ?? "").indexOf(text);
    if (at === -1) continue;
    const r = doc.createRange();
    r.setStart(n, at);
    r.setEnd(n, at + text.length);
    const sel = doc.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(r);
    return;
  }
  throw new Error(`"${text}" not in the frame`);
}

describe("annotating markdown across the save round-trip", () => {
  it("does not crash or leave an invisible annotation when the selected text is deleted meanwhile", async () => {
    h.ed.setMarkdown("hello world\n\nsecond paragraph here\n");
    selectWord("paragraph");
    const created = deferred<{ id: string; author: string }>();
    h.api.createAnnotation.mockReturnValueOnce(created.promise);
    h.popoverButton(".swatch").click();
    const v = h.ed.view();
    v.dispatch(v.state.tr.delete(h.ed.posOf("second"), v.state.doc.content.size - 1));
    created.resolve({ id: "c0001", author: "you" });
    await settle();

    expect(unhandled).toEqual([]);
    expect(h.annoIds()).not.toContain("c0001");
    expect(h.api.deleteAnnotation).toHaveBeenCalledWith({ id: "c0001", docPath: "/d/a.md" });
  });

  it("marks the selected text where it is now when an edit moved it", async () => {
    h.ed.setMarkdown("hello world\n");
    selectWord("world");
    const created = deferred<{ id: string; author: string }>();
    h.api.createAnnotation.mockReturnValueOnce(created.promise);
    h.popoverButton(".swatch").click();
    const v = h.ed.view();
    v.dispatch(v.state.tr.insertText("brave new ", h.ed.posOf("hello")));
    created.resolve({ id: "c0001", author: "you" });
    await settle();

    const deco = h.ed.view().state.plugins
      .map((p) => p.getState(h.ed.view().state))
      .flatMap((s) => (s && typeof s === "object" && "find" in s ? (s as { find(): { from: number; to: number; spec: { id?: string } }[] }).find() : []))
      .find((d) => d.spec.id === "c0001" && d.from < d.to)!;
    expect(h.ed.view().state.doc.textBetween(deco.from, deco.to)).toBe("world");
  });

  it("leaves the newly active document alone when the user switched tabs meanwhile", async () => {
    h.ed.setMarkdown("hello world in doc a\n");
    selectWord("world");
    const created = deferred<{ id: string; author: string }>();
    h.api.createAnnotation.mockReturnValueOnce(created.promise);
    h.popoverButton(".popcomment").click();
    h.showMarkdown("/d/b.md", "world of doc b\n");
    created.resolve({ id: "c0001", author: "you" });
    await settle();

    expect(unhandled).toEqual([]);
    expect(h.annoIds()).toEqual([]);
    expect(h.deps.addCommentCard).not.toHaveBeenCalled();
    expect(h.deps.focusCommentInput).not.toHaveBeenCalled();
    // ...and the annotation (kept on doc a) is not on doc b's undo stack either.
    undoKey(h.ed.view().dom);
    await settle();
    expect(h.api.deleteAnnotation).not.toHaveBeenCalled();
  });

  it("does not save an annotation on a selection with no text (an image)", async () => {
    h.ed.setMarkdown("![diagram](x.png)\n\nafter\n");
    let imagePos = -1;
    h.ed.view().state.doc.descendants((n, pos) => {
      if (n.type.name === "image") imagePos = pos;
    });
    const v = h.ed.view();
    v.dispatch(v.state.tr.setSelection(NodeSelection.create(v.state.doc, imagePos)));
    h.popoverButton(".popcomment").click();
    await settle();

    expect(h.api.createAnnotation).not.toHaveBeenCalled();
  });

  it("does not save an annotation on a horizontal rule", async () => {
    h.ed.setMarkdown("before\n\n---\n\nafter\n");
    let hrPos = -1;
    h.ed.view().state.doc.descendants((n, pos) => {
      if (n.type.name === "hr") hrPos = pos;
    });
    const v = h.ed.view();
    v.dispatch(v.state.tr.setSelection(NodeSelection.create(v.state.doc, hrPos)));
    h.popoverButton(".swatch").click();
    await settle();

    expect(h.api.createAnnotation).not.toHaveBeenCalled();
  });

  it("keeps a comment on a whole paragraph (triple-click) inside that paragraph", async () => {
    h.ed.setMarkdown("first para\n\nsecond para\n");
    const v = h.ed.view();
    // A triple-click selection runs to the start of the next paragraph.
    v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, h.ed.posOf("first"), h.ed.posOf("second"))));
    h.popoverButton(".popcomment").click();
    await settle();

    const badge = h.ed.view().dom.querySelector(".had-badge")!;
    expect(badge.parentElement?.closest("p")?.textContent).toContain("first para");
  });
});

describe("removing an annotation across the delete round-trip", () => {
  it("does not strip the same id from another document opened meanwhile", async () => {
    h.ed.setMarkdown("hello world\n");
    h.ed.renderLoaded([anno("c0001", "world")] as never);
    const deleted = deferred<{ ok: boolean }>();
    h.api.deleteAnnotation.mockReturnValueOnce(deleted.promise);
    const removal = h.surface.removeAnnotationById("c0001");
    h.showMarkdown("/d/b.md", "another world\n");
    h.ed.renderLoaded([anno("c0001", "another")] as never);
    deleted.resolve({ ok: true });
    await removal;

    expect(h.annoIds()).toContain("c0001");
    expect(h.deps.removeCommentEntry).not.toHaveBeenCalled();
  });

  it("still removes it from the same document shown again meanwhile", async () => {
    h.ed.setMarkdown("hello world\n");
    h.ed.renderLoaded([anno("c0001", "world")] as never);
    const deleted = deferred<{ ok: boolean }>();
    h.api.deleteAnnotation.mockReturnValueOnce(deleted.promise);
    const removal = h.surface.removeAnnotationById("c0001");
    h.showMarkdown("/d/a.md", "hello world\n"); // reloaded, its annotations replayed
    h.ed.renderLoaded([anno("c0001", "world")] as never);
    deleted.resolve({ ok: true });
    await removal;

    expect(h.annoIds()).not.toContain("c0001");
    expect(h.deps.removeCommentEntry).toHaveBeenCalledWith("c0001");
  });
});

describe("annotating an HTML document across the save round-trip", () => {
  it("leaves the newly active document alone when the user switched tabs meanwhile", async () => {
    const a = h.showHtml("/d/a.html", "<p>shared words here</p>");
    selectInFrame(a, "words");
    const created = deferred<{ id: string; author: string }>();
    h.api.createAnnotation.mockReturnValueOnce(created.promise);
    h.popoverButton(".popcomment").click();
    const b = h.showHtml("/d/b.html", "<p>shared words there</p>");
    created.resolve({ id: "c0001", author: "you" });
    await settle();

    expect(b.querySelector("[data-anno]")).toBeNull();
    expect(a.querySelector("[data-anno]")).toBeNull();
    expect(h.deps.addCommentCard).not.toHaveBeenCalled();
  });

  it("does not decorate a reloaded copy of the same document", async () => {
    const a = h.showHtml("/d/a.html", "<p>shared words here</p>");
    selectInFrame(a, "words");
    const created = deferred<{ id: string; author: string }>();
    h.api.createAnnotation.mockReturnValueOnce(created.promise);
    h.popoverButton(".swatch").click();
    const reloaded = h.showHtml("/d/a.html", "<p>shared words here</p>");
    created.resolve({ id: "c0001", author: "you" });
    await settle();

    expect(reloaded.querySelectorAll("[data-anno]")).toHaveLength(0);
  });
});

describe("onHtmlReady", () => {
  it("renders a document's annotations once when the iframe reloads mid-fetch", async () => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    h.api.openDoc.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    h.showHtml("/d/a.html", "<p>hello world</p>");
    const ready1 = h.surface.onHtmlReady();
    const doc2 = h.showHtml("/d/a.html", "<p>hello world</p>");
    const ready2 = h.surface.onHtmlReady();
    const opened = { text: "", format: "html", annotations: [anno("c0001", "world", "comment")] };
    second.resolve(opened);
    await ready2;
    first.resolve(opened);
    await ready1;

    expect(doc2.querySelectorAll('[data-anno="c0001"]')).toHaveLength(1);
    expect(h.deps.addCommentCard).toHaveBeenCalledTimes(1);
    expect(h.api.listProposals).toHaveBeenCalledTimes(1);
  });

  it("forwards the sidebar shortcuts (⌘⇧L / ⌘⇧R) from the iframe to the app", async () => {
    const doc = h.showHtml("/d/a.html", "<p>hello</p>");
    await h.surface.onHtmlReady();
    const seen: string[] = [];
    const spy = (e: KeyboardEvent) => void (e.metaKey && e.shiftKey && seen.push(e.key));
    window.addEventListener("keydown", spy, true);
    for (const key of ["L", "R"]) {
      const e = undoKey(doc.body, { key, shiftKey: true });
      expect(e.defaultPrevented).toBe(true);
    }
    window.removeEventListener("keydown", spy, true);
    expect(seen).toEqual(["L", "R"]);
  });
});

describe("links in an HTML document under review", () => {
  async function annotatedLink(): Promise<Document> {
    const doc = h.showHtml("/d/a.html", '<p>see <a href="https://example.test/page">the spec</a> now</p>');
    h.api.openDoc.mockResolvedValueOnce({ text: "", format: "html", annotations: [anno("c0001", "the spec")] });
    await h.surface.onHtmlReady();
    return doc;
  }

  it("never lets a plain click on an annotated link navigate the frame", async () => {
    const doc = await annotatedLink();
    const span = doc.querySelector('[data-anno="c0001"]')!;
    expect(span.closest("a[href]")).not.toBeNull();
    const e = click(span);
    expect(e.defaultPrevented).toBe(true);
    expect(document.querySelector(".annomenu")).not.toBeNull(); // the annotation's menu, as before
    expect(h.deps.openLink).not.toHaveBeenCalled();
  });

  it("opens an annotated link on ⌘-click", async () => {
    const doc = await annotatedLink();
    const e = click(doc.querySelector('[data-anno="c0001"]')!, { metaKey: true });
    expect(e.defaultPrevented).toBe(true);
    expect(h.deps.openLink).toHaveBeenCalledWith("https://example.test/page", doc);
  });

  it("never lets a middle-click navigate the frame", async () => {
    const doc = h.showHtml("/d/a.html", '<p><a href="https://example.test/">x</a></p>');
    await h.surface.onHtmlReady();
    const link = doc.querySelector("a")!;
    expect(click(link, { button: 1 }, "auxclick").defaultPrevented).toBe(true);
    expect(click(link, { button: 1 }).defaultPrevented).toBe(true);
    expect(h.deps.openLink).not.toHaveBeenCalled();
  });
});

describe("annotation undo (⌘Z)", () => {
  async function highlightWorld(): Promise<void> {
    h.ed.setMarkdown("hello world\n");
    selectWord("world");
    h.popoverButton(".swatch").click();
    await settle();
    expect(h.annoIds()).toContain("c0001");
  }

  it("undoes the fresh highlight when pressed in the document", async () => {
    await highlightWorld();
    const e = undoKey(h.ed.view().dom);
    await settle();
    expect(e.defaultPrevented).toBe(true);
    expect(h.api.deleteAnnotation).toHaveBeenCalledWith({ id: "c0001" });
    expect(h.annoIds()).not.toContain("c0001");
  });

  it("is a text field's own undo in any input, textarea, select or editable outside the document", async () => {
    await highlightWorld();
    const editable = document.createElement("div");
    editable.setAttribute("contenteditable", "true");
    document.body.appendChild(editable);
    const select = document.createElement("select");
    document.body.appendChild(select);
    for (const target of [
      document.querySelector("#chatInput")!,
      document.querySelector("#searchInput")!,
      document.querySelector("#reviewRubric")!,
      select,
      editable,
    ]) {
      const e = undoKey(target);
      expect(e.defaultPrevented).toBe(false);
    }
    await settle();
    expect(h.api.deleteAnnotation).not.toHaveBeenCalled();
    expect(h.annoIds()).toContain("c0001");
  });

  it("forgets an annotation removed some other way", async () => {
    await highlightWorld();
    await h.surface.removeAnnotationById("c0001");
    expect(h.api.deleteAnnotation).toHaveBeenCalledTimes(1);
    const e = undoKey(h.ed.view().dom);
    await settle();
    expect(e.defaultPrevented).toBe(false);
    expect(h.api.deleteAnnotation).toHaveBeenCalledTimes(1);
  });

  it("in an HTML document: a form field keeps its own undo, the page itself undoes the annotation", async () => {
    const doc = h.showHtml("/d/a.html", "<p>hello world</p><input id=q>");
    await h.surface.onHtmlReady();
    selectInFrame(doc, "world");
    h.popoverButton(".swatch").click();
    await settle();
    expect(doc.querySelector('[data-anno="c0001"]')).not.toBeNull();

    expect(undoKey(doc.querySelector("#q")!).defaultPrevented).toBe(false);
    await settle();
    expect(h.api.deleteAnnotation).not.toHaveBeenCalled();

    expect(undoKey(doc.body).defaultPrevented).toBe(true);
    await settle();
    expect(doc.querySelector('[data-anno="c0001"]')).toBeNull();
  });
});

describe("annotation menu and popover", () => {
  it("keeps the annotation menu inside the window near its bottom-right corner", async () => {
    h.ed.setMarkdown("hello world\n");
    h.ed.renderLoaded([anno("c0001", "world")] as never);
    const mark = h.ed.view().dom.querySelector<HTMLElement>('.had-mark[data-anno="c0001"]')!;
    const rect = { left: window.innerWidth - 20, right: window.innerWidth - 2, top: window.innerHeight - 18, bottom: window.innerHeight - 2, width: 18, height: 16, x: 0, y: 0 };
    vi.spyOn(mark, "getBoundingClientRect").mockReturnValue({ ...rect, toJSON: () => rect } as DOMRect);
    const width = vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(160);
    const height = vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(40);
    try {
      click(mark);
      const menu = document.querySelector<HTMLElement>(".annomenu")!;
      expect(parseFloat(menu.style.left) + 160).toBeLessThanOrEqual(window.innerWidth - 8);
      expect(parseFloat(menu.style.top) + 40).toBeLessThanOrEqual(window.innerHeight - 8);
      expect(parseFloat(menu.style.top) + 40).toBeLessThanOrEqual(rect.top); // flipped above the mark
    } finally {
      width.mockRestore();
      height.mockRestore();
    }
  });

  it("drops the selection popover and the annotation menu when the document changes", async () => {
    h.ed.setMarkdown("hello world\n");
    h.ed.renderLoaded([anno("c0001", "world")] as never);
    click(h.ed.view().dom.querySelector('.had-mark[data-anno="c0001"]')!);
    expect(document.querySelector(".annomenu")).not.toBeNull();
    const popover = document.querySelector<HTMLElement>("#popover")!;
    popover.hidden = false;

    h.showHtml("/d/b.html", "<p>other</p>");
    expect(popover.hidden).toBe(true);
    expect(document.querySelector(".annomenu")).toBeNull();
  });

  it("does not annotate the previous document's remembered selection", async () => {
    const a = h.showHtml("/d/a.html", "<p>alpha words</p>");
    selectInFrame(a, "words");
    h.surface.updateHtmlPopover(); // remembers the selection for the popover's buttons
    h.showHtml("/d/a.html", "<p>alpha words</p>"); // reloaded: a new document, nothing selected
    h.popoverButton(".swatch").click();
    await settle();
    expect(h.api.createAnnotation).not.toHaveBeenCalled();
  });
});
