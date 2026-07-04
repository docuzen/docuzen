import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensurePointer,
  readPointer,
  initManifest,
  writeManifest,
  readManifest,
  addAnnotation,
  readAnnotations,
  updateAnnotation,
  initThread,
  appendTurn,
  readThread,
  snapshot,
  listVersions,
  createAnchor,
  resolveAnchor,
} from "../../src/index.js";

let dir: string;
let docPath: string;
const DOC = "We store limits in Redis with a 1-hour TTL and per-key config.\n";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "had-life-"));
  docPath = join(dir, "plan.md");
  await writeFile(docPath, DOC, "utf8");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("HAD lifecycle", () => {
  it("creates a comment, discusses, applies an edit, cuts a version", async () => {
    // 1. open: pointer + manifest
    await ensurePointer(docPath);
    expect(await readPointer(docPath)).toBe(".plan.md.had/");
    await writeManifest(docPath, await initManifest(docPath));
    expect((await readManifest(docPath))!.doc).toBe("plan.md");

    // 2. user highlights "Redis with a 1-hour TTL" and comments
    const start = DOC.indexOf("Redis with a 1-hour TTL");
    const exact = "Redis with a 1-hour TTL";
    const anchor = createAnchor(DOC, start, start + exact.length);
    await addAnnotation(docPath, {
      id: "c0001",
      type: "comment",
      anchor,
      status: "open",
      thread: "threads/c0001.md",
      session: "sessions/c0001.session.jsonl",
      createdAt: "2026-06-12T10:00:00.000Z",
    });

    // 3. discuss: thread with a couple of turns
    await initThread(docPath, {
      id: "c0001",
      anchorExact: anchor.exact,
      stance: "critiquer",
      status: "running",
      piSession: "sessions/c0001.session.jsonl",
    });
    await appendTurn(docPath, "c0001", {
      role: "you",
      timestamp: "2026-06-12T10:00:05.000Z",
      body: "Why Redis?",
    });
    await appendTurn(docPath, "c0001", {
      role: "agent",
      timestamp: "2026-06-12T10:00:20.000Z",
      meta: "critiquer · claude-fable-5",
      body: "In-memory works for one node.",
    });

    // 4. apply improve-text: pre-snapshot, edit, post-snapshot
    await snapshot(docPath, DOC, {
      cause: "pre-apply-backup",
      thread: "c0001",
      at: "2026-06-12T10:01:00.000Z",
    });
    const edited = DOC.replace(exact, "an in-memory token bucket");
    await writeFile(docPath, edited, "utf8");
    const v = await snapshot(docPath, edited, {
      cause: "agent-edit",
      thread: "c0001",
      at: "2026-06-12T10:01:01.000Z",
    });
    expect(v.id).toBe("v0002");

    // 5. anchor recompute: old anchor orphans, new anchor resolves
    expect(resolveAnchor(edited, anchor, { threshold: 0.85 })).toBeNull();
    const newStart = edited.indexOf("an in-memory token bucket");
    const newExact = "an in-memory token bucket";
    const newAnchor = createAnchor(edited, newStart, newStart + newExact.length);
    await updateAnnotation(docPath, "c0001", {
      anchor: newAnchor,
      status: "resolved",
    });
    expect(resolveAnchor(edited, newAnchor)).toEqual({
      start: newStart,
      end: newStart + newExact.length,
    });

    // 6. final state checks
    const ann = await readAnnotations(docPath);
    expect(ann.annotations[0].status).toBe("resolved");
    const thread = await readThread(docPath, "c0001");
    expect(thread.turns).toHaveLength(2);
    const versions = await listVersions(docPath);
    expect(versions.map((e) => e.cause)).toEqual([
      "pre-apply-backup",
      "agent-edit",
    ]);
  });
});
