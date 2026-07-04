import { describe, expect, it } from "vitest";
import { diffLines } from "diff";
import { buildDiffPaneLines } from "./proposals.js";

//
// openDiffPanel's hand-rolled `diffLines`-based pane construction is being replaced
// by proposals.ts's `buildDiffPaneLines`, which computes hunks via docd's shared
// `diffToHunks` (before: apps/desktop independently ran `diffLines` and appended one
// pane-line per diff PART; now it runs the SAME hunk-extraction the backend uses for
// proposal generation, then reconstructs pane lines by locating each hunk's
// oldText/newText back in the original strings — see proposals.ts's header comment
// for why hunks don't carry position info and reconstruction is required at all).
//
// This test locally reimplements the OLD per-diffLines-part algorithm (the exact
// body `openDiffPanel` used to run inline, before it was deleted) so the two can be
// compared directly on fixture texts, per the plan's "prove equivalence or report
// the exact rendering delta" requirement.

interface PaneLine {
  cls: "diff-ctx" | "diff-del" | "diff-add";
  value: string;
}

/** The exact algorithm `openDiffPanel` ran before this task — one pane-line per diffLines part. */
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

describe("diff panel pane construction: diffLines (old) vs diffToHunks (new)", () => {
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

  // --- the one documented delta (see proposals.ts header + task-5-report.md) ---
  it("KNOWN DELTA: a pure line reorder merges two separate context divs into one on the receiving pane", () => {
    // "B" moves from position 2 to the end. diffLines emits FOUR parts here — ctx"A\n",
    // removed"B\n", ctx"C\n", added"B\n" — because the LCS alignment finds "C" as a
    // common anchor BETWEEN the deletion and the (unrelated, from the after-text's
    // point of view) insertion. The old part-by-part renderer therefore puts TWO
    // separate diff-ctx divs on the after pane ("A\n" then "C\n", split by the
    // deletion event that only the before pane cares about). diffToHunks correctly
    // reports this as two independent hunks (a pure delete + a pure insert, since a
    // context part closes any in-progress hunk) — but hunks carry no position info to
    // tell the after-side reconstruction that "A\n" and "C\n" were ever non-adjacent,
    // so buildDiffPaneLines merges them into ONE contiguous "A\nC\n" ctx div.
    //
    // This is a real DOM-structure difference (3 after-pane divs vs 2), not a bug to
    // fix: the CSS's `.diffpane .diff-ctx` rule (styles.css) sets only `color`, no
    // background/border/margin, so two adjacent block-level ctx divs render pixel-
    // identical to one div holding the same concatenated text — verified against
    // styles.css before accepting this delta rather than chasing full positional
    // equivalence.
    const before = "A\nB\nC\n";
    const after = "A\nC\nB\n";
    const oldResult = oldBuildDiffPaneLines(before, after);
    const newResult = buildDiffPaneLines(before, after);

    expect(oldResult.after).toEqual([
      { cls: "diff-ctx", value: "A\n" },
      { cls: "diff-ctx", value: "C\n" },
      { cls: "diff-add", value: "B\n" },
    ]);
    expect(newResult.after).toEqual([
      { cls: "diff-ctx", value: "A\nC\n" },
      { cls: "diff-add", value: "B\n" },
    ]);
    // Concatenated text (what actually renders) is identical either way.
    expect(newResult.after.map((l) => l.value).join("")).toBe(oldResult.after.map((l) => l.value).join(""));
    // The before pane (which the deletion actually touches) is unaffected.
    expect(newResult.before).toEqual(oldResult.before);
  });
});
