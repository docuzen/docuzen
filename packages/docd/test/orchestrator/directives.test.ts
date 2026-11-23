import { describe, it, expect } from "vitest";
import { findDirectives } from "../../src/orchestrator/directives.js";

describe("findDirectives", () => {
  it("finds a single directive with trimmed instruction and index", () => {
    const body = "Intro.\n\n[[ add a citation to Rayleigh ]]\n\nMore.";
    const d = findDirectives(body);
    expect(d).toHaveLength(1);
    expect(d[0].instruction).toBe("add a citation to Rayleigh");
    expect(d[0].marker).toBe("[[ add a citation to Rayleigh ]]");
    expect(body.slice(d[0].index, d[0].index + d[0].marker.length)).toBe(d[0].marker);
  });

  it("finds multiple directives in document order", () => {
    const d = findDirectives("[[ shorten this ]] middle [[ add an example ]]");
    expect(d.map((x) => x.instruction)).toEqual(["shorten this", "add an example"]);
  });

  it("handles a multiline instruction", () => {
    const d = findDirectives("[[ rewrite the\nopening paragraph ]]");
    expect(d).toHaveLength(1);
    expect(d[0].instruction).toBe("rewrite the\nopening paragraph");
  });

  it("finds markdown-escaped directives emitted by the WYSIWYG serializer", () => {
    const body =
      "Use 429 responses.  \\[\\[find citations of blogs describing good api rate gateway design]]";
    const d = findDirectives(body);
    expect(d).toHaveLength(1);
    expect(d[0].instruction).toBe("find citations of blogs describing good api rate gateway design");
    expect(d[0].marker).toBe("\\[\\[find citations of blogs describing good api rate gateway design]]");
  });

  it("also accepts fully escaped open and close brackets", () => {
    const d = findDirectives("\\[\\[cite source\\]\\]");
    expect(d).toHaveLength(1);
    expect(d[0].instruction).toBe("cite source");
    expect(d[0].marker).toBe("\\[\\[cite source\\]\\]");
  });

  it("ignores empty markers and returns [] when there are none", () => {
    expect(findDirectives("no directives here")).toEqual([]);
    expect(findDirectives("empty [[]] and [[   ]] markers")).toEqual([]);
  });

  // The editor numbers directives itself (⌘-click → `directive-N`), and it never sees code
  // as directive text: the two counts must agree or ⌘-click opens the wrong thread.
  it("skips [[ … ]] inside fenced code blocks", () => {
    const body = "```\n[[ not a directive ]]\n```\n\n~~~md\n[[ nor this ]]\n~~~\n\n[[ real one ]]";
    expect(findDirectives(body).map((d) => d.instruction)).toEqual(["real one"]);
  });

  it("skips [[ … ]] inside a fence nested in a list item or a quote", () => {
    const body = "- item\n\n  ```\n  [[ in list ]]\n  ```\n\n> ```\n> [[ in quote ]]\n> ```\n\n[[ real ]]";
    expect(findDirectives(body).map((d) => d.instruction)).toEqual(["real"]);
  });

  it("does not take a one-line ```code``` span for a fence", () => {
    expect(findDirectives("```[[ x ]]``` and [[ real ]]").map((d) => d.instruction)).toEqual(["real"]);
  });

  it("skips [[ … ]] inside an unclosed fence (it runs to the end of the document)", () => {
    expect(findDirectives("[[ before ]]\n\n```\n[[ inside ]]\n")).toHaveLength(1);
  });

  it("skips [[ … ]] inside inline code spans, but keeps code inside a directive", () => {
    const body = "Write `[[ x ]]` or ``[[ y ]]`` literally. [[ rename `foo` to bar ]]";
    const d = findDirectives(body);
    expect(d.map((x) => x.instruction)).toEqual(["rename `foo` to bar"]);
    expect(body.slice(d[0].index, d[0].index + d[0].marker.length)).toBe("[[ rename `foo` to bar ]]");
  });

  it("treats a backslash-escaped backtick as text, not a code span", () => {
    expect(findDirectives("a \\`[[ real ]]\\` b").map((d) => d.instruction)).toEqual(["real"]);
  });

  it("does not bridge an unclosed [[ into the next directive", () => {
    const d = findDirectives("[[ never closed and then [[ real ]]");
    expect(d.map((x) => x.instruction)).toEqual(["real"]);
    expect(d[0].marker).toBe("[[ real ]]");
    expect(findDirectives("\\[\\[ never closed \\[\\[ real ]]").map((x) => x.marker)).toEqual(["\\[\\[ real ]]"]);
  });
});
