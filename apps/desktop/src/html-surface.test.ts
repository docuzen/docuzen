// @vitest-environment happy-dom
//
// Behavioural tests of the HTML iframe surface itself: which document it reports while a load
// is in flight, when it counts the user's typing as an edit, what serialization keeps, and how
// relative links resolve. Iframe navigation is deferred to match a real browser (see
// iframe-navigation.test-support.ts).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HtmlSurface, baseHrefForDoc, serializeDocument } from "./html-surface.js";
import { insertDiagramIntoHtmlDoc } from "./html-diagram-insert.js";
import { deferIframeNavigation, type DeferredNavigation } from "./iframe-navigation.test-support.js";

let nav: DeferredNavigation;
let host: HTMLDivElement;
beforeEach(() => {
  document.body.innerHTML = '<div id="htmlHost"></div>';
  host = document.querySelector("#htmlHost")!;
  nav = deferIframeNavigation(host);
});
afterEach(() => nav.restore());

const frame = () => host.querySelector("iframe")!;
const A = "<!doctype html><html><head><title>A</title></head><body><p>alpha</p></body></html>";
const B = "<!doctype html><html><head><title>B</title></head><body><p>beta</p></body></html>";

/** Type into the (editable) iframe body the way the browser reports it: DOM change, then `input`. */
function typeInto(doc: Document, text: string): void {
  doc.body.querySelector("p")!.append(text);
  doc.body.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("which document the surface reports", () => {
  it("reports no document while a load is in flight, so nothing reads the previous tab's DOM", async () => {
    const onReady = vi.fn();
    const s = new HtmlSurface(host, { onReady });
    s.load(A, undefined, "/d/a.html");
    expect(s.doc).toBeNull(); // nothing committed yet
    await nav.commit();
    expect(s.doc?.body.textContent).toBe("alpha");
    expect(onReady).toHaveBeenCalledTimes(1);

    s.load(B, undefined, "/d/b.html");
    // The iframe still shows A until B commits; the surface must not hand A out as B.
    expect(frame().contentDocument?.body.textContent).toBe("alpha");
    expect(s.doc).toBeNull();
    expect(s.getHtml()).toBe("");
    await nav.commit();
    expect(s.doc?.body.textContent).toBe("beta");
  });

  it("an older load's onload cannot mark a newer load ready", async () => {
    const onReady = vi.fn();
    const s = new HtmlSurface(host, { onReady });
    s.load(A, undefined, "/d/a.html");
    const staleOnload = frame().onload!;
    s.load(B, undefined, "/d/b.html");
    await nav.commit(); // B commits; then the A load's handler runs late
    onReady.mockClear();
    staleOnload.call(frame(), new Event("load"));
    expect(onReady).not.toHaveBeenCalled();
    expect(s.doc?.body.textContent).toBe("beta");
  });
});

describe("edits", () => {
  it("reports edited HTML only for the document that was edited, and only once it is loaded", async () => {
    const s = new HtmlSurface(host);
    s.setEditable(true);
    s.load(A, undefined, "/d/a.html");
    expect(s.editedHtmlFor("/d/a.html")).toBeNull();
    await nav.commit();
    expect(s.editedHtmlFor("/d/a.html")).toBeNull(); // loaded, not edited
    typeInto(s.doc!, " typed");
    expect(s.editedHtmlFor("/d/a.html")).toContain("alpha typed"); // counted at once, not after the 200 ms debounce
    expect(s.editedHtmlFor("/d/b.html")).toBeNull();
    s.load(B, undefined, "/d/b.html");
    expect(s.editedHtmlFor("/d/a.html")).toBeNull(); // the iframe no longer holds A as a loaded doc
  });

  it("in review mode, typing into the page's own form fields is not a document edit", async () => {
    const onEdit = vi.fn();
    const s = new HtmlSurface(host, { onEdit });
    s.load(A, undefined, "/d/a.html");
    await nav.commit();
    typeInto(s.doc!, " script output");
    await new Promise((r) => setTimeout(r, 250));
    expect(s.editedHtmlFor("/d/a.html")).toBeNull();
    expect(onEdit).not.toHaveBeenCalled();
  });

  it("a load cancels the previous document's pending edit callback (no stray dirty mark on the next tab)", async () => {
    const onEdit = vi.fn();
    const s = new HtmlSurface(host, { onEdit });
    s.setEditable(true);
    s.load(A, undefined, "/d/a.html");
    await nav.commit();
    typeInto(s.doc!, " typed");
    s.load(B, undefined, "/d/b.html"); // within the 200 ms debounce
    await nav.commit();
    await new Promise((r) => setTimeout(r, 250));
    expect(onEdit).not.toHaveBeenCalled();
    expect(s.editedHtmlFor("/d/b.html")).toBeNull();
  });

  it("markEdited counts an edit made without an input event (an inserted image) for the loaded document only", async () => {
    const s = new HtmlSurface(host);
    s.load(A, undefined, "/d/a.html");
    await nav.commit();
    s.markEdited("/d/b.html");
    expect(s.editedHtmlFor("/d/a.html")).toBeNull();
    s.markEdited("/d/a.html");
    expect(s.editedHtmlFor("/d/a.html")).toContain("alpha");
  });
});

describe("unload", () => {
  it("stops the document (scripts, timers) and reports nothing until the next load", async () => {
    const onReady = vi.fn();
    const s = new HtmlSurface(host, { onReady });
    s.setEditable(true);
    s.load(A, undefined, "/d/a.html");
    await nav.commit();
    typeInto(s.doc!, " typed");
    onReady.mockClear();
    s.unload();
    await nav.commit();
    expect(frame().contentDocument?.body?.textContent ?? "").toBe("");
    expect(s.doc).toBeNull();
    expect(s.editedHtmlFor("/d/a.html")).toBeNull();
    expect(onReady).not.toHaveBeenCalled();
  });
});

describe("serialization keeps the author's markup", () => {
  it("keeps contenteditable/spellcheck the document itself declares and drops only what docuzen added", async () => {
    const authored =
      '<!doctype html><html><head></head><body spellcheck="true"><div contenteditable="true">notes</div><p>x</p></body></html>';
    const s = new HtmlSurface(host);
    s.load(authored, undefined, "/d/a.html");
    await nav.commit();
    s.setEditable(true);
    s.setEditable(false);
    const saved = s.getHtml();
    expect(saved).toContain('<div contenteditable="true">notes</div>');
    expect(saved).toContain('<body spellcheck="true">');
    expect(saved).not.toContain("data-had");

    s.load("<!doctype html><html><head></head><body><p>plain</p></body></html>", undefined, "/d/b.html");
    await nav.commit();
    s.setEditable(true);
    expect(s.getHtml()).toContain("<body><p>plain</p></body>"); // no contenteditable, no spellcheck="false"
  });

  it("a diagram docuzen inserted is saved without its editing-only contenteditable", () => {
    const doc = new DOMParser().parseFromString("<!doctype html><html><body><p>first</p></body></html>", "text/html");
    const anchor = { exact: "first", prefix: "", suffix: "" };
    insertDiagramIntoHtmlDoc(doc, anchor, "<svg></svg>", "flowchart LR\n  A --> B");
    expect(doc.querySelector("figure")!.getAttribute("contenteditable")).toBe("false"); // one unit while editing
    const saved = serializeDocument(doc);
    expect(saved).toContain('<figure class="docuzen-diagram"');
    expect(saved).not.toContain("contenteditable");
    expect(saved).not.toContain("data-had");
  });

  it("a load/save round trip leaves the file as it was (the final newline does not pile up in <body>)", () => {
    const parse = (html: string) => new DOMParser().parseFromString(html, "text/html");
    for (const file of [
      "<!doctype html>\n<html><head></head><body><p>x</p>\n</body></html>\n",
      "<!doctype html>\n<html><head></head><body><p>x</p></body></html>\n",
      "<!doctype html>\n<html><head></head><body>hello\n</body></html>\n",
    ]) {
      expect(serializeDocument(parse(file))).toBe(file);
    }
    const once = serializeDocument(parse("<p>no final newline</p>"));
    expect(serializeDocument(parse(once))).toBe(once);
  });

  it("writes a SYSTEM identifier when the doctype has one but no PUBLIC identifier", () => {
    const parse = (html: string) => new DOMParser().parseFromString(html, "text/html");
    const legacy = parse('<!DOCTYPE html SYSTEM "about:legacy-compat"><html><body>x</body></html>');
    expect(serializeDocument(legacy)).toMatch(/^<!doctype html SYSTEM "about:legacy-compat">\n/);
    const strict = parse(
      '<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01//EN" "http://www.w3.org/TR/html4/strict.dtd"><html><body>x</body></html>',
    );
    expect(serializeDocument(strict)).toMatch(
      /^<!doctype html PUBLIC "-\/\/W3C\/\/DTD HTML 4.01\/\/EN" "http:\/\/www.w3.org\/TR\/html4\/strict.dtd">\n/,
    );
    expect(serializeDocument(parse("<!doctype html><html><body>x</body></html>"))).toMatch(/^<!doctype html>\n/);
  });
});

describe("relative links resolve against the document's folder", () => {
  it("the <base> is part of the document from its first byte, so the first fetches already use it, and is never saved", async () => {
    const s = new HtmlSurface(host);
    s.load(A, "file:///d/", "/d/a.html");
    const srcdoc = frame().getAttribute("srcdoc") ?? "";
    expect(srcdoc).toBe(""); // still deferred
    await nav.commit();
    const doc = s.doc!;
    const base = doc.head.querySelector("base")!;
    expect(base.getAttribute("href")).toBe("file:///d/");
    expect(frame().getAttribute("srcdoc")).toMatch(/^<!doctype html><html><head><base data-had-base href="file:\/\/\/d\/">/);
    expect(s.getHtml()).not.toContain("<base");
  });

  it("keeps a document's own <base>", async () => {
    const s = new HtmlSurface(host);
    s.load('<!doctype html><html><head><base href="https://cdn.test/"></head><body></body></html>', "file:///d/", "/d/a.html");
    await nav.commit();
    expect([...s.doc!.querySelectorAll("base")].map((b) => b.getAttribute("href"))).toEqual(["https://cdn.test/"]);
  });

  it("injects into documents with no <head> or no tags at all", async () => {
    const s = new HtmlSurface(host);
    s.load("<p>fragment</p>", "file:///d/", "/d/a.html");
    await nav.commit();
    expect(s.doc!.querySelector("base")?.getAttribute("href")).toBe("file:///d/");
    expect(s.doc!.body.textContent).toBe("fragment");
  });

  it("percent-encodes folder names, so #, ? and % stay part of the path", () => {
    expect(baseHrefForDoc("/Users/me/A#1 ?x%/doc.html")).toBe("file:///Users/me/A%231%20%3Fx%25/");
    expect(new URL("img.png", baseHrefForDoc("/Users/me/A#1 ?x%/doc.html")).pathname).toBe("/Users/me/A%231%20%3Fx%25/img.png");
    expect(baseHrefForDoc("/d/plain/doc.html")).toBe("file:///d/plain/");
  });
});
