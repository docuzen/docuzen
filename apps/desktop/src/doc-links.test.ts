// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

vi.mock("@milkdown/kit/core", () => ({ editorViewCtx: Symbol("view") }));
vi.mock("@milkdown/kit/preset/commonmark", () => ({ imageSchema: { node: {}, extendSchema: () => ({ node: {} }) } }));
vi.mock("@milkdown/kit/utils", () => ({ $view: (_n: unknown, f: unknown) => f }));

import { OPENABLE_EXTENSIONS, findFragment, headingSlug, initDocLinks, linkTarget, type DocLinksDeps, type PathInfo } from "./doc-links.js";

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
    // A folder is shown in Finder, not opened (it is not a document or media file).
    expect(linkTarget(DOC, "papers/")).toEqual({ kind: "reveal", path: "/Users/me/notes/papers" });
    expect(linkTarget(DOC, "file:/abs/a.pdf")).toEqual({ kind: "file", path: "/abs/a.pdf" });
  });

  it("says a Windows drive path cannot be opened on this Mac (rather than that the link is empty)", () => {
    for (const href of ["C:\\Users\\me\\a.pdf", "c:/Users/me/a.pdf"]) {
      const t = linkTarget(DOC, href);
      expect(t.kind).toBe("refused");
      expect(t.kind === "refused" && t.reason).toMatch(/Windows/);
    }
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

  it("opens only documents and media; anything else, however it is named, is shown in Finder", () => {
    for (const name of ["paper.pdf", "Photo.HEIC", "talk.mp4", "data.csv", "notes.txt", "deck.pptx", "song.m4a", "page.html"]) {
      expect(linkTarget(DOC, name).kind, name).toBe("file");
    }
    // Extensionless executables, runnable kinds no list of "dangerous" names would think of,
    // and anything at all inside an app bundle.
    for (const name of [
      "build",
      "bin/tool",
      "run.pyw",
      "a.osa",
      "a.jxa",
      "app.jnlp",
      "loc.afploc",
      "profile.mobileconfig",
      "flow.automator",
      "archive.zip",
      "Foo.app/Contents/MacOS/Foo",
      "Foo.app/Contents/Resources/help.pdf",
      "Foo.app/Contents/Resources/README.md",
      "Tools.bundle/Contents/x.png",
    ]) {
      expect(linkTarget(DOC, name).kind, name).toBe("reveal");
    }
  });

  it("the opener's scope in the app's capabilities admits exactly these extensions, in any letter case", () => {
    const caps = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../src-tauri/capabilities/default.json"), "utf8")) as {
      permissions: (string | { identifier: string; allow?: { path: string }[] })[];
    };
    const openPath = caps.permissions.find((p) => typeof p === "object" && p.identifier === "opener:allow-open-path");
    const anyCase = (ext: string) => [...ext].map((c) => (/[a-z]/.test(c) ? `[${c}${c.toUpperCase()}]` : c)).join("");
    expect(typeof openPath === "object" && openPath.allow?.map((a) => a.path)).toEqual(
      OPENABLE_EXTENSIONS.map((ext) => `$HOME/**/*.${anyCase(ext)}`),
    );
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
      inspectPath: vi.fn(async (path: string): Promise<PathInfo> => ({ realPath: path, kind: "file" })),
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

  /** Links in DOC's folder whose real targets are given by `fs` (written path -> what is there). */
  function onDisk(fs: Record<string, PathInfo>) {
    return setup({ inspectPath: vi.fn(async (path: string) => fs[path] ?? { realPath: null, kind: "missing" }) });
  }
  const at = (name: string) => `/Users/me/notes/${name}`;

  it("a symlink named like a document that points at a program is shown in Finder, never opened", async () => {
    const { deps, links } = onDisk({
      [at("notes.txt")]: { realPath: at("run.command"), kind: "file" },
      [at("slides.pdf")]: { realPath: "/Applications/Tool.app", kind: "directory" },
      [at("help.pdf")]: { realPath: "/Applications/Tool.app/Contents/Resources/help.pdf", kind: "file" },
      [at("fifo.pdf")]: { realPath: at("fifo.pdf"), kind: "other" },
    });
    for (const name of ["notes.txt", "slides.pdf", "help.pdf", "fifo.pdf"]) await links.open(name, document);
    expect(deps.openPath).not.toHaveBeenCalled();
    expect(vi.mocked(deps.revealPath).mock.calls.map((c) => c[0])).toEqual([
      at("run.command"),
      "/Applications/Tool.app",
      "/Applications/Tool.app/Contents/Resources/help.pdf",
      at("fifo.pdf"),
    ]);
    expect(vi.mocked(deps.notify).mock.calls[0][0]).toBe(
      "notes.txt points to run.command, which is not a document or media file, so it was shown in Finder instead of opened.",
    );
  });

  it("opens the file that is really there when it is a document too", async () => {
    const { deps, links } = onDisk({ [at("latest.pdf")]: { realPath: at("versions/v3.pdf"), kind: "file" } });
    await links.open("latest.pdf", document);
    expect(deps.openPath).toHaveBeenCalledWith(at("versions/v3.pdf"));
    expect(deps.revealPath).not.toHaveBeenCalled();
  });

  it("shows a folder in Finder, and says when nothing is there", async () => {
    const { deps, links } = onDisk({ [at("papers")]: { realPath: at("papers"), kind: "directory" } });
    await links.open("papers/", document);
    await links.open("gone.pdf", document);
    expect(deps.revealPath).toHaveBeenCalledWith(at("papers"));
    expect(deps.openPath).not.toHaveBeenCalled();
    expect(vi.mocked(deps.notify).mock.calls.map((c) => c[0])).toEqual([
      "papers is a folder, so it was shown in Finder.",
      "Could not open gone.pdf: there is no such file.",
    ]);
  });

  it("when the file cannot be checked, shows it in Finder rather than opening it unchecked", async () => {
    const { deps, links } = setup({ inspectPath: vi.fn(async () => { throw new Error("docd connection lost"); }) });
    await links.open("paper.pdf", document);
    expect(deps.openPath).not.toHaveBeenCalled();
    expect(deps.revealPath).toHaveBeenCalledWith(at("paper.pdf"));
    expect(vi.mocked(deps.notify).mock.calls[0][0]).toMatch(/could not check what paper\.pdf is/);
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
