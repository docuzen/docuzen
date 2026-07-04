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
});
