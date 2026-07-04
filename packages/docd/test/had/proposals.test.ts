import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readProposals,
  listProposals,
  addProposal,
  updateProposal,
} from "../../src/had/proposals.js";
import type { Proposal } from "../../src/had/proposals.js";

let dir: string;
let docPath: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "had-prop-"));
  docPath = join(dir, "plan.md");
  await writeFile(docPath, "# Plan\n", "utf8");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const sample: Proposal = {
  id: "c0001#p1",
  threadId: "c0001",
  edits: [{ oldText: "Redis", newText: "an in-memory store" }],
  rationale: "single node",
  status: "pending",
  delivered: false,
  at: "2026-06-12T10:00:00.000Z",
};

describe("proposals store", () => {
  it("returns an empty file when none exists", async () => {
    const f = await readProposals(docPath);
    expect(f).toEqual({ version: 1, proposals: [] });
  });

  it("adds then reads back a proposal", async () => {
    await addProposal(docPath, sample);
    const f = await readProposals(docPath);
    expect(f.proposals).toHaveLength(1);
    expect(f.proposals[0]).toEqual(sample);
  });

  it("round-trips a legacy single-span proposal (newText, empty edits)", async () => {
    const legacy: Proposal = {
      id: "c0009#p1",
      threadId: "c0009",
      edits: [],
      newText: "an in-memory store",
      rationale: "single node",
      status: "pending",
      delivered: false,
      at: "2026-06-12T10:00:00.000Z",
    };
    await addProposal(docPath, legacy);
    expect((await listProposals(docPath, "c0009"))[0]).toEqual(legacy);
  });

  it("listProposals filters by threadId", async () => {
    await addProposal(docPath, sample);
    await addProposal(docPath, { ...sample, id: "c0002#p1", threadId: "c0002" });
    expect((await listProposals(docPath, "c0001")).map((p) => p.id)).toEqual(["c0001#p1"]);
    expect(await listProposals(docPath)).toHaveLength(2);
  });

  it("updateProposal patches by id", async () => {
    await addProposal(docPath, sample);
    await updateProposal(docPath, "c0001#p1", { status: "approved" });
    expect((await listProposals(docPath, "c0001"))[0].status).toBe("approved");
  });

  it("throws when updating a missing id", async () => {
    await expect(
      updateProposal(docPath, "nope", { status: "approved" }),
    ).rejects.toThrow(/nope/);
  });
});
