import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { chmod, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readJsonFile, updateJsonFile, withFileLock, writeFileAtomic } from "../../src/had/io.js";
import { createAnnotation, readAnnotations } from "../../src/had/annotations.js";
import { appendProposal, listProposals } from "../../src/had/proposals.js";
import { snapshot, listVersions, readVersion } from "../../src/had/versions.js";
import { appendTurn, initThread, readThread, updateThreadFrontmatter } from "../../src/had/thread.js";

let dir: string;
let docPath: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "had-io-"));
  docPath = join(dir, "plan.md");
  await writeFile(docPath, "# Plan\n", "utf8");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("writeFileAtomic", () => {
  it("replaces the file, creates parent dirs, and leaves no temp file behind", async () => {
    const path = join(dir, "nested", "a.json");
    await writeFileAtomic(path, "one");
    await writeFileAtomic(path, "two");
    expect(await readFile(path, "utf8")).toBe("two");
    expect(await readdir(join(dir, "nested"))).toEqual(["a.json"]);
  });

  it("keeps the permissions of the file it replaces", async () => {
    const path = join(dir, "secrets.json");
    await writeFile(path, "{}", { mode: 0o600 });
    await chmod(path, 0o600);
    await writeFileAtomic(path, '{"k":1}');
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });
});

describe("withFileLock", () => {
  it("runs holders of one key strictly one at a time, in arrival order", async () => {
    const log: string[] = [];
    const job = (name: string, ms: number) =>
      withFileLock("k", async () => {
        log.push(`${name}:start`);
        await new Promise((r) => setTimeout(r, ms));
        log.push(`${name}:end`);
      });
    await Promise.all([job("a", 20), job("b", 1), job("c", 5)]);
    expect(log).toEqual(["a:start", "a:end", "b:start", "b:end", "c:start", "c:end"]);
  });

  it("a failing holder releases the lock and only its own caller sees the error", async () => {
    const failed = withFileLock("k2", async () => {
      throw new Error("boom");
    });
    const next = withFileLock("k2", async () => "ran");
    await expect(failed).rejects.toThrow("boom");
    await expect(next).resolves.toBe("ran");
  });

  it("different keys do not wait on each other", async () => {
    let release!: () => void;
    const held = withFileLock("slow", () => new Promise<void>((r) => (release = r)));
    await expect(withFileLock("other", async () => "free")).resolves.toBe("free");
    release();
    await held;
  });
});

describe("updateJsonFile", () => {
  it("never loses an update under concurrency", async () => {
    const path = join(dir, "counter.json");
    await Promise.all(
      Array.from({ length: 50 }, () =>
        updateJsonFile(path, () => ({ n: 0 }), (c) => ({ next: { n: c.n + 1 }, result: undefined })),
      ),
    );
    expect(await readJsonFile(path, () => ({ n: -1 }))).toEqual({ n: 50 });
  });
});

// The same guarantee, observed through the real store modules.
describe("review-state store under concurrent writers", () => {
  it("concurrent annotation creation yields unique sequential ids and keeps every annotation", async () => {
    const created = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        createAnnotation(
          docPath,
          { kind: "comment", anchor: { exact: `a${i}`, prefix: "", suffix: "" } },
          { now: "t" },
        ),
      ),
    );
    const ids = created.map((a) => a.id);
    expect(new Set(ids).size).toBe(20);
    expect((await readAnnotations(docPath)).annotations).toHaveLength(20);
  });

  it("parallel agents appending proposals to one thread get distinct ids, none dropped", async () => {
    const made = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        appendProposal(docPath, "c0001", (id) => ({
          id,
          threadId: "c0001",
          edits: [{ oldText: `o${i}`, newText: "n" }],
          rationale: "",
          status: "pending",
          delivered: false,
          at: "t",
        })),
      ),
    );
    expect(new Set(made.map((p) => p.id)).size).toBe(12);
    expect(await listProposals(docPath, "c0001")).toHaveLength(12);
  });

  it("concurrent snapshots of different content never share a version id", async () => {
    const entries = await Promise.all(
      Array.from({ length: 8 }, (_, i) => snapshot(docPath, `content ${i}\n`, { cause: "manual-save", at: "t" })),
    );
    expect(new Set(entries.map((e) => e.id)).size).toBe(8);
    for (const [i, e] of entries.entries()) expect(await readVersion(docPath, e.id)).toBe(`content ${i}\n`);
    expect(await listVersions(docPath)).toHaveLength(8);
  });

  it("a status change racing appended turns loses neither", async () => {
    await initThread(docPath, { id: "c0001", anchorExact: "x", stance: "none", status: "running", piSession: "s" });
    await Promise.all([
      ...Array.from({ length: 10 }, (_, i) =>
        appendTurn(docPath, "c0001", { role: "you", timestamp: `t${i}`, body: `turn ${i}` }),
      ),
      updateThreadFrontmatter(docPath, "c0001", { status: "responded" }),
    ]);
    const thread = await readThread(docPath, "c0001");
    expect(thread.turns).toHaveLength(10);
    expect(thread.frontmatter.status).toBe("responded");
  });
});
