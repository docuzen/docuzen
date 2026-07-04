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
  addAnnotation,
  createAnchor,
  readThread,
  listVersions,
} from "../../src/index.js";
import type { AgentRunner } from "../../src/index.js";

// The shared runTurn engine is exercised end-to-end by the discuss + reply suites in
// orchestrator.test.ts. The one spine branch those don't reach: an invoke failure on a
// LIVE session (reply's error path). It must carry that live sid — not null, which is all
// the discuss error test covers — into both the frontmatter and the db row, preserve the
// user turn so the exchange stays retryable, and rethrow the original error value.
let dir: string;
let docPath: string;
let db: TaskDB;
const DOC = "We store limits in Redis with a TTL.\n";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "turn-engine-"));
  docPath = join(dir, "plan.md");
  await writeFile(docPath, DOC, "utf8");
  await ensurePointer(docPath);
  db = new TaskDB(hadPaths(docPath).stateDb);
  const start = DOC.indexOf("Redis");
  await addAnnotation(docPath, {
    id: "c0001",
    type: "comment",
    anchor: createAnchor(DOC, start, start + "Redis".length),
    status: "open",
    thread: "threads/c0001.md",
    session: "sessions/c0001.session.jsonl",
    createdAt: "t",
  });
});
afterEach(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true });
});

describe("runTurn error path on a live session (reply)", () => {
  it("transitions to error with the live sid, preserves the user turn, and rethrows", async () => {
    // start() (discuss) establishes the live session "live-1"; send() (reply) then fails.
    const runner: AgentRunner = {
      async start() {
        return { sessionId: "live-1", turn: { reply: "Redis is for sharing." } };
      },
      async send() {
        throw new Error("send blew up");
      },
      hasSession(id) {
        return id === "live-1";
      },
    };
    const orch = new Orchestrator({ runner, db, now: () => "t" });
    await orch.discuss(docPath, {
      threadId: "c0001",
      annotationId: "c0001",
      stance: "none",
      comment: "Why Redis?",
    });
    expect(db.get("c0001")?.piSessionId).toBe("live-1");

    await expect(orch.reply(docPath, "c0001", "one node only")).rejects.toThrow("send blew up");

    // The error transition threaded the LIVE sid through (not null), to both stores.
    expect(db.get("c0001")?.status).toBe("error");
    expect(db.get("c0001")?.piSessionId).toBe("live-1");
    const thread = await readThread(docPath, "c0001");
    expect(thread.frontmatter.status).toBe("error");
    // you+agent from discuss, then the reply's user turn survives (retryable); no agent turn.
    expect(thread.turns.map((t) => t.role)).toEqual(["you", "agent", "you"]);
    expect(thread.turns.at(-1)?.body).toBe("one node only");
  });
});

// panel() doesn't route through runTurn at all (it calls the shared runAgentStep core
// directly, once per model, and owns its own single you-turn + running/responded/error
// bracketing around the whole per-model loop). These cases pin down the two behaviors most
// at risk from that split: a mid-loop failure must land the error transition on the LAST
// SUCCESSFUL model's session id (not null, not the failing call's own value) and must leave
// only that successful model's turn on the thread; the all-succeed path must still take
// exactly ONE "turn-base" doc-version snapshot for N models, not one per model.
describe("Orchestrator.panel mid-loop failure", () => {
  it("errors with the last successful model's session id and keeps only that model's turn", async () => {
    let calls = 0;
    const runner: AgentRunner = {
      async start() {
        calls++;
        if (calls === 1) return { sessionId: "sid-m1", turn: { reply: "answer from m1" } };
        throw new Error("model 2 blew up");
      },
      async send() {
        throw new Error("unexpected send");
      },
    };
    const orch = new Orchestrator({ runner, db, now: () => "t" });

    await expect(
      orch.panel(
        docPath,
        { threadId: "c0001", annotationId: "c0001", stance: "none", comment: "Why Redis?" },
        ["m1", "m2"],
      ),
    ).rejects.toThrow("model 2 blew up");

    // db row + thread frontmatter both carry m1's session id, not null and not m2's (there
    // is none — m2 never minted one).
    expect(db.get("c0001")?.status).toBe("error");
    expect(db.get("c0001")?.piSessionId).toBe("sid-m1");
    const thread = await readThread(docPath, "c0001");
    expect(thread.frontmatter.status).toBe("error");
    expect(thread.frontmatter.piSession).toBeDefined();

    // Exactly [you, agent(m1)] — no turn for the failing or unreached models.
    expect(thread.turns.map((t) => t.role)).toEqual(["you", "agent"]);
    expect(thread.turns[0].body).toBe("Why Redis?");
    expect(thread.turns[1].meta).toBe("m1");
    expect(thread.turns[1].body).toBe("answer from m1");
  });
});

describe("Orchestrator.panel all models succeed", () => {
  it("keeps one turn-base doc-version snapshot for N models", async () => {
    const runner = new FakePiRunner([{ reply: "a1" }, { reply: "a2" }, { reply: "a3" }]);
    const orch = new Orchestrator({ runner, db, now: () => "t" });

    await orch.panel(
      docPath,
      { threadId: "c0001", annotationId: "c0001", stance: "none", comment: "q" },
      ["m1", "m2", "m3"],
    );

    const versions = (await listVersions(docPath)).filter((v) => v.cause === "turn-base");
    expect(versions).toHaveLength(1);
    expect(db.get("c0001")?.status).toBe("responded");
    const thread = await readThread(docPath, "c0001");
    expect(thread.turns.map((t) => t.role)).toEqual(["you", "agent", "agent", "agent"]);
    expect(thread.turns.map((t) => t.meta)).toEqual([undefined, "m1", "m2", "m3"]);
    // Every turn (you + all three agent turns) is stamped with the SAME shared docVersion.
    const versionsUsed = new Set(thread.turns.map((t) => t.docVersion));
    expect(versionsUsed.size).toBe(1);
  });
});
