import { describe, expect, it, vi } from "vitest";
import { isDocumentName, matchDroppedPaths, openDroppedDocuments, type DocDropIo } from "./doc-drop.js";

describe("matchDroppedPaths", () => {
  it("keeps only the pasteboard paths of the files actually dropped, in pasteboard order, each once", () => {
    const r = matchDroppedPaths(["b.md", "a.md"], ["/x/a.md", "/x/b.md", "/x/stale.md", "/x/a.md"]);
    expect(r).toEqual({ matched: ["/x/a.md", "/x/b.md"], missing: [] });
  });

  it("matches a decomposed path name to a composed file name", () => {
    const decomposed = "/Users/me/cafe\u0301.md";
    expect(matchDroppedPaths(["caf\u00e9.md"], [decomposed])).toEqual({ matched: [decomposed], missing: [] });
  });

  it("opens two files that share a name from different folders", () => {
    expect(matchDroppedPaths(["notes.md", "notes.md"], ["/a/notes.md", "/b/notes.md"]).matched).toEqual(["/a/notes.md", "/b/notes.md"]);
  });

  it("reports the names no path was found for (a pasteboard left over from an earlier drag)", () => {
    expect(matchDroppedPaths(["new.md"], ["/old/other.md"])).toEqual({ matched: [], missing: ["new.md"] });
  });

  it("knows docuzen's document types", () => {
    expect(["a.md", "a.MARKDOWN", "a.html", "a.htm", "a.hadz"].every(isDocumentName)).toBe(true);
    expect(["a.txt", "a.png", "md", "a.md.pdf"].some(isDocumentName)).toBe(false);
  });
});

describe("openDroppedDocuments", () => {
  function io(paths: string[] | null | Error): DocDropIo & { opened: string[]; notices: string[] } {
    const opened: string[] = [];
    const notices: string[] = [];
    return {
      opened,
      notices,
      droppedPaths: vi.fn(async () => {
        if (paths instanceof Error) throw paths;
        return paths;
      }),
      open: vi.fn(async (p: string) => void opened.push(p)),
      notify: (m) => void notices.push(m),
      log: () => {},
    };
  }

  it("opens each dropped document by its path", async () => {
    const x = io(["/d/one.md", "/d/two.hadz"]);
    await openDroppedDocuments(["one.md", "two.hadz"], x);
    expect(x.opened).toEqual(["/d/one.md", "/d/two.hadz"]);
    expect(x.notices).toEqual([]);
  });

  it("opens what it can find and names what it can't", async () => {
    const x = io(["/d/one.md"]);
    await openDroppedDocuments(["one.md", "lost.md"], x);
    expect(x.opened).toEqual(["/d/one.md"]);
    expect(x.notices).toEqual([expect.stringMatching(/lost\.md.*File → Open/)]);
  });

  it("outside the app (no pasteboard), points to File → Open", async () => {
    const x = io(null);
    await openDroppedDocuments(["one.md"], x);
    expect(x.opened).toEqual([]);
    expect(x.notices).toEqual([expect.stringMatching(/only in the docuzen app/)]);
  });

  it("a failing pasteboard read opens nothing and says so", async () => {
    const x = io(new Error("boom"));
    await openDroppedDocuments(["one.md"], x);
    expect(x.opened).toEqual([]);
    expect(x.notices).toEqual([expect.stringMatching(/one\.md/)]);
  });
});
