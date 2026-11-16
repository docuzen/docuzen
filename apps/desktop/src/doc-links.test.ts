// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";

vi.mock("@milkdown/kit/core", () => ({ editorViewCtx: Symbol("view") }));
vi.mock("@milkdown/kit/preset/commonmark", () => ({ imageSchema: { node: {}, extendSchema: () => ({ node: {} }) } }));
vi.mock("@milkdown/kit/utils", () => ({ $view: (_n: unknown, f: unknown) => f }));

import { findFragment, headingSlug, initDocLinks, linkTarget, type DocLinksDeps } from "./doc-links.js";

const DOC = "/Users/me/notes/reading list.md";

describe("classifying a link", () => {
  it("sends web, mail and phone links to the OS", () => {
    expect(linkTarget(DOC, "https://arxiv.org/abs/2506.13131")).toEqual({ kind: "url", url: "https://arxiv.org/abs/2506.13131" });
    expect(linkTarget(DOC, "mailto:a@b.c")).toEqual({ kind: "url", url: "mailto:a@b.c" });
    expect(linkTarget(DOC, "//example.com/x")).toEqual({ kind: "url", url: "https://example.com/x" });
    expect(linkTarget(undefined, "http://example.com")).toEqual({ kind: "url", url: "http://example.com" });
  });

  it("resolves a relative file against the document's folder", () => {
    expect(linkTarget(DOC, "papers/001_001.pdf")).toEqual({ kind: "file", path: "/Users/me/notes/papers/001_001.pdf" });
    expect(linkTarget(DOC, "../other/my%20paper.pdf#page=3")).toEqual({ kind: "file", path: "/Users/me/other/my paper.pdf" });
    expect(linkTarget(DOC, "file:///abs/a.pdf")).toEqual({ kind: "file", path: "/abs/a.pdf" });
    expect(linkTarget(DOC, "papers/")).toEqual({ kind: "file", path: "/Users/me/notes/papers" });
  });

  it("opens a linked markdown document in docuzen", () => {
    expect(linkTarget(DOC, "./plan.md#risks")).toEqual({ kind: "doc", path: "/Users/me/notes/plan.md" });
    expect(linkTarget(DOC, "Other.MARKDOWN")).toEqual({ kind: "doc", path: "/Users/me/notes/Other.MARKDOWN" });
  });

  it("only reveals programs and scripts", () => {
    for (const name of ["run.command", "Tool.app", "x.sh", "setup.pkg", "a.scpt", "jump.webloc"]) {
      expect(linkTarget(DOC, name).kind).toBe("reveal");
    }
  });

  it("refuses other schemes, empty links, and relative links from an unsaved document", () => {
    expect(linkTarget(DOC, "javascript:alert(1)").kind).toBe("refused");
    expect(linkTarget(DOC, "data:text/html,hi").kind).toBe("refused");
    expect(linkTarget(DOC, "vscode://file/x").kind).toBe("refused");
    expect(linkTarget(DOC, "  ").kind).toBe("refused");
    expect(linkTarget(undefined, "papers/a.pdf").kind).toBe("refused");
  });

  it("treats #fragment as a place in this document", () => {
    expect(linkTarget(DOC, "#read%20first")).toEqual({ kind: "hash", id: "read first" });
  });
});

describe("finding a fragment", () => {
  it("matches an id, a name, then a heading's text", () => {
    document.body.innerHTML = `<h1 id="top">Top</h1><a name="old"></a><h2>Read first: the loop!</h2>`;
    expect(findFragment(document.body, "top")?.tagName).toBe("H1");
    expect(findFragment(document.body, "old")?.tagName).toBe("A");
    expect(findFragment(document.body, "read-first-the-loop")?.tagName).toBe("H2");
    expect(findFragment(document.body, "missing")).toBeNull();
    expect(headingSlug("Venue / ID")).toBe("venue--id");
  });
});

describe("opening a link", () => {
  function setup(over: Partial<DocLinksDeps> = {}) {
    const deps: DocLinksDeps = {
      getDocPath: () => DOC,
      openUrl: vi.fn(async () => {}),
      openPath: vi.fn(async () => {}),
      revealPath: vi.fn(async () => {}),
      openInTab: vi.fn(async () => {}),
      notify: vi.fn(),
      log: vi.fn(),
      ...over,
    };
    return { deps, links: initDocLinks(deps) };
  }

  it("routes each kind to the right opener", async () => {
    const { deps, links } = setup();
    await links.open("https://example.com", document);
    await links.open("papers/001_001.pdf", document);
    await links.open("plan.md", document);
    expect(deps.openUrl).toHaveBeenCalledWith("https://example.com");
    expect(deps.openPath).toHaveBeenCalledWith("/Users/me/notes/papers/001_001.pdf");
    expect(deps.openInTab).toHaveBeenCalledWith("/Users/me/notes/plan.md");
    expect(deps.notify).not.toHaveBeenCalled();
  });

  it("shows a program in Finder and says so, without opening it", async () => {
    const { deps, links } = setup();
    await links.open("run.command", document);
    expect(deps.revealPath).toHaveBeenCalledWith("/Users/me/notes/run.command");
    expect(deps.openPath).not.toHaveBeenCalled();
    expect(vi.mocked(deps.notify).mock.calls[0][0]).toMatch(/shown in Finder/);
  });

  it("says why when a link cannot be opened", async () => {
    const { deps, links } = setup({ openPath: vi.fn(async () => { throw new Error("no such file"); }) });
    await links.open("gone.pdf", document);
    await links.open("javascript:alert(1)", document);
    await links.open("#nowhere", document);
    const said = vi.mocked(deps.notify).mock.calls.map((c) => c[0]);
    expect(said[0]).toBe("Could not open gone.pdf: no such file");
    expect(said[1]).toMatch(/does not open "javascript:" links/);
    expect(said[2]).toMatch(/#nowhere/);
  });

  it("scrolls to a fragment", async () => {
    document.body.innerHTML = `<h2 id="risks">Risks</h2>`;
    const h = document.querySelector("h2")!;
    h.scrollIntoView = vi.fn();
    const { links } = setup();
    await links.open("#risks", document);
    expect(h.scrollIntoView).toHaveBeenCalled();
  });
});
