import { describe, it, expect } from "vitest";
import { hadPaths } from "../../src/had/paths.js";

describe("hadPaths", () => {
  it("computes the .had dir under the doc dir's .docuzen (no repo)", () => {
    const p = hadPaths("/work/plan-rate-limiting.md");
    expect(p.dir).toBe("/work/.docuzen/plan-rate-limiting.md.had");
    expect(p.manifest).toBe("/work/.docuzen/plan-rate-limiting.md.had/manifest.json");
    expect(p.annotations).toBe("/work/.docuzen/plan-rate-limiting.md.had/annotations.json");
    expect(p.threadsDir).toBe("/work/.docuzen/plan-rate-limiting.md.had/threads");
    expect(p.sessionsDir).toBe("/work/.docuzen/plan-rate-limiting.md.had/sessions");
    expect(p.versionsDir).toBe("/work/.docuzen/plan-rate-limiting.md.had/versions");
    expect(p.versionsIndex).toBe("/work/.docuzen/plan-rate-limiting.md.had/versions/index.json");
    expect(p.stateDb).toBe("/work/.docuzen/plan-rate-limiting.md.had/state.db");
  });

  it("derives per-thread file paths", () => {
    const p = hadPaths("/work/plan.md");
    expect(p.threadFile("c0001")).toBe("/work/.docuzen/plan.md.had/threads/c0001.md");
    expect(p.sessionFile("c0001")).toBe(
      "/work/.docuzen/plan.md.had/sessions/c0001.session.jsonl",
    );
    expect(p.versionFile("v0008")).toBe("/work/.docuzen/plan.md.had/versions/v0008.md");
  });
});
