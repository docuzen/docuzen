// @vitest-environment happy-dom
//
// `directive-N` thread ids are ordinals. The sidecar numbers a document's `[[ … ]]`
// directives from the saved markdown (packages/docd's findDirectives, run by a directive
// pass); the editor numbers them from its own document to route a ⌘-click to
// `directive-N` (editor.ts's findDirectiveOffsets, via the click-jump plugin). Feed both
// the same markdown and the N-th directive must be the same one on both sides.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getMarkdown } from "@milkdown/kit/utils";
import { findDirectives } from "../../../packages/docd/src/orchestrator/directives.js";
import { findDirectiveOffsets } from "./editor.js";
import { bodyHtml, mountEditor, type MountedEditor } from "./editor-harness.test-support.js";

// Each directive's instruction holds one marker word; each `decoy*` word sits in code or in
// a marker that is not a directive.
const CASES: { name: string; md: string; directives: string[]; decoys: string[] }[] = [
  { name: "plain directives", md: "Intro [[ alpha ]] and [[ bravo ]].\n", directives: ["alpha", "bravo"], decoys: [] },
  {
    name: "a fenced code block",
    md: "```\n[[ decoyone ]]\n```\n\nText [[ alpha ]] end.\n",
    directives: ["alpha"],
    decoys: ["decoyone"],
  },
  {
    name: "a tilde fence and a quote",
    md: "~~~md\n[[ decoyone ]]\n~~~\n\nText [[ alpha ]]\n\n> quote [[ bravo ]]\n",
    directives: ["alpha", "bravo"],
    decoys: ["decoyone"],
  },
  {
    name: "inline code, and code inside a directive",
    md: "Use `[[ decoyone ]]` here, then [[ alpha ]] and [[ rename `bravo` now ]].\n",
    directives: ["alpha", "bravo"],
    decoys: ["decoyone"],
  },
  {
    name: "an unclosed [[ before a directive",
    md: "[[ decoyone never closed and [[ alpha ]] then [[ bravo ]]\n",
    directives: ["alpha", "bravo"],
    decoys: ["decoyone"],
  },
  { name: "a whitespace-only marker", md: "Empty [[   ]] then [[ alpha ]]\n", directives: ["alpha"], decoys: [] },
  {
    name: "a directive across paragraphs",
    md: "[[ alpha\n\nstill alpha ]] and [[ bravo ]]\n",
    directives: ["alpha", "bravo"],
    decoys: [],
  },
  { name: "escaped brackets", md: "Literal \\[\\[ alpha ]] text [[ bravo ]]\n", directives: ["alpha", "bravo"], decoys: [] },
  {
    name: "lists, with a fence inside an item",
    md: "- first [[ alpha ]]\n- second\n\n  ```\n  [[ decoyone ]]\n  ```\n\n1. [[ bravo ]]\n2. done\n",
    directives: ["alpha", "bravo"],
    decoys: ["decoyone"],
  },
];

let ed: MountedEditor;
const jumps = vi.fn();

beforeEach(async () => {
  document.body.innerHTML = bodyHtml;
  jumps.mockReset();
  ed = await mountEditor({ onDirectiveJump: jumps });
});

/** The directive ordinal the editor routes a ⌘-click on `word` to (undefined: not a directive). */
function editorOrdinal(word: string): number | undefined {
  jumps.mockReset();
  ed.metaClick(ed.posOf(word) + 1);
  return jumps.mock.calls[0]?.[0] as number | undefined;
}

/** The 1-based ordinal of the sidecar directive whose instruction holds `word`. */
function sidecarOrdinal(md: string, word: string): number | undefined {
  const i = findDirectives(md).findIndex((d) => d.instruction.includes(word));
  return i === -1 ? undefined : i + 1;
}

describe("sidecar and editor agree on directive ordinals", () => {
  for (const c of CASES) {
    it(`with ${c.name}`, () => {
      ed.setMarkdown(c.md);
      // As authored, and as the editor saves it (escaped brackets and all).
      const saved = ed.editor.action(getMarkdown());
      for (const md of [c.md, saved]) {
        expect(findDirectives(md)).toHaveLength(c.directives.length);
        c.directives.forEach((word, i) => {
          expect(sidecarOrdinal(md, word)).toBe(i + 1);
          expect(editorOrdinal(word)).toBe(i + 1);
        });
      }
      for (const word of c.decoys) expect(editorOrdinal(word)).toBeUndefined();
    });
  }
});

describe("findDirectiveOffsets", () => {
  it("skips whitespace-only markers and never bridges an unclosed [[", () => {
    const text = "[[ ]] a [[ open [[ real ]] b";
    expect(findDirectiveOffsets(text).map((d) => text.slice(d.start, d.end))).toEqual(["[[ real ]]"]);
  });

  it("ignores brackets inside code ranges but keeps a directive that contains code", () => {
    const text = "x [[ code ]] y [[ has code ]]";
    const code = [
      { start: 2, end: 12 },
      { start: 19, end: 23 },
    ];
    expect(findDirectiveOffsets(text, code).map((d) => text.slice(d.start, d.end))).toEqual(["[[ has code ]]"]);
  });
});
