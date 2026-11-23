import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { transition } from "../../src/orchestrator/turn-status.js";
import { TaskDB } from "../../src/state/task-db.js";
import { hadPaths } from "../../src/had/paths.js";
import { initThread, readThread } from "../../src/index.js";

// Fixture setup mirrors the pattern at the top of orchestrator.test.ts: a temp .had
// fixture + an in-memory-backed TaskDB rooted at the doc's own state.db.
let dir: string;
let docPath: string;
let db: TaskDB;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "turn-status-"));
  docPath = join(dir, "plan.md");
  await writeFile(docPath, "We store limits in Redis with a TTL.\n", "utf8");
  db = new TaskDB(hadPaths(docPath).stateDb);
  // Seed a thread the way discuss() does via initThread, so frontmatter starts at
  // "running" exactly like a freshly-started discussion.
  await initThread(docPath, {
    id: "c0001",
    anchorExact: "Redis",
    stance: "critiquer",
    status: "running",
    piSession: "sessions/c0001.session.jsonl",
  });
});

afterEach(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true });
});

describe("transition", () => {
  // discuss()'s inline "running" write (orchestrator.ts) is TaskDB-only: the thread's
  // frontmatter status was already set to "running" by the preceding initThread call,
  // so the running transition never touches frontmatter again.
  it('writes only the TaskDB row for "running", matching discuss()\'s inline running write', async () => {
    await transition({ db, docPath }, "c0001", "running", { piSessionId: null });

    expect(db.get("c0001")).toMatchObject({
      threadId: "c0001",
      status: "running",
      piSessionId: null,
    });
    const thread = await readThread(docPath, "c0001");
    expect(thread.frontmatter.status).toBe("running");
  });

  // discuss()'s inline "error" write pairs updateThreadFrontmatter(status: "error") with
  // db.upsert({ status: "error", piSessionId: null }) — frontmatter first, then the DB row.
  it('writes both the TaskDB row and thread frontmatter for "error", matching discuss()\'s inline error pair', async () => {
    await transition({ db, docPath }, "c0001", "error", {
      piSessionId: null,
      frontmatter: true,
    });

    expect(db.get("c0001")).toMatchObject({
      threadId: "c0001",
      status: "error",
      piSessionId: null,
    });
    const thread = await readThread(docPath, "c0001");
    expect(thread.frontmatter.status).toBe("error");
  });

  // discuss()'s inline "responded" write pairs updateThreadFrontmatter(status: "responded")
  // with db.upsert({ status: "responded", piSessionId: sessionId }).
  it('writes both the TaskDB row (with piSessionId) and thread frontmatter for "responded", matching discuss()\'s inline responded pair', async () => {
    await transition({ db, docPath }, "c0001", "responded", {
      piSessionId: "sess-123",
      frontmatter: true,
    });

    expect(db.get("c0001")).toMatchObject({
      threadId: "c0001",
      status: "responded",
      piSessionId: "sess-123",
    });
    const thread = await readThread(docPath, "c0001");
    expect(thread.frontmatter.status).toBe("responded");
  });

  it('persists errorText on the TaskDB row when detail.error is provided for "error"', async () => {
    await transition({ db, docPath }, "c0001", "error", {
      piSessionId: null,
      frontmatter: true,
      error: "Error: boom, something broke",
    });

    expect(db.get("c0001")?.errorText).toBe("Error: boom, something broke");
  });

  it("clears errorText on a later non-error transition (retry succeeded)", async () => {
    await transition({ db, docPath }, "c0001", "error", {
      piSessionId: null,
      frontmatter: true,
      error: "Error: boom",
    });
    expect(db.get("c0001")?.errorText).toBe("Error: boom");

    await transition({ db, docPath }, "c0001", "responded", {
      piSessionId: "sess-2",
      frontmatter: true,
    });
    expect(db.get("c0001")?.errorText).toBeNull();
  });

  it("leaves frontmatter untouched when frontmatter is omitted, even for a terminal status", async () => {
    // Mirrors sites like review()'s solo db.upsert writes, which never call
    // updateThreadFrontmatter because the thread's frontmatter is (or will be) set
    // directly by an adjacent initThread call instead.
    await transition({ db, docPath }, "c0001", "responded", { piSessionId: "sess-1" });

    const thread = await readThread(docPath, "c0001");
    expect(thread.frontmatter.status).toBe("running"); // unchanged from the seed
    expect(db.get("c0001")?.status).toBe("responded");
  });

  // A comment deleted mid-turn takes its thread file with it. The turn's error
  // transition must still land in TaskDB, or the task reads "running" forever.
  it('still records an "error" in TaskDB when the thread file is gone', async () => {
    db.upsert({ threadId: "c0404", status: "running", piSessionId: null });
    await transition({ db, docPath }, "c0404", "error", {
      piSessionId: null,
      frontmatter: true,
      error: "boom",
    });
    expect(db.get("c0404")?.status).toBe("error");
    expect(db.get("c0404")?.errorText).toBe("boom");
  });

  it('records "responded" in TaskDB before reporting a missing thread file', async () => {
    db.upsert({ threadId: "c0405", status: "running", piSessionId: null });
    await expect(
      transition({ db, docPath }, "c0405", "responded", { piSessionId: "s", frontmatter: true }),
    ).rejects.toThrow(/ENOENT/);
    expect(db.get("c0405")?.status).toBe("responded");
  });
});
