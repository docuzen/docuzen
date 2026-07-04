import { describe, expect, it } from "vitest";
import { middleTruncate } from "./status-path.js";

// Pure-helper unit tests for middleTruncate. No DOM, no jsdom needed.
// DOM wiring (button, click, activateTab hookup) is covered by build (tsc+vite)
// and manual reasoning — the same split doc-zoom.test.ts uses.

describe("middleTruncate", () => {
  it("returns short paths unchanged (length <= max)", () => {
    const path = "/Users/alice/docs/notes.md";
    expect(middleTruncate(path, 60)).toBe(path);
    expect(middleTruncate(path, path.length)).toBe(path);
  });

  it("returns single-char paths unchanged regardless of max", () => {
    expect(middleTruncate("a", 1)).toBe("a");
  });

  it("truncates long paths to <= max characters and inserts an ellipsis", () => {
    const path = "/Users/alice/very-long-project-name/subdir/another-level/notes.md";
    const max = 40;
    const result = middleTruncate(path, max);
    expect(result.length).toBeLessThanOrEqual(max);
    expect(result).toContain("…");
  });

  it("preserves the file basename (tail) in the truncated result", () => {
    const path = "/Users/alice/very-long-project-name/subdir/another-level/notes.md";
    const result = middleTruncate(path, 40);
    expect(result.endsWith("notes.md")).toBe(true);
  });

  it("preserves a leading segment (head) in the truncated result", () => {
    const path = "/Users/alice/very-long-project-name/subdir/another-level/notes.md";
    const result = middleTruncate(path, 40);
    // The head must start from the beginning
    expect(result.startsWith("/")).toBe(true);
  });

  it("handles exact-boundary: path length === max returns path unchanged", () => {
    const path = "/Users/alice/docs/notes.md";
    expect(middleTruncate(path, path.length)).toBe(path);
  });

  it("handles exact-boundary: path length === max + 1 triggers truncation", () => {
    const path = "/Users/alice/docs/notes.md";
    const max = path.length - 1;
    const result = middleTruncate(path, max);
    expect(result.length).toBeLessThanOrEqual(max);
    expect(result).toContain("…");
  });

  it("truncated result still ends with the full basename when basename fits", () => {
    // basename is "report-q3-2026.md" (18 chars) — well within max=40
    const path = "/Users/alice/projects/docuzen/docs/architecture/report-q3-2026.md";
    const result = middleTruncate(path, 40);
    expect(result.endsWith("report-q3-2026.md")).toBe(true);
    expect(result.length).toBeLessThanOrEqual(40);
  });
});
