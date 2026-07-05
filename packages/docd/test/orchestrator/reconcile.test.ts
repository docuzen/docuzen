import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Orchestrator } from "../../src/orchestrator/orchestrator.js";
import { FakePiRunner } from "../../src/agent/fake-runner.js";
import { TaskDB } from "../../src/state/task-db.js";
import { hadPaths } from "../../src/had/paths.js";
import { initThread, appendTurn } from "../../src/index.js";

let dir: string;
let docPath: string;
let db: TaskDB;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "recon-"));
  docPath = join(dir, "plan.md");
  await writeFile(docPath, "# Plan\n", "utf8");
  db = new TaskDB(hadPaths(docPath).stateDb);
});
afterEach(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true });
});

describe("Orchestrator.reconcile", () => {
  it("finalizes a running task whose agent turn already landed in the thread file", async () => {
    // Simulate a crash: thread has you+agent turns but DB still says running.
    await initThread(docPath, {
      id: "c0001",
      anchorExact: "x",
      stance: "none",
      status: "running",
      piSession: "sessions/c0001.session.jsonl",
    });
    await appendTurn(docPath, "c0001", { role: "you", timestamp: "t1", body: "q" });
    await appendTurn(docPath, "c0001", {
      role: "agent",
      timestamp: "t2",
      meta: "none",
      body: "a",
    });
    db.upsert({ threadId: "c0001", status: "running", piSessionId: "fake-1" });

    const orch = new Orchestrator({
      runner: new FakePiRunner([]),
      db,
      now: () => "t3",
    });
    const result = await orch.reconcile(docPath);

    expect(db.get("c0001")?.status).toBe("responded");
    expect(result.finalized).toContain("c0001");
  });

  it("marks a running task with no completed agent turn as error (needs retry)", async () => {
    await initThread(docPath, {
      id: "c0002",
      anchorExact: "x",
      stance: "none",
      status: "running",
      piSession: "sessions/c0002.session.jsonl",
    });
    await appendTurn(docPath, "c0002", { role: "you", timestamp: "t1", body: "q" });
    db.upsert({ threadId: "c0002", status: "running", piSessionId: "fake-1" });

    const orch = new Orchestrator({
      runner: new FakePiRunner([]),
      db,
      now: () => "t3",
    });
    const result = await orch.reconcile(docPath);

    expect(db.get("c0002")?.status).toBe("error");
    expect(db.get("c0002")?.errorText).toBe("interrupted — sidecar restarted");
    expect(result.errored).toContain("c0002");
  });

  it("isolates a row whose thread file is missing (sidecar killed between running-row insert and initThread) — errors that row but still reconciles the rest", async () => {
    // "Bad" row: TaskDB says running, but there is no thread file on disk at all —
    // the real-world sequence is review() marking the row running BEFORE initThread
    // creates the thread file, and the sidecar dying in between.
    db.upsert({ threadId: "missing1", status: "running", piSessionId: "fake-1" });

    // "Good" row: a normal running task whose thread file has a completed agent turn,
    // seeded alongside the bad one so we can prove one bad row doesn't block the rest.
    await initThread(docPath, {
      id: "c0004",
      anchorExact: "x",
      stance: "none",
      status: "running",
      piSession: "sessions/c0004.session.jsonl",
    });
    await appendTurn(docPath, "c0004", { role: "you", timestamp: "t1", body: "q" });
    await appendTurn(docPath, "c0004", {
      role: "agent",
      timestamp: "t2",
      meta: "none",
      body: "a",
    });
    db.upsert({ threadId: "c0004", status: "running", piSessionId: "fake-1" });

    const orch = new Orchestrator({
      runner: new FakePiRunner([]),
      db,
      now: () => "t3",
    });

    // Must resolve, not reject, even though "missing1" has no thread file.
    const result = await orch.reconcile(docPath);

    expect(db.get("missing1")?.status).toBe("error");
    expect(db.get("missing1")?.errorText).toBe("interrupted — sidecar restarted");
    expect(result.errored).toContain("missing1");

    expect(db.get("c0004")?.status).toBe("responded");
    expect(result.finalized).toContain("c0004");
  });

  it("survives the fallback error write itself failing (SQLITE_BUSY-style) — still resolves and finalizes the remaining rows", async () => {
    // Bad row seeded FIRST (listByStatus returns rows in insertion order) so its
    // failure path runs before the good row — proving the loop continues past it.
    db.upsert({ threadId: "missing2", status: "running", piSessionId: "fake-1" });

    await initThread(docPath, {
      id: "c0005",
      anchorExact: "x",
      stance: "none",
      status: "running",
      piSession: "sessions/c0005.session.jsonl",
    });
    await appendTurn(docPath, "c0005", { role: "you", timestamp: "t1", body: "q" });
    await appendTurn(docPath, "c0005", {
      role: "agent",
      timestamp: "t2",
      meta: "none",
      body: "a",
    });
    db.upsert({ threadId: "c0005", status: "running", piSessionId: "fake-1" });

    // Make the bad row's fallback "error" write itself blow up (as a busy/closed
    // DB would); every other write goes through to the real DB.
    const realUpsert = db.upsert.bind(db);
    db.upsert = (t) => {
      if (t.threadId === "missing2" && t.status === "error") {
        throw new Error("SQLITE_BUSY: database is locked");
      }
      realUpsert(t);
    };

    const orch = new Orchestrator({
      runner: new FakePiRunner([]),
      db,
      now: () => "t3",
    });

    // Must STILL resolve even though the bad row's fallback status write throws.
    const result = await orch.reconcile(docPath);

    expect(db.get("c0005")?.status).toBe("responded");
    expect(result.finalized).toContain("c0005");
    // The failed write left the bad row running (it'll be retried next reconcile),
    // and it isn't reported as errored since the transition never landed.
    expect(db.get("missing2")?.status).toBe("running");
    expect(result.errored).not.toContain("missing2");
  });

  it("leaves already-responded tasks alone", async () => {
    db.upsert({ threadId: "c0003", status: "responded", piSessionId: "fake-1" });
    const orch = new Orchestrator({
      runner: new FakePiRunner([]),
      db,
      now: () => "t3",
    });
    const result = await orch.reconcile(docPath);
    expect(result.finalized).toEqual([]);
    expect(result.errored).toEqual([]);
    expect(db.get("c0003")?.status).toBe("responded");
  });
});
