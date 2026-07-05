import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hadPaths } from "../../src/had/paths.js";

// Docs live in a fresh temp dir with no `.git` anywhere up its chain, so the
// non-git fallback (`<doc-dir>/.docuzen/<basename>.had`) applies deterministically
// regardless of the host filesystem.
function tmpDoc(name: string): { dir: string; doc: string } {
  const dir = mkdtempSync(join(tmpdir(), "paths-"));
  const doc = join(dir, name);
  writeFileSync(doc, "# doc\n");
  return { dir, doc };
}

describe("hadPaths", () => {
  it("computes the .had dir under the doc dir's .docuzen (no repo)", () => {
    const { dir, doc } = tmpDoc("plan-rate-limiting.md");
    const had = join(dir, ".docuzen", "plan-rate-limiting.md.had");
    const p = hadPaths(doc);
    expect(p.dir).toBe(had);
    expect(p.manifest).toBe(join(had, "manifest.json"));
    expect(p.annotations).toBe(join(had, "annotations.json"));
    expect(p.threadsDir).toBe(join(had, "threads"));
    expect(p.sessionsDir).toBe(join(had, "sessions"));
    expect(p.versionsDir).toBe(join(had, "versions"));
    expect(p.versionsIndex).toBe(join(had, "versions", "index.json"));
    expect(p.stateDb).toBe(join(had, "state.db"));
  });

  it("derives per-thread file paths", () => {
    const { dir, doc } = tmpDoc("plan.md");
    const had = join(dir, ".docuzen", "plan.md.had");
    const p = hadPaths(doc);
    expect(p.threadFile("c0001")).toBe(join(had, "threads", "c0001.md"));
    expect(p.sessionFile("c0001")).toBe(join(had, "sessions", "c0001.session.jsonl"));
    expect(p.versionFile("v0008")).toBe(join(had, "versions", "v0008.md"));
  });
});
