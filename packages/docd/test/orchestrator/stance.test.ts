import { describe, it, expect } from "vitest";
import { stancePrompt, STANCES } from "../../src/orchestrator/stance.js";

describe("stancePrompt", () => {
  it("returns a non-empty fragment for each built-in stance", () => {
    for (const id of STANCES) {
      expect(stancePrompt(id).length).toBeGreaterThan(0);
    }
  });
  it("none is neutral, critiquer challenges, supporter strengthens", () => {
    expect(stancePrompt("none").toLowerCase()).toContain("neutral");
    expect(stancePrompt("critiquer").toLowerCase()).toContain("challenge");
    expect(stancePrompt("supporter").toLowerCase()).toContain("strengthen");
  });
  it("falls back to the none fragment for an unknown stance", () => {
    expect(stancePrompt("nonsense")).toBe(stancePrompt("none"));
  });
});
