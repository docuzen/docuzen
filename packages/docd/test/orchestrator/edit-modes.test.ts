// The two edit modes — Suggesting ("propose", default) and Editing ("direct") — observed
// through the public Orchestrator API with a scripted runner. One apply path serves both:
// Editing is "submit, then approve on the spot", so everything Suggesting guarantees
// (recorded proposal, backup + agent-edit versions, HTML validation, refusing an edit whose
// text is gone) must hold in Editing mode too.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Orchestrator } from "../../src/orchestrator/orchestrator.js";
import { FakePiRunner } from "../../src/agent/fake-runner.js";
import { TaskDB } from "../../src/state/task-db.js";
import { hadPaths } from "../../src/had/paths.js";
import {
  addAnnotation,
  listProposals,
  listVersions,
  readAnnotations,
  readVersion,
  writeSettings,
} from "../../src/had/index.js";
import { createAnchor } from "../../src/anchor/index.js";
import type { AgentEvent } from "../../src/agent/types.js";

const DOC = "# Plan\n\nWe store limits in Redis with a TTL.\n\nRollout goes to 5% first.\n";
const SENTENCE = "We store limits in Redis with a TTL.";

let dir: string;
let docPath: string;
let db: TaskDB;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "edit-modes-"));
  docPath = join(dir, "plan.md");
  await writeFile(docPath, DOC, "utf8");
  db = new TaskDB(hadPaths(docPath).stateDb);
});
afterEach(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true });
});

async function seedComment(doc = DOC, path = docPath, exact = SENTENCE) {
  const start = doc.indexOf(exact);
  await addAnnotation(path, {
    id: "c0001",
    type: "comment",
    anchor: createAnchor(doc, start, start + exact.length),
    status: "open",
    thread: "threads/c0001.md",
    session: "sessions/c0001.session.jsonl",
    createdAt: "t",
  });
}
const editing = (path = docPath) => writeSettings(path, { scope: "folder", agentEdit: "direct" });
const sink = (events: AgentEvent[]) => (e: AgentEvent) => void events.push(e);
const types = (events: AgentEvent[]) => events.map((e) => e.type).filter((t) => t !== "token");

describe("Suggesting mode (default)", () => {
  it("Improve leaves the document untouched and returns a pending proposal", async () => {
    await seedComment();
    const orch = new Orchestrator({ runner: new FakePiRunner([{ reply: "Limits live in Redis with a TTL." }]), db, now: () => "t" });
    const events: AgentEvent[] = [];

    const res = await orch.improve(docPath, "c0001", sink(events));

    expect(res.applied).toBeUndefined();
    expect(await readFile(docPath, "utf8")).toBe(DOC);
    expect((await listProposals(docPath, "c0001"))[0].status).toBe("pending");
    expect(types(events)).not.toContain("applied");
  });
});

