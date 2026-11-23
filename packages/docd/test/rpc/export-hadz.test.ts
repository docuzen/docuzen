// Exporting a document the sidecar has open: its task database runs in WAL mode, and the
// bundle copies state.db without the -wal file, so rows still in the log must be folded
// into state.db before the copy or the bundle silently loses them.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import AdmZip from "adm-zip";
import { RpcHandler } from "../../src/rpc/handler.js";
import { FakePiRunner } from "../../src/agent/fake-runner.js";
import { TaskDB } from "../../src/state/task-db.js";
import { hadPaths } from "../../src/had/paths.js";

let dir: string;
let handler: RpcHandler;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "rpc-export-"));
  handler = new RpcHandler({ runner: new FakePiRunner([]), now: () => "t" });
});
afterEach(async () => {
  handler.closeAll();
  await rm(dir, { recursive: true, force: true });
});

describe("exportHadz of an open document", () => {
  it("bundles task rows that are still in the write-ahead log", async () => {
    const docPath = join(dir, "plan.md");
    await writeFile(docPath, "# Plan\n", "utf8");
    const opened = await handler.handle({ id: "o", method: "openDoc", params: { docPath } });
    expect(opened.ok).toBe(true);

    // A second connection writes a row; the handler's connection stays open, so SQLite
    // does not checkpoint on close and the row lives only in state.db-wal.
    const stateDb = hadPaths(docPath).stateDb;
    const writer = new TaskDB(stateDb);
    writer.upsert({ threadId: "c0001", status: "responded", piSessionId: null });
    writer.close();

    const outPath = join(dir, "plan.hadz");
    const res = await handler.handle({ id: "e", method: "exportHadz", params: { docPath, outPath } });
    expect(res.ok).toBe(true);

    const entry = new AdmZip(outPath)
      .getEntries()
      .find((e) => e.entryName.endsWith(`/${basename(stateDb)}`) && !e.isDirectory);
    expect(entry).toBeDefined();
    const copy = join(dir, "bundled-state.db");
    await writeFile(copy, entry!.getData());
    const bundled = new TaskDB(copy);
    try {
      expect(bundled.get("c0001")?.status).toBe("responded");
    } finally {
      bundled.close();
    }
  });
});
