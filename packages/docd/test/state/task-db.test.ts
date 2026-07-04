import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { TaskDB } from "../../src/state/task-db.js";

let dir: string;
let db: TaskDB;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "taskdb-"));
  db = new TaskDB(join(dir, "state.db"));
});
afterEach(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true });
});

describe("TaskDB", () => {
  it("returns null for an unknown thread", () => {
    expect(db.get("c0001")).toBeNull();
  });

  it("upserts and reads back a task", () => {
    db.upsert({ threadId: "c0001", status: "queued", piSessionId: null });
    const row = db.get("c0001");
    expect(row?.status).toBe("queued");
    expect(row?.piSessionId).toBeNull();
  });

  it("upsert updates status and session id in place", () => {
    db.upsert({ threadId: "c0001", status: "queued", piSessionId: null });
    db.upsert({ threadId: "c0001", status: "running", piSessionId: "fake-1" });
    expect(db.list()).toHaveLength(1);
    expect(db.get("c0001")?.status).toBe("running");
    expect(db.get("c0001")?.piSessionId).toBe("fake-1");
  });

  it("lists tasks filtered by status", () => {
    db.upsert({ threadId: "a", status: "running", piSessionId: "s1" });
    db.upsert({ threadId: "b", status: "responded", piSessionId: "s2" });
    expect(db.listByStatus("running").map((r) => r.threadId)).toEqual(["a"]);
  });

  it("creates its parent directory if it does not exist yet", () => {
    // .had/ may not exist when the orchestrator first opens a fresh doc.
    const nested = new TaskDB(join(dir, ".plan.md.had", "state.db"));
    nested.upsert({ threadId: "c0001", status: "queued", piSessionId: null });
    expect(nested.get("c0001")?.status).toBe("queued");
    nested.close();
  });

  it("persists across reopen (rebuildable state survives)", () => {
    db.upsert({ threadId: "c0001", status: "responded", piSessionId: "s1" });
    db.close();
    const reopened = new TaskDB(join(dir, "state.db"));
    expect(reopened.get("c0001")?.status).toBe("responded");
    reopened.close();
  });

  it("upserts and reads back errorText on an error row", () => {
    db.upsert({ threadId: "c0001", status: "error", piSessionId: null, errorText: "boom: connection refused" });
    expect(db.get("c0001")?.errorText).toBe("boom: connection refused");
  });

  it("defaults errorText to null when omitted", () => {
    db.upsert({ threadId: "c0001", status: "queued", piSessionId: null });
    expect(db.get("c0001")?.errorText).toBeNull();
  });

  it("clears a prior errorText when a later upsert omits it (retry succeeded)", () => {
    db.upsert({ threadId: "c0001", status: "error", piSessionId: null, errorText: "boom" });
    db.upsert({ threadId: "c0001", status: "responded", piSessionId: "s1" });
    expect(db.get("c0001")?.errorText).toBeNull();
  });

  it("migrates a DB created without the errorText column: old rows render as today, new upserts persist errorText", () => {
    // Simulate a DB written by a build that predates the error_text column.
    const oldDbPath = join(dir, "old.db");
    const raw = new Database(oldDbPath);
    raw.exec(`
      CREATE TABLE tasks (
        thread_id TEXT PRIMARY KEY,
        status TEXT NOT NULL CHECK(status IN ('queued','running','responded','error')),
        pi_session_id TEXT,
        updated_at TEXT NOT NULL
      );
    `);
    raw
      .prepare(`INSERT INTO tasks (thread_id, status, pi_session_id, updated_at) VALUES (?, ?, ?, ?)`)
      .run("legacy1", "responded", null, "2026-01-01T00:00:00.000Z");
    raw.close();

    const migrated = new TaskDB(oldDbPath);
    // A pre-existing row without errorText renders as today: present, but null.
    expect(migrated.get("legacy1")).toMatchObject({
      threadId: "legacy1",
      status: "responded",
      errorText: null,
    });
    // The migrated DB accepts new upserts with errorText and reads them back.
    migrated.upsert({ threadId: "c0001", status: "error", piSessionId: null, errorText: "boom" });
    expect(migrated.get("c0001")?.errorText).toBe("boom");
    migrated.close();
  });
});