describe("Editing mode", () => {
  it("Improve applies the rewrite on the spot, as a recorded + versioned proposal", async () => {
    await seedComment();
    await editing();
    const orch = new Orchestrator({ runner: new FakePiRunner([{ reply: "Limits live in Redis with a TTL." }]), db, now: () => "t" });
    const events: AgentEvent[] = [];

    const res = await orch.improve(docPath, "c0001", sink(events));

    expect(res).toMatchObject({ applied: true, newText: "Limits live in Redis with a TTL." });
    expect(await readFile(docPath, "utf8")).toBe(DOC.replace(SENTENCE, "Limits live in Redis with a TTL."));
    const [p] = await listProposals(docPath, "c0001");
    expect(p).toMatchObject({ id: res.proposalId, status: "approved" });
    expect(types(events)).toEqual(["applied"]);
    // Undo is "restore the backup version": the pre-edit document is preserved verbatim.
    const versions = await listVersions(docPath);
    expect(versions.map((v) => v.cause)).toEqual(["pre-apply-backup", "agent-edit"]);
    expect(await readVersion(docPath, versions[0].id)).toBe(DOC);
    expect((await readAnnotations(docPath)).annotations[0].status).toBe("resolved");
  });

  it("applies every directive's edit even though the agents ran in parallel on the same base", async () => {
    const doc = "# Plan\n\nAlpha line. [[ say beta ]]\n\nGamma line. [[ say delta ]]\n";
    await writeFile(docPath, doc, "utf8");
    await editing();
    const runner = new FakePiRunner([
      { reply: "done 1", proposal: { rationale: "r1", hunks: [{ oldText: "Alpha line. [[ say beta ]]", newText: "Alpha line. Beta." }] } },
      { reply: "done 2", proposal: { rationale: "r2", hunks: [{ oldText: "Gamma line. [[ say delta ]]", newText: "Gamma line. Delta." }] } },
    ]);
    const orch = new Orchestrator({ runner, db, now: () => "t" });
    const events: AgentEvent[] = [];

    const res = await orch.resolveDirectives(docPath, sink(events));

    expect(res).toMatchObject({ count: 2, proposed: true, applied: 2 });
    expect(await readFile(docPath, "utf8")).toBe("# Plan\n\nAlpha line. Beta.\n\nGamma line. Delta.\n");
    expect((await listProposals(docPath)).map((p) => p.status)).toEqual(["approved", "approved"]);
    expect(types(events)).toEqual(["applied", "applied"]);
  });

  it("applies review findings' edits and reports each as applied", async () => {
    await editing();
    const runner = new FakePiRunner([
      {
        reply: "Reviewed.",
        findings: [
          { anchorText: "Redis", comment: "name the store", edits: [{ oldText: "in Redis", newText: "in Redis (primary)" }] },
          { anchorText: "5% first", comment: "be specific", edits: [{ oldText: "5% first", newText: "5% of traffic first" }] },
          { anchorText: "Rollout", comment: "no edit, just a note" },
        ],
      },
    ]);
    const orch = new Orchestrator({ runner, db, now: () => "t" });

    const res = await orch.review(docPath, { stance: "none" });

    expect(res.findings.map((f) => f.applied ?? false)).toEqual([true, true, false]);
    expect(await readFile(docPath, "utf8")).toBe(
      "# Plan\n\nWe store limits in Redis (primary) with a TTL.\n\nRollout goes to 5% of traffic first.\n",
    );
  });

  it("an edit whose text is no longer in the document is NOT applied; it stays pending for the reviewer", async () => {
    await editing();
    const doc = "# Plan\n\nAlpha. [[ fix ]]\n";
    await writeFile(docPath, doc, "utf8");
    const runner = new FakePiRunner([
      { reply: "done", proposal: { rationale: "r", hunks: [{ oldText: "text that is not in the document", newText: "x" }] } },
    ]);
    const orch = new Orchestrator({ runner, db, now: () => "t" });
    const events: AgentEvent[] = [];

    const res = await orch.resolveDirectives(docPath, sink(events));

    expect(res).toMatchObject({ proposed: true, applied: 0 });
    expect(await readFile(docPath, "utf8")).toBe(doc);
    expect((await listProposals(docPath))[0].status).toBe("pending");
    const proposalEvent = events.find((e) => e.type === "proposal");
    expect(JSON.parse(proposalEvent!.text).applyError).toContain("hunk text not found");
    expect(await listVersions(docPath)).toEqual([]);
  });

  it("a full rewrite never clobbers a parallel edit: exactly one of the two lands, the other stays pending", async () => {
    await editing();
    const doc = "# Plan\n\nA. [[ one ]]\n\nB. [[ two ]]\n";
    await writeFile(docPath, doc, "utf8");
    const runner = new FakePiRunner([
      { reply: "1", proposal: { rationale: "r1", hunks: [{ oldText: "A. [[ one ]]", newText: "A done." }] } },
      { reply: "2", proposal: { rationale: "r2", fullRewrite: "# Plan\n\nrewritten from the ORIGINAL body\n" } },
    ]);
    const orch = new Orchestrator({ runner, db, now: () => "t" });

    const res = await orch.resolveDirectives(docPath);

    // The two agents run in parallel, so either may finish first — both outcomes are
    // correct, and in neither is one edit silently overwritten by the other:
    //  - hunk first: the rewrite's base is now stale → refused (it would erase "A done.");
    //  - rewrite first: the hunk's text is gone from the rewritten body → refused.
    expect(res.applied).toBe(1);
    expect(["# Plan\n\nA done.\n\nB. [[ two ]]\n", "# Plan\n\nrewritten from the ORIGINAL body\n"]).toContain(
      await readFile(docPath, "utf8"),
    );
    const statuses = (await listProposals(docPath)).map((p) => p.status).sort();
    expect(statuses).toEqual(["approved", "pending"]);
  });

  it("still validates HTML: an edit that would unbalance the markup is rejected, not written", async () => {
    const htmlPath = join(dir, "page.html");
    const html = "<html><body><p>We store limits in Redis.</p></body></html>";
    await writeFile(htmlPath, html, "utf8");
    const hdb = new TaskDB(hadPaths(htmlPath).stateDb);
    try {
      await seedComment(html, htmlPath, "We store limits in Redis.");
      await editing(htmlPath);
      const runner = new FakePiRunner([
        { reply: "", proposal: { rationale: "r", hunks: [{ oldText: "<p>We store limits in Redis.</p>", newText: "<p>Limits live in Redis." }] } },
      ]);
      const orch = new Orchestrator({ runner, db: hdb, now: () => "t" });

      const res = await orch.improve(htmlPath, "c0001");

      expect(res.applied).toBeUndefined();
      expect(await readFile(htmlPath, "utf8")).toBe(html);
      expect((await listProposals(htmlPath, "c0001"))[0]).toMatchObject({ status: "rejected" });
    } finally {
      hdb.close();
    }
  });

  it("conversation turns still never edit, whatever the mode", async () => {
    await seedComment();
    await editing();
    // A runner that (wrongly) volunteers a proposal on a discuss turn.
    const runner = new FakePiRunner([{ reply: "I think so.", proposal: { rationale: "r", hunks: [{ oldText: "Redis", newText: "Memcached" }] } }]);
    const orch = new Orchestrator({ runner, db, now: () => "t" });

    await orch.discuss(docPath, { threadId: "c0001", annotationId: "c0001", stance: "none", comment: "Redis?" });

    expect(runner.contextFor(db.get("c0001")!.piSessionId!)?.conversationOnly).toBe(true);
    // Even a proposal the runner should never have produced is only recorded, not applied.
    expect(await readFile(docPath, "utf8")).toBe(DOC);
    expect((await listProposals(docPath, "c0001")).map((p) => p.status)).toEqual(["pending"]);
  });
});
