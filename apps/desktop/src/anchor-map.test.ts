import { describe, it, expect } from "vitest";
import { assembleProjection, posRangeForOffsets } from "./anchor-map.js";

// assembleProjection turns the editor's text-node list (text + ProseMirror pos)
// into the flat projection HAD anchors live over. The load-bearing rule: text
// nodes in the SAME block are contiguous in PM positions and must concatenate
// directly, but text across a BLOCK boundary has a position gap and must be
// separated — otherwise "## Rollout" + "We enable…" glue into "RolloutWe enable…".

describe("assembleProjection", () => {
  it("concatenates adjacent text nodes (same block) with no separator", () => {
    // "Hello " (pos 1..6, ends at 7) then "world" at pos 7 — contiguous, e.g. a
    // bold mark splitting one paragraph into two text nodes.
    const proj = assembleProjection([
      { text: "Hello ", pos: 1 },
      { text: "world", pos: 7 },
    ]);
    expect(proj.text).toBe("Hello world");
    expect(proj.posOfOffset).toHaveLength(proj.text.length);
    expect(proj.posOfOffset[0]).toBe(1);
    expect(proj.posOfOffset[6]).toBe(7); // 'w'
  });

  it("inserts a newline across a block boundary (position gap) — no glue", () => {
    // "Rollout" (pos 2..8, ends at 9) then "We enable" at pos 12: the heading's
    // close token + paragraph's open token leave a gap (12 > 9).
    const proj = assembleProjection([
      { text: "Rollout", pos: 2 },
      { text: "We enable", pos: 12 },
    ]);
    expect(proj.text).toBe("Rollout\nWe enable");
    expect(proj.text).not.toContain("RolloutWe");
    expect(proj.posOfOffset).toHaveLength(proj.text.length);
    expect(proj.posOfOffset[7]).toBe(9); // the inserted "\n" maps to the boundary
    expect(proj.posOfOffset[8]).toBe(12); // 'W' of "We"
  });

  it("separates each of three blocks but never within a block", () => {
    const proj = assembleProjection([
      { text: "A", pos: 1 },
      { text: "B", pos: 5 },
      { text: "C", pos: 9 },
    ]);
    expect(proj.text).toBe("A\nB\nC");
    expect(proj.posOfOffset).toHaveLength(5);
  });

  it("returns an empty projection for no text nodes", () => {
    expect(assembleProjection([])).toEqual({ text: "", posOfOffset: [] });
  });
});

describe("posRangeForOffsets", () => {
  // <p>abc</p><p>def</p>: text at positions 1..4 and 6..9; the "\n" between them stands
  // for the block boundary and sits at 4, the end of the first block's text.
  const proj = assembleProjection([
    { text: "abc", pos: 1 },
    { text: "def", pos: 6 },
  ]);

  it("maps a range to the positions of its first and last characters", () => {
    expect(posRangeForOffsets(proj, 0, 3)).toEqual({ from: 1, to: 4 });
    expect(posRangeForOffsets(proj, 4, 7)).toEqual({ from: 6, to: 9 });
  });

  it("ends a range that runs onto a block boundary inside that block, not past its closing token", () => {
    // A whole-paragraph (triple-click) selection, or a proposal hunk ending in "\n".
    expect(posRangeForOffsets(proj, 0, 4)).toEqual({ from: 1, to: 4 });
  });

  it("keeps a hard break's newline inside the range (the break is a real one-position node)", () => {
    const withBreak = assembleProjection([
      { text: "ab", pos: 1 },
      { text: "cd", pos: 4 }, // a hard break at 3
    ]);
    expect(posRangeForOffsets(withBreak, 0, 3)).toEqual({ from: 1, to: 4 });
  });

  it("is null when the range holds no text (just a block boundary)", () => {
    expect(posRangeForOffsets(proj, 3, 4)).toBeNull();
  });
});
