import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Orchestrator } from "../../src/orchestrator/orchestrator.js";
import { listThreadTree } from "../../src/orchestrator/thread-tree.js";
import { FakePiRunner } from "../../src/agent/fake-runner.js";
import { TaskDB } from "../../src/state/task-db.js";
import { hadPaths } from "../../src/had/paths.js";
import { addAnnotation, createAnchor } from "../../src/index.js";

let dir: string;
let docPath: string;
let db: TaskDB;
const DOC = "We store limits in Redis with a TTL.\n";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "tree-"));
  docPath = join(dir, "plan.md");
  await writeFile(docPath, DOC, "utf8");
  db = new TaskDB(hadPaths(docPath).stateDb);
});
afterEach(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true });
});

async function seedComment() {
  const start = DOC.indexOf("Redis");
  const anchor = createAnchor(DOC, start, start + "Redis".length);
  await addAnnotation(docPath, {
    id: "c0001",
    type: "comment",
    anchor,
    status: "open",
    thread: "threads/c0001.md",
    session: "sessions/c0001.session.jsonl",
    createdAt: "2026-06-12T10:00:00.000Z",
  });
}

describe("listThreadTree", () => {
  it("returns every thread with lineage + a derived title", async () => {
    await seedComment(); // annotation c0001 on "Redis"
    const runner = new FakePiRunner([{ reply: "a1" }, { reply: "a2" }]);
    const orch = new Orchestrator({ runner, db, now: () => "t" });
    await orch.discuss(docPath, {
      threadId: "c0001",
      annotationId: "c0001",
      stance: "none",
      comment: "original question here",
    });
    const { branchThreadId } = await orch.branch(docPath, "c0001", 0, "revised question", {
      doc: "latest",
    });

    const tree = await listThreadTree(docPath);
    const root = tree.find((n) => n.id === "c0001")!;
    const br = tree.find((n) => n.id === branchThreadId)!;
    expect(root.parent).toBeUndefined();
    expect(root.title).toContain("original question");
    expect(root.turnCount).toBe(2); // you + agent
    expect(br.parent).toBe("c0001");
    expect(br.branchFromTurn).toBe(0);
    expect(br.baseVersion).toMatch(/^v\d+$/);
    expect(br.title).toContain("revised question");
  });

  it("returns [] for a doc with no threads", async () => {
    expect(await listThreadTree(docPath)).toEqual([]);
  });
});
