import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Orchestrator } from "../../src/orchestrator/orchestrator.js";
import { FakePiRunner } from "../../src/agent/fake-runner.js";
import { TaskDB } from "../../src/state/task-db.js";
import { hadPaths } from "../../src/had/paths.js";
import {
  ensurePointer,
  readAnnotations,
  readThread,
  listProposals,
} from "../../src/index.js";
import type { AgentRunner } from "../../src/index.js";

let dir: string;
let docPath: string;
let db: TaskDB;
const DOC = "We store limits in Redis with a TTL.\n";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "review-"));
  docPath = join(dir, "plan.md");
  await writeFile(docPath, DOC, "utf8");
  await ensurePointer(docPath);
  db = new TaskDB(hadPaths(docPath).stateDb);
});
afterEach(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true });
});

describe("Orchestrator.review", () => {
  it("materializes findings as agent comments + threads + proposals and streams finding events", async () => {
    const runner = new FakePiRunner([
      {
        reply: "Reviewed.",
        findings: [
          {
            anchorText: "Redis",
            comment: "Why Redis here? An in-memory store may suffice for one node.",
            severity: "issue",
            kind: "risk",
            edits: [{ oldText: "Redis", newText: "an in-memory store" }],
          },
          {
            anchorText: "TTL",
            comment: "Clarify the TTL window.",
            severity: "suggestion",
            kind: "clarity",
          },
        ],
      },
    ]);
    const orch = new Orchestrator({ runner, db, now: () => "2026-06-23T00:00:00.000Z", author: "saurabh" });

    const events: { type: string; text: string }[] = [];
    const res = await orch.review(
      docPath,
      { stance: "critiquer", rubric: "Find risks and unclear passages." },
      (e) => events.push(e),
    );

    const anns = (await readAnnotations(docPath)).annotations;
    expect(anns).toHaveLength(2);
    expect(anns.every((a) => a.type === "comment")).toBe(true);
    expect(anns.every((a) => a.origin === "agent")).toBe(true);
    expect(anns.every((a) => a.review?.batchId === res.batchId)).toBe(true);
    expect(anns.find((a) => a.anchor.exact === "Redis")?.review?.severity).toBe("issue");

    // each finding's thread carries its comment so the margin card can show it
    const redisAnn = anns.find((a) => a.anchor.exact === "Redis")!;
    const thread = await readThread(docPath, redisAnn.id);
    expect(thread.turns.some((t) => t.body.includes("Why Redis here?"))).toBe(true);

    // only the finding with an edit yields a pending proposal
    const props = await listProposals(docPath);
    expect(props).toHaveLength(1);
    expect(props[0].threadId).toBe(redisAnn.id);
    expect(props[0].status).toBe("pending");
    expect(props[0].edits[0]).toEqual({ oldText: "Redis", newText: "an in-memory store" });

    // one finding event per finding, and the summary reports both
    expect(events.filter((e) => e.type === "finding")).toHaveLength(2);
    expect(res.findings).toHaveLength(2);
  });

  it("marks a finding orphaned when its anchorText is not found in the document", async () => {
    const runner = new FakePiRunner([
      {
        reply: "Reviewed.",
        findings: [{ anchorText: "NONEXISTENT PASSAGE", comment: "Floating note." }],
      },
    ]);
    const orch = new Orchestrator({ runner, db, now: () => "t" });
    await orch.review(docPath, { stance: "none" });
    const anns = (await readAnnotations(docPath)).annotations;
    expect(anns).toHaveLength(1);
    expect(anns[0].status).toBe("orphaned");
    expect(anns[0].anchor.exact).toBe("NONEXISTENT PASSAGE");
  });

  it("runs the agent in review mode (review tool offered, no direct edit)", async () => {
    const runner = new FakePiRunner([{ reply: "Reviewed.", findings: [] }]);
    const orch = new Orchestrator({ runner, db, now: () => "t" });
    await orch.review(docPath, { stance: "none", rubric: "focus" });
    const ctx = runner.contextFor("fake-1");
    expect(ctx?.reviewMode).toBe(true);
    expect(ctx?.allowEdit).toBeFalsy();
    expect(ctx?.comment).toContain("focus");
    // Phase 10: review is an explicit flow (unchanged in capability), not a conversation
    // turn — buildContext's reviewMode branch keeps conversationOnly false.
    expect(ctx?.conversationOnly).toBe(false);
  });

  it("records errorText on the TaskDB row when the review pass throws", async () => {
    const runner: AgentRunner = {
      async start() {
        throw new Error("model gateway 500");
      },
      async send() {
        throw new Error("unexpected send");
      },
      async cancel() {},
    };
    const orch = new Orchestrator({ runner, db, now: () => "t" });

    await expect(orch.review(docPath, { stance: "none" })).rejects.toThrow("model gateway 500");

    expect(db.get("review")?.status).toBe("error");
    expect(db.get("review")?.errorText).toBe("Error: model gateway 500");
  });

  it("streams live finding events from the agent runner as the tool is invoked, in addition to the materialized summary events", async () => {
    // Models the real pi-runner: its add_review_finding tool emits {type:"finding"} to
    // the sink AS SOON AS the agent calls it — mid-turn, before start() returns — so the
    // desktop's live "N findings so far" counter can tick while the model is still
    // working, not just once at the very end. FakePiRunner (the shared fake) resolves
    // synchronously with no mid-turn emission, so this test uses a small local fake that
    // emits before returning, exactly like the real tool-call-time wiring in pi-runner.ts.
    const liveTexts: string[] = [];
    const runner: AgentRunner = {
      async start(_ctx, onToken) {
        onToken?.({ type: "finding", text: "Why Redis here?" });
        liveTexts.push("Why Redis here?");
        onToken?.({ type: "finding", text: "Clarify the TTL window." });
        liveTexts.push("Clarify the TTL window.");
        return {
          sessionId: "live-1",
          turn: {
            reply: "Reviewed.",
            findings: [
              { anchorText: "Redis", comment: "Why Redis here?" },
              { anchorText: "TTL", comment: "Clarify the TTL window." },
            ],
          },
        };
      },
      async send() {
        throw new Error("unexpected send");
      },
      async cancel() {},
    };
    const orch = new Orchestrator({ runner, db, now: () => "t" });

    const events: { type: string; text: string }[] = [];
    await orch.review(docPath, { stance: "none" }, (e) => events.push(e));

    // The two live tool-call-time events arrived (this is what a real RPC emit stream
    // would forward to the desktop as {event:"finding"} frames while the agent works).
    expect(liveTexts).toEqual(["Why Redis here?", "Clarify the TTL window."]);
    const findingEvents = events.filter((e) => e.type === "finding");
    // Live events (2) plus the orchestrator's own materialized-finding events (2) — the
    // desktop counts every "finding" frame it receives, live or batched, so both land.
    expect(findingEvents).toHaveLength(4);
    expect(findingEvents[0].text).toBe("Why Redis here?");
    expect(findingEvents[1].text).toBe("Clarify the TTL window.");
  });
});
