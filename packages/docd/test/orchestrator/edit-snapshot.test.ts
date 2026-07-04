import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withEditSnapshot } from "../../src/orchestrator/edit-snapshot.js";
import { listVersions, readVersion } from "../../src/had/versions.js";

let dir: string;
let docPath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "edit-snapshot-"));
  docPath = join(dir, "plan.md");
  await writeFile(docPath, "ORIGINAL\n", "utf8");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("withEditSnapshot", () => {
  it("takes pre-apply-backup then agent-edit, in that order, around the mutation", async () => {
    const changed = await withEditSnapshot({ now: () => "t1" }, docPath, "c0001", async () => {
      await writeFile(docPath, "EDITED\n", "utf8");
    });

    expect(changed).toBe(true);
    const entries = await listVersions(docPath);
    expect(entries.map((e) => e.cause)).toEqual(["pre-apply-backup", "agent-edit"]);
    expect(await readVersion(docPath, entries[0].id)).toBe("ORIGINAL\n");
    expect(await readVersion(docPath, entries[1].id)).toBe("EDITED\n");
  });

  it("reads the pre-mutation content from disk when opts.before is omitted", async () => {
    await withEditSnapshot({ now: () => "t1" }, docPath, "c0001", async () => {
      await writeFile(docPath, "EDITED\n", "utf8");
    });
    const entries = await listVersions(docPath);
    expect(await readVersion(docPath, entries[0].id)).toBe("ORIGINAL\n");
  });

  it("uses opts.before verbatim instead of re-reading disk, when given", async () => {
    // Simulates approveProposal/applyLegacySpan, which already hold the pre-read body
    // in memory before this runs.
    const alreadyRead = await readFile(docPath, "utf8");
    await withEditSnapshot(
      { now: () => "t1" },
      docPath,
      "c0001",
      async () => {
        await writeFile(docPath, "EDITED\n", "utf8");
      },
      { before: alreadyRead },
    );
    const entries = await listVersions(docPath);
    expect(await readVersion(docPath, entries[0].id)).toBe(alreadyRead);
  });

  it("uses opts.after verbatim instead of re-reading disk, when given", async () => {
    // Simulates applyLegacySpan, which computes the exact post-mutation bytes in memory
    // before this runs. mutate() writes something DIFFERENT to disk than opts.after, so
    // if withEditSnapshot re-read disk instead of trusting opts.after, the recorded
    // snapshot would mismatch this assertion.
    await withEditSnapshot(
      { now: () => "t1" },
      docPath,
      "c0001",
      async () => {
        await writeFile(docPath, "DISK-CONTENT\n", "utf8");
      },
      { after: "SUPPLIED-AFTER\n" },
    );
    const entries = await listVersions(docPath);
    expect(await readVersion(docPath, entries[1].id)).toBe("SUPPLIED-AFTER\n");
  });

  it("reads the post-mutation content from disk when opts.after is omitted", async () => {
    await withEditSnapshot({ now: () => "t1" }, docPath, "c0001", async () => {
      await writeFile(docPath, "EDITED\n", "utf8");
    });
    const entries = await listVersions(docPath);
    expect(await readVersion(docPath, entries[1].id)).toBe("EDITED\n");
  });

  it("threads the given thread id through both version entries", async () => {
    await withEditSnapshot({ now: () => "t1" }, docPath, "c0042", async () => {
      await writeFile(docPath, "EDITED\n", "utf8");
    });
    const entries = await listVersions(docPath);
    expect(entries.every((e) => e.thread === "c0042")).toBe(true);
  });

  it("stamps each snapshot with deps.now() at call time", async () => {
    const stamps = ["t-before", "t-after"];
    let i = 0;
    await withEditSnapshot({ now: () => stamps[i++] }, docPath, "c0001", async () => {
      await writeFile(docPath, "EDITED\n", "utf8");
    });
    const entries = await listVersions(docPath);
    expect(entries.map((e) => e.timestamp)).toEqual(["t-before", "t-after"]);
  });

  it("takes the pre-apply-backup snapshot BEFORE mutate runs, so a failing mutation still leaves a backup", async () => {
    await expect(
      withEditSnapshot({ now: () => "t1" }, docPath, "c0001", async () => {
        throw new Error("mutation failed");
      }),
    ).rejects.toThrow("mutation failed");

    const entries = await listVersions(docPath);
    expect(entries.map((e) => e.cause)).toEqual(["pre-apply-backup"]);
  });

  describe("skipIfUnchanged (detectDirectEdit's case: the write already happened before this runs)", () => {
    it("skips both snapshots and returns false when the document didn't change", async () => {
      const before = await readFile(docPath, "utf8");
      const changed = await withEditSnapshot(
        { now: () => "t1" },
        docPath,
        "c0001",
        async () => {
          /* no-op: nothing wrote to docPath */
        },
        { before, skipIfUnchanged: true },
      );

      expect(changed).toBe(false);
      expect(await listVersions(docPath)).toEqual([]);
    });

    it("still records the pair and returns true when the document did change", async () => {
      const before = await readFile(docPath, "utf8");
      await writeFile(docPath, "EDITED\n", "utf8"); // the "already happened" external write
      const changed = await withEditSnapshot(
        { now: () => "t1" },
        docPath,
        "c0001",
        async () => {
          /* no-op: mutation already happened before this call */
        },
        { before, skipIfUnchanged: true },
      );

      expect(changed).toBe(true);
      const entries = await listVersions(docPath);
      expect(entries.map((e) => e.cause)).toEqual(["pre-apply-backup", "agent-edit"]);
      expect(await readVersion(docPath, entries[0].id)).toBe("ORIGINAL\n");
      expect(await readVersion(docPath, entries[1].id)).toBe("EDITED\n");
    });
  });
});
