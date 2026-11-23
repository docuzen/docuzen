// Importing a .hadz over a document the sidecar already has open replaces that
// document's review state, including its SQLite task database. The handler must let go
// of the old database first, or it keeps reading (and writing) a deleted file.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RpcHandler } from "../../src/rpc/handler.js";
import { FakePiRunner } from "../../src/agent/fake-runner.js";
import { TaskDB } from "../../src/state/task-db.js";
import { hadPaths } from "../../src/had/paths.js";
import { exportHadz } from "../../src/had/bundle.js";

let dir: string;
let handler: RpcHandler;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "rpc-import-"));
  handler = new RpcHandler({ runner: new FakePiRunner([]), now: () => "t" });
});
afterEach(async () => {
  handler.closeAll();
  await rm(dir, { recursive: true, force: true });
});

async function tasks(docPath: string): Promise<{ threadId: string; status: string }[]> {
  const res = await handler.handle({ id: "lt", method: "listTasks", params: { docPath } });
  if (!res.ok) throw new Error(res.error);
  return res.result as { threadId: string; status: string }[];
}

describe("importHadz over an open document (M11)", () => {
  it("the task list afterwards is the imported one, not the replaced database", async () => {
    // A bundle from someone else, whose task database knows thread c0007.
    const theirs = join(dir, "theirs", "plan.md");
    await mkdir(join(dir, "theirs"));
    await writeFile(theirs, "# Plan\n", "utf8");
    const seed = new TaskDB(hadPaths(theirs).stateDb);
    seed.upsert({ threadId: "c0007", status: "responded", piSessionId: null });
    seed.close();
    const { path: hadz } = await exportHadz(theirs);

    // The same file name, already open here (with its own task database).
    const mine = join(dir, "mine", "plan.md");
    await mkdir(join(dir, "mine"));
    await writeFile(mine, "# Plan\n", "utf8");
    const opened = await handler.handle({ id: "o", method: "openDoc", params: { docPath: mine } });
    expect(opened.ok).toBe(true);
    expect(await tasks(mine)).toEqual([]);

    const imported = await handler.handle({ id: "i", method: "importHadz", params: { hadzPath: hadz, destDir: join(dir, "mine") } });
    expect(imported.ok).toBe(true);

    expect((await tasks(mine)).map((t) => t.threadId)).toEqual(["c0007"]);
  });
});
