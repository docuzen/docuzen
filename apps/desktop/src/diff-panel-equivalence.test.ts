import { describe, expect, it } from "vitest";
import { diffLines } from "diff";
import { buildDiffPaneLines } from "./proposals.js";

//
// The diff panel builds its two panes from `diffLines(before, after)`: one pane line per
// diff part (removed → left, added → right, unchanged → both). For a while it instead
// rebuilt them from docd's `diffToHunks`, whose hunks carry no positions, by searching
// for each hunk's text — which struck out the first copy of a repeated line instead of
// the deleted one (M29). These tests pin the per-part construction on fixture texts,
// against a local reference implementation of it.

interface PaneLine {
  cls: "diff-ctx" | "diff-del" | "diff-add";
  value: string;
}

/** Reference: one pane-line per diffLines part. */
function oldBuildDiffPaneLines(before: string, after: string): { before: PaneLine[]; after: PaneLine[] } {
  const beforeLines: PaneLine[] = [];
  const afterLines: PaneLine[] = [];
  for (const part of diffLines(before, after)) {
    if (part.removed) beforeLines.push({ cls: "diff-del", value: part.value });
    else if (part.added) afterLines.push({ cls: "diff-add", value: part.value });
    else {
      beforeLines.push({ cls: "diff-ctx", value: part.value });
      afterLines.push({ cls: "diff-ctx", value: part.value });
    }
  }
  return { before: beforeLines, after: afterLines };
}

describe("diff panel pane construction: one pane line per diffLines part", () => {
  it("matches exactly for equal-line runs (no changes)", () => {
    const before = "A\nB\nC\n";
    const after = "A\nB\nC\n";
    expect(buildDiffPaneLines(before, after)).toEqual(oldBuildDiffPaneLines(before, after));
  });

  it("matches exactly for an add-only change", () => {
    const before = "A\nB\n";
    const after = "A\nB\nC\n";
    expect(buildDiffPaneLines(before, after)).toEqual(oldBuildDiffPaneLines(before, after));
  });

  it("matches exactly for a del-only change", () => {
    const before = "A\nB\nC\n";
    const after = "A\nB\n";
    expect(buildDiffPaneLines(before, after)).toEqual(oldBuildDiffPaneLines(before, after));
  });

  it("matches exactly for a mixed change (adjacent replaced lines, no context between them)", () => {
    const before = "A\nB\nD\nC\n";
    const after = "A\nX\nY\nC\n";
    expect(buildDiffPaneLines(before, after)).toEqual(oldBuildDiffPaneLines(before, after));
  });

  it("matches exactly for two separated single-line replacements", () => {
    const before = "A\nB\nE\nD\nC\n";
    const after = "A\nX\nE\nY\nC\n";
    expect(buildDiffPaneLines(before, after)).toEqual(oldBuildDiffPaneLines(before, after));
  });

  it("matches exactly for the same replaced text appearing twice (duplicate hunks)", () => {
    const before = "A\nOLD\nB\nOLD\nC\n";
    const after = "A\nNEW\nB\nNEW\nC\n";
    expect(buildDiffPaneLines(before, after)).toEqual(oldBuildDiffPaneLines(before, after));
  });

  it("matches exactly for a replacement that grows the line count", () => {
    const before = "A\nB\nC\n";
    const after = "A\nB2\nB3\nC\n";
    expect(buildDiffPaneLines(before, after)).toEqual(oldBuildDiffPaneLines(before, after));
  });

  it("matches exactly for empty before/after texts", () => {
    expect(buildDiffPaneLines("", "A\nB\n")).toEqual(oldBuildDiffPaneLines("", "A\nB\n"));
    expect(buildDiffPaneLines("A\nB\n", "")).toEqual(oldBuildDiffPaneLines("A\nB\n", ""));
    expect(buildDiffPaneLines("", "")).toEqual(oldBuildDiffPaneLines("", ""));
  });

  it("matches exactly for a pure line reorder (no merged context divs)", () => {
    // "B" moves from position 2 to the end. diffLines emits four parts — ctx"A\n",
    // removed"B\n", ctx"C\n", added"B\n" — and the after pane keeps the two context
    // parts as two lines. (The hunk-reconstruction version merged them into one div.)
    const before = "A\nB\nC\n";
    const after = "A\nC\nB\n";
    expect(buildDiffPaneLines(before, after)).toEqual(oldBuildDiffPaneLines(before, after));
  });

  // M29: rebuilding the panes by searching for each hunk's text found the FIRST copy of
  // a line that appears more than once, so the wrong line was struck out.
  it("strikes the deleted copy of a repeated line, not the first copy", () => {
    const panes = buildDiffPaneLines("A\nB\nA\n", "A\nB\n");
    expect(panes.before).toEqual([
      { cls: "diff-ctx", value: "A\nB\n" },
      { cls: "diff-del", value: "A\n" },
    ]);
    expect(panes.after).toEqual([{ cls: "diff-ctx", value: "A\nB\n" }]);
  });

  it("strikes a deleted blank line where it was, not at the first blank line", () => {
    const before = "# T\n\nintro\n\n\nend\n";
    const after = "# T\n\nintro\n\nend\n";
    expect(buildDiffPaneLines(before, after)).toEqual(oldBuildDiffPaneLines(before, after));
    const del = buildDiffPaneLines(before, after).before.findIndex((l) => l.cls === "diff-del");
    expect(buildDiffPaneLines(before, after).before.slice(0, del).map((l) => l.value).join("")).toContain("intro");
  });
});
