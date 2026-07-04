import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Orchestrator } from "../../src/orchestrator/orchestrator.js";
import { FakePiRunner } from "../../src/agent/fake-runner.js";
import { TaskDB } from "../../src/state/task-db.js";
import { hadPaths } from "../../src/had/paths.js";
import {
  ensurePointer,
  addAnnotation,
  addProposal,
  createAnchor,
  readThread,
  readAnnotations,
  listVersions,
  initThread,
  appendTurn,
  writeSettings,
  listProposals,
  HarnessRegistry,
  PI_CAPABILITIES,
} from "../../src/index.js";
import type { AgentRunner } from "../../src/index.js";

let dir: string;
let docPath: string;
let db: TaskDB;
const DOC = "We store limits in Redis with a TTL.\n";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "orch-"));
  docPath = join(dir, "plan.md");
  await writeFile(docPath, DOC, "utf8");
  await ensurePointer(docPath);
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

describe("Orchestrator.discuss", () => {
  it("runs a comment to responded: thread file gets you+agent turns, task is responded", async () => {
    await seedComment();
    const runner = new FakePiRunner([{ reply: "Redis is for multi-node sharing." }]);
    const orch = new Orchestrator({ runner, db, now: () => "2026-06-12T10:00:05.000Z" });

    await orch.discuss(docPath, {
      threadId: "c0001",
      annotationId: "c0001",
      stance: "critiquer",
      comment: "Why Redis?",
    });

    expect(db.get("c0001")?.status).toBe("responded");
    expect(db.get("c0001")?.piSessionId).toMatch(/.+/);
    const thread = await readThread(docPath, "c0001");
    expect(thread.frontmatter.stance).toBe("critiquer");
    expect(thread.turns.map((t) => t.role)).toEqual(["you", "agent"]);
    expect(thread.turns[1].body).toBe("Redis is for multi-node sharing.");
  });

  it("keeps a failed discussion retryable by preserving the user turn and error status", async () => {
    await seedComment();
    const runner: AgentRunner = {
      async start() {
        throw new Error("agent timed out");
      },
      async send() {
        throw new Error("unexpected send");
      },
      async cancel() {},
    };
    const orch = new Orchestrator({ runner, db, now: () => "2026-06-12T10:00:05.000Z" });

    await expect(
      orch.discuss(docPath, {
        threadId: "c0001",
        annotationId: "c0001",
        stance: "critiquer",
        comment: "Why Redis?",
      }),
    ).rejects.toThrow("agent timed out");

    expect(db.get("c0001")?.status).toBe("error");
    // errorText: the thrown error's String(e) first line, for the Agents panel to surface.
    expect(db.get("c0001")?.errorText).toBe("Error: agent timed out");
    const thread = await readThread(docPath, "c0001");
    expect(thread.frontmatter.status).toBe("error");
    expect(thread.turns.map((t) => t.role)).toEqual(["you"]);
    expect(thread.turns[0].body).toBe("Why Redis?");
  });

  // task-0: pi-runner.ts's finishTurn() now throws this exact message instead of silently
  // resolving with `{ reply: "" }` when a turn produced no reply, proposal, or findings and
  // no error was captured either. This proves that honest failure propagates through the
  // SAME runTurn → transition(error) → errorText path as any other runner error — no agent
  // turn with an empty body gets appended, and the thread stays retryable.
  it("propagates PiRunner's honest 'no content, no error' failure instead of a silent empty success", async () => {
    await seedComment();
    const runner: AgentRunner = {
      async start() {
        throw new Error("pi returned no reply, proposal, or findings, and reported no error");
      },
      async send() {
        throw new Error("unexpected send");
      },
      async cancel() {},
    };
    const orch = new Orchestrator({ runner, db, now: () => "2026-06-12T10:00:05.000Z" });

    await expect(
      orch.discuss(docPath, {
        threadId: "c0001",
        annotationId: "c0001",
        stance: "critiquer",
        comment: "Why Redis?",
      }),
    ).rejects.toThrow("pi returned no reply, proposal, or findings, and reported no error");

    expect(db.get("c0001")?.status).toBe("error");
    expect(db.get("c0001")?.errorText).toBe(
      "Error: pi returned no reply, proposal, or findings, and reported no error",
    );
    const thread = await readThread(docPath, "c0001");
    expect(thread.frontmatter.status).toBe("error");
    expect(thread.turns.map((t) => t.role)).toEqual(["you"]);
  });

  it("keeps replies on the thread's persisted harness even when document settings change", async () => {
    await seedComment();
    const pi = new FakePiRunner([{ reply: "pi should not answer" }]);
    const codex = new FakePiRunner([
      { reply: "codex started" },
      { reply: "codex continued" },
    ]);
    const registry = new HarnessRegistry("pi");
    registry.register({
      id: "pi",
      label: "Pi",
      runner: pi,
      capabilities: PI_CAPABILITIES,
      available: true,
    });
    registry.register({
      id: "codex",
      label: "Codex",
      runner: codex,
      capabilities: { ...PI_CAPABILITIES, webSearch: "harness-managed" },
      available: true,
    });
    const orch = new Orchestrator({ registry, db, now: () => "2026-06-12T10:00:05.000Z" });

    await writeSettings(docPath, { scope: "folder", harness: "codex" });
    await orch.discuss(docPath, {
      threadId: "c0001",
      annotationId: "c0001",
      stance: "none",
      comment: "Start on Codex",
    });
    await writeSettings(docPath, { scope: "folder", harness: "pi" });
    await orch.reply(docPath, "c0001", "Keep going");

    const thread = await readThread(docPath, "c0001");
    expect(thread.frontmatter.harness).toBe("codex");
    expect(codex.sentMessages).toEqual(["Keep going"]);
    expect(pi.sentMessages).toEqual([]);
    expect(thread.turns.at(-1)?.body).toBe("codex continued");
  });
});

describe("Orchestrator.panel", () => {
  it("runs the comment through each model and persists one agent turn per model", async () => {
    await seedComment();
    const runner = new FakePiRunner([{ reply: "answer from A" }, { reply: "answer from B" }]);
    const orch = new Orchestrator({ runner, db, now: () => "t" });
    await orch.panel(docPath, { threadId: "c0001", annotationId: "c0001", stance: "none", comment: "Why Redis?" },
      ["litellm/gpt-5.5", "litellm/claude-opus-4-8"]);
    const thread = await readThread(docPath, "c0001");
    expect(thread.turns.map((t) => t.role)).toEqual(["you", "agent", "agent"]);
    expect(thread.turns[1].meta).toContain("litellm/gpt-5.5");
    expect(thread.turns[2].meta).toContain("litellm/claude-opus-4-8");
    expect(thread.turns[1].body).toBe("answer from A");
    expect(thread.turns[2].body).toBe("answer from B");
  });

  it("tags streamed tokens with the producing model", async () => {
    await seedComment();
    const runner = new FakePiRunner([{ reply: "A1" }, { reply: "B1" }]);
    const orch = new Orchestrator({ runner, db, now: () => "t" });
    const seen: (string | undefined)[] = [];
    await orch.panel(docPath, { threadId: "c0001", annotationId: "c0001", stance: "none", comment: "q" },
      ["litellm/gpt-5.5", "litellm/claude-opus-4-8"],
      (e) => { if (e.type === "token") seen.push(e.model); });
    expect(seen).toContain("litellm/gpt-5.5");
    expect(seen).toContain("litellm/claude-opus-4-8");
  });

  it("records errorText on the TaskDB row when a model in the fan-out throws", async () => {
    await seedComment();
    const runner: AgentRunner = {
      async start() {
        throw new Error("model gateway 500");
      },
      async send() {
        throw new Error("unexpected send");
      },
      async cancel() {},
    };
    const orch = new Orchestrator({ runner, db, now: () => "t" });

    await expect(
      orch.panel(docPath, { threadId: "c0001", annotationId: "c0001", stance: "none", comment: "q" }, [
        "litellm/gpt-5.5",
      ]),
    ).rejects.toThrow("model gateway 500");

    expect(db.get("c0001")?.status).toBe("error");
    expect(db.get("c0001")?.errorText).toBe("Error: model gateway 500");
  });
});

describe("Orchestrator.cancel", () => {
  it("aborts the runner session for a thread by its cancelKey", async () => {
    await seedComment();
    const runner = new FakePiRunner([{ reply: "ok" }]);
    const orch = new Orchestrator({ runner, db, now: () => "t" });
    await orch.discuss(docPath, { threadId: "c0001", annotationId: "c0001", stance: "none", comment: "q" });
    await orch.cancel(docPath, "c0001");
    expect(runner.cancelled).toContain(`${docPath}#c0001`);
  });

  it("stamps the cancelKey onto the agent context", async () => {
    await seedComment();
    const runner = new FakePiRunner([{ reply: "ok" }]);
    const orch = new Orchestrator({ runner, db, now: () => "t" });
    await orch.discuss(docPath, { threadId: "c0001", annotationId: "c0001", stance: "none", comment: "q" });
    const sid = db.get("c0001")!.piSessionId!;
    expect(runner.contextFor(sid)?.cancelKey).toBe(`${docPath}#c0001`);
  });
});

describe("Orchestrator.discuss model selection", () => {
  it("threads modelId into the agent context and persists it on the thread", async () => {
    await seedComment();
    const runner = new FakePiRunner([{ reply: "ok" }]);
    const orch = new Orchestrator({ runner, db, now: () => "t" });
    await orch.discuss(docPath, { threadId: "c0001", annotationId: "c0001", stance: "none", comment: "q", modelId: "anthropic/claude" });
    const sid = db.get("c0001")!.piSessionId!;
    expect(runner.contextFor(sid)?.modelId).toBe("anthropic/claude");
    expect((await readThread(docPath, "c0001")).frontmatter.model).toBe("anthropic/claude");
  });
});

describe("Orchestrator.discuss reasoning", () => {
  it("persists the agent's reasoning with the agent turn", async () => {
    await seedComment();
    const runner = new FakePiRunner([
      { reply: "In-memory is fine for one node.", thinking: "Single node → no sharing needed." },
    ]);
    const orch = new Orchestrator({ runner, db, now: () => "t" });
    await orch.discuss(docPath, {
      threadId: "c0001",
      annotationId: "c0001",
      stance: "none",
      comment: "Why Redis?",
    });
    const thread = await readThread(docPath, "c0001");
    const agentTurn = thread.turns.find((t) => t.role === "agent");
    expect(agentTurn?.thinking).toBe("Single node → no sharing needed.");
  });
});

describe("Orchestrator.discuss context", () => {
  it("gives the agent the full doc, its path, and a digest of other annotations", async () => {
    await seedComment(); // c0001 on "Redis"
    // a second annotation with its own discussion
    const s = DOC.indexOf("TTL");
    await addAnnotation(docPath, {
      id: "c0002",
      type: "comment",
      anchor: createAnchor(DOC, s, s + 3),
      status: "open",
      thread: "threads/c0002.md",
      session: "sessions/c0002.session.jsonl",
      createdAt: "t",
    });
    await initThread(docPath, {
      id: "c0002",
      anchorExact: "TTL",
      stance: "none",
      status: "open",
      piSession: "sessions/c0002.session.jsonl",
    });
    await appendTurn(docPath, "c0002", { role: "you", timestamp: "t", body: "Why 1 hour?" });

    const runner = new FakePiRunner([{ reply: "ok" }]);
    const orch = new Orchestrator({ runner, db, now: () => "t" });
    await orch.discuss(docPath, {
      threadId: "c0001",
      annotationId: "c0001",
      stance: "none",
      comment: "Why Redis?",
    });

    const sid = db.get("c0001")!.piSessionId!;
    const ctx = runner.contextFor(sid)!;
    expect(ctx.docText).toContain("We store limits in Redis");
    expect(ctx.docPath).toBe(docPath);
    expect(ctx.annotationsDigest).toContain("Why 1 hour?");
    expect(ctx.annotationsDigest).toContain("TTL");
  });
});

describe("Orchestrator.discuss streaming", () => {
  it("forwards reply tokens to the onToken sink", async () => {
    await seedComment();
    const runner = new FakePiRunner([{ reply: "Redis is for sharing." }]);
    const orch = new Orchestrator({ runner, db, now: () => "2026-06-12T10:00:05.000Z" });
    const chunks: string[] = [];
    await orch.discuss(
      docPath,
      { threadId: "c0001", annotationId: "c0001", stance: "none", comment: "Why Redis?" },
      (e) => chunks.push(e.text),
    );
    expect(chunks.join("")).toBe("Redis is for sharing.");
  });
});

describe("Orchestrator.reply", () => {
  it("appends a user turn and the agent's response, staying responded", async () => {
    await seedComment();
    const runner = new FakePiRunner([
      { reply: "Redis is for sharing." },
      { reply: "Fair — in-memory is fine for one node." },
    ]);
    const orch = new Orchestrator({ runner, db, now: () => "2026-06-12T10:00:05.000Z" });
    await orch.discuss(docPath, {
      threadId: "c0001",
      annotationId: "c0001",
      stance: "critiquer",
      comment: "Why Redis?",
    });

    await orch.reply(docPath, "c0001", "We only have one node.");

    const thread = await readThread(docPath, "c0001");
    expect(thread.turns.map((t) => t.role)).toEqual(["you", "agent", "you", "agent"]);
    expect(thread.turns[3].body).toBe("Fair — in-memory is fine for one node.");
    expect(db.get("c0001")?.status).toBe("responded");
  });
});

describe("Orchestrator.reply reopen-resume", () => {
  it("rebuilds a session from the transcript when the pi session is gone", async () => {
    await seedComment();
    const runner = new FakePiRunner([{ reply: "a1" }, { reply: "a2" }]);
    const orch = new Orchestrator({ runner, db, now: () => "t" });
    await orch.discuss(docPath, { threadId: "c0001", annotationId: "c0001", stance: "none", comment: "q1" });
    // simulate doc reopen: the thread + db row persist, but the live pi session is gone
    db.upsert({ threadId: "c0001", status: "responded", piSessionId: null });

    await orch.reply(docPath, "c0001", "follow-up");

    const sid = db.get("c0001")!.piSessionId!;
    expect(sid).toMatch(/.+/);                                  // a fresh session was started
    const hist = runner.contextFor(sid)?.history?.map((h) => h.body) ?? [];
    expect(hist).toContain("q1");                               // prior turns replayed
    expect(hist).toContain("a1");
    expect((await readThread(docPath, "c0001")).turns.map((t) => t.body))
      .toEqual(["q1", "a1", "follow-up", "a2"]);                // continued, not restarted
    expect(db.get("c0001")?.status).toBe("responded");
  });

  it("reply resumes from transcript when the stored session is stale (sidecar restart)", async () => {
    await seedComment();
    const runner = new FakePiRunner([{ reply: "a1" }, { reply: "a2" }]);
    const orch = new Orchestrator({ runner, db, now: () => "t" });
    await orch.discuss(docPath, { threadId: "c0001", annotationId: "c0001", stance: "none", comment: "q1" });
    // simulate restart: the db still has a session id, but it's one the runner never started
    db.upsert({ threadId: "c0001", status: "responded", piSessionId: "pi-stale-999" });
    await orch.reply(docPath, "c0001", "follow-up");
    const sid = db.get("c0001")!.piSessionId!;
    expect(sid).not.toBe("pi-stale-999");                 // a fresh session replaced the stale id
    expect(runner.hasSession(sid)).toBe(true);            // and it's live
    const hist = runner.contextFor(sid)?.history?.map((h) => h.body) ?? [];
    expect(hist).toContain("q1");                          // resumed with prior transcript
    expect((await readThread(docPath, "c0001")).turns.map((t) => t.body)).toEqual(["q1", "a1", "follow-up", "a2"]);
  });
});

describe("Orchestrator.reply into an annotation-less thread", () => {
  it("replies into a seeded directive-style thread (no annotation) and appends turns", async () => {
    const runner = new FakePiRunner([{ reply: "Directive follow-up done." }]);
    const orch = new Orchestrator({ runner, db, now: () => "t" });
    // Mirror what resolveDirectives leaves behind: a real thread with you+agent turns,
    // but NO addAnnotation call — directive-N threads never get a persisted annotation.
    await initThread(docPath, {
      id: "directive-1",
      anchorExact: "[[ make it formal ]]",
      stance: "none",
      status: "responded",
      piSession: "sessions/directive-1.session.jsonl",
      harness: "pi",
    });
    await appendTurn(docPath, "directive-1", {
      role: "you",
      timestamp: "t0",
      body: "Resolve inline directive:\n[[ make it formal ]]\n\nMake it formal.",
    });
    await appendTurn(docPath, "directive-1", {
      role: "agent",
      timestamp: "t0",
      meta: "directives",
      body: "done",
    });
    expect(
      (await readAnnotations(docPath)).annotations.find((a) => a.id === "directive-1"),
    ).toBeUndefined();

    await orch.reply(docPath, "directive-1", "Actually, keep it casual.");

    const thread = await readThread(docPath, "directive-1");
    expect(thread.turns.map((t) => t.role)).toEqual(["you", "agent", "you", "agent"]);
    expect(thread.turns[3].body).toBe("Directive follow-up done.");
    expect(db.get("directive-1")?.status).toBe("responded");
  });

  it("replies into a seeded review-umbrella-style thread (no annotation) and appends turns", async () => {
    const runner = new FakePiRunner([{ reply: "Noted, revisiting the review." }]);
    const orch = new Orchestrator({ runner, db, now: () => "t" });
    // Mirror what review() leaves behind for the umbrella thread: a real thread with
    // you+agent turns, but no addAnnotation call for "review" itself (only per-finding
    // comment threads get one).
    await initThread(docPath, {
      id: "review",
      anchorExact: "",
      stance: "none",
      status: "responded",
      piSession: "sessions/review.session.jsonl",
      harness: "pi",
    });
    await appendTurn(docPath, "review", {
      role: "you",
      timestamp: "t0",
      body: "Review the document for risks, gaps, unclear passages, and concrete improvements.",
    });
    await appendTurn(docPath, "review", {
      role: "agent",
      timestamp: "t0",
      meta: "review",
      body: "(findings filed as comments)",
    });
    expect(
      (await readAnnotations(docPath)).annotations.find((a) => a.id === "review"),
    ).toBeUndefined();

    await orch.reply(docPath, "review", "Anything about the TTL choice?");

    const thread = await readThread(docPath, "review");
    expect(thread.turns.map((t) => t.role)).toEqual(["you", "agent", "you", "agent"]);
    expect(thread.turns[3].body).toBe("Noted, revisiting the review.");
    expect(db.get("review")?.status).toBe("responded");
  });

  it("still errors replying into a thread that doesn't exist", async () => {
    const runner = new FakePiRunner([]); // would throw if start/send were called
    const orch = new Orchestrator({ runner, db, now: () => "t" });
    await expect(orch.reply(docPath, "does-not-exist", "hello")).rejects.toThrow();
  });

  it("routes a codex-harness-style thread (hasSession false) through resumeFromTranscript without an annotation", async () => {
    const codex: AgentRunner = {
      async start(_ctx, onToken) {
        onToken?.({ type: "token", text: "resumed via codex" });
        return { sessionId: "codex-1", turn: { reply: "resumed via codex" } };
      },
      async send() {
        throw new Error(
          "Codex harness does not keep live Docuzen sessions; replay the thread with start()",
        );
      },
      async cancel() {},
      // Real CodexRunner always reports no live session — every reply resumes from transcript.
      hasSession() {
        return false;
      },
    };
    const registry = new HarnessRegistry("codex");
    registry.register({
      id: "codex",
      label: "Codex",
      runner: codex,
      capabilities: PI_CAPABILITIES,
      available: true,
    });
    const orch = new Orchestrator({ registry, db, now: () => "t" });

    await initThread(docPath, {
      id: "directive-1",
      anchorExact: "[[ x ]]",
      stance: "none",
      status: "responded",
      piSession: "sessions/directive-1.session.jsonl",
      harness: "codex",
    });
    await appendTurn(docPath, "directive-1", { role: "you", timestamp: "t0", body: "Resolve [[ x ]]" });
    await appendTurn(docPath, "directive-1", {
      role: "agent",
      timestamp: "t0",
      meta: "directives",
      body: "done",
    });
    db.upsert({ threadId: "directive-1", status: "responded", piSessionId: "codex-stale" });

    await orch.reply(docPath, "directive-1", "one more pass");

    const thread = await readThread(docPath, "directive-1");
    expect(thread.turns.map((t) => t.role)).toEqual(["you", "agent", "you", "agent"]);
    expect(thread.turns[3].body).toBe("resumed via codex");
    expect(db.get("directive-1")?.status).toBe("responded");
    expect(db.get("directive-1")?.piSessionId).toBe("codex-1");
  });
});

describe("Orchestrator.reply with stance change", () => {
  it("persists the new stance and injects it into the next agent message", async () => {
    await seedComment();
    const runner = new FakePiRunner([{ reply: "challenge" }, { reply: "support" }]);
    const orch = new Orchestrator({ runner, db, now: () => "t" });
    await orch.discuss(docPath, {
      threadId: "c0001",
      annotationId: "c0001",
      stance: "critiquer",
      comment: "Why Redis?",
    });

    await orch.reply(docPath, "c0001", "Make the case for it instead.", undefined, "supporter");

    const thread = await readThread(docPath, "c0001");
    expect(thread.frontmatter.stance).toBe("supporter");
    expect(thread.turns.some((t) => t.role === "system" && /supporter/.test(t.body))).toBe(true);
    // the message handed to the agent carries the new stance instruction
    expect(runner.sentMessages.at(-1)).toContain("Steelman");
    expect(runner.sentMessages.at(-1)).toContain("Make the case for it instead.");
  });
});

describe("Orchestrator.switchStance", () => {
  it("records a system turn and uses the new stance on the next agent turn", async () => {
    await seedComment();
    const runner = new FakePiRunner([{ reply: "challenge" }, { reply: "support" }]);
    const orch = new Orchestrator({ runner, db, now: () => "2026-06-12T10:00:05.000Z" });
    await orch.discuss(docPath, {
      threadId: "c0001",
      annotationId: "c0001",
      stance: "critiquer",
      comment: "Why Redis?",
    });

    await orch.switchStance(docPath, "c0001", "supporter");
    await orch.reply(docPath, "c0001", "ok");

    const thread = await readThread(docPath, "c0001");
    expect(thread.frontmatter.stance).toBe("supporter");
    const systemTurn = thread.turns.find((t) => t.role === "system");
    expect(systemTurn?.body).toContain("supporter");
    const lastAgent = [...thread.turns].reverse().find((t) => t.role === "agent");
    expect(lastAgent?.meta).toBe("supporter");
  });
});

// Conversation turns (discuss/reply/panel) never edit or propose an edit, under
// ANY settings.agentEdit value. This replaces the previous test that asserted the
// OPPOSITE (agentEdit: "direct" caused discuss to snapshot + emit docChanged when
// the agent wrote the file). That behavior is deliberately retired: `buildContext`
// now hands discuss/reply/panel `allowEdit: false` unconditionally (see its doc
// comment), so `runAgentStep` never even takes the pre-invoke snapshot
// `detectDirectEdit` needs, regardless of what this fake runner does.
describe("Orchestrator.discuss conversation turns never direct-edit", () => {
  it("does not snapshot or signal docChanged even when agentEdit is 'direct' and the runner writes the file", async () => {
    await seedComment();
    await writeSettings(docPath, { scope: "folder", agentEdit: "direct" });
    // A real pi/codex runner would never get edit/write tools here (tool-policy gates
    // them off conversationOnly, not off this fake's own choices) — this fake stands in
    // for a hypothetical agent that wrote the file anyway, to prove the ORCHESTRATOR side
    // of the guarantee: no detection/snapshot/notification follows, regardless.
    const editingRunner: AgentRunner = {
      async start(ctx, onToken) {
        await writeFile(ctx.docPath!, "EDITED BY AGENT\n", "utf8");
        onToken?.({ type: "token", text: "done" });
        return { sessionId: "x1", turn: { reply: "Edited the doc." } };
      },
      async send() {
        return { reply: "" };
      },
    };
    const events: string[] = [];
    const orch = new Orchestrator({ runner: editingRunner, db, now: () => "t" });
    await orch.discuss(
      docPath,
      { threadId: "c0001", annotationId: "c0001", stance: "none", comment: "fix it" },
      (e) => events.push(e.type),
    );
    expect(events).not.toContain("docChanged");
    expect((await listVersions(docPath)).map((v) => v.cause)).not.toContain("agent-edit");
  });

  it("hands discuss/reply/panel allowEdit:false and conversationOnly:true even when agentEdit is 'direct'", async () => {
    await seedComment();
    await writeSettings(docPath, { scope: "folder", agentEdit: "direct" });
    const runner = new FakePiRunner([
      { reply: "discuss reply" },
      { reply: "resumed reply" },
      { reply: "panel reply" },
    ]);
    const orch = new Orchestrator({ runner, db, now: () => "t" });

    await orch.discuss(docPath, { threadId: "c0001", annotationId: "c0001", stance: "none", comment: "q" });
    const discussCtx = runner.contextFor(db.get("c0001")!.piSessionId!)!;
    expect(discussCtx.allowEdit).toBe(false);
    expect(discussCtx.conversationOnly).toBe(true);

    // Force reply() through resumeFromTranscript (its own buildContext call, captured via
    // runner.start()) rather than the live send() path, which ignores the ctx it builds.
    db.upsert({ threadId: "c0001", status: "responded", piSessionId: "pi-stale-999" });
    await orch.reply(docPath, "c0001", "another question");
    const replyCtx = runner.contextFor(db.get("c0001")!.piSessionId!)!;
    expect(replyCtx.allowEdit).toBe(false);
    expect(replyCtx.conversationOnly).toBe(true);

    await orch.panel(docPath, { threadId: "c0002", annotationId: "c0001", stance: "none", comment: "q2" }, [
      "litellm/gpt-5.5",
    ]);
    const panelCtx = runner.contextFor(db.get("c0002")!.piSessionId!)!;
    expect(panelCtx.allowEdit).toBe(false);
    expect(panelCtx.conversationOnly).toBe(true);
  });
});

describe("Orchestrator.improve", () => {
  it("asks the agent to rewrite the highlight and returns the new text", async () => {
    await seedComment();
    const runner = new FakePiRunner([
      { reply: "Redis is overkill." },
      { reply: "an in-memory token bucket" },
    ]);
    const orch = new Orchestrator({ runner, db, now: () => "t" });
    await orch.discuss(docPath, {
      threadId: "c0001",
      annotationId: "c0001",
      stance: "critiquer",
      comment: "Why Redis?",
    });

    const result = await orch.improve(docPath, "c0001");
    expect(result.newText).toBe("an in-memory token bucket");
    const sid = db.get("c0001")!.piSessionId!;
    expect(runner.contextFor(sid)!.comment.toLowerCase()).toContain("rewrite");
  });

  it("persists a markdown rewrite as a legacy proposal and approves it through approveProposal", async () => {
    // Markdown Improve no longer applies via a separate unpersisted RPC (applyProposal,
    // deleted) — it persists a legacy single-span proposal (newText, no edits/fullText)
    // and Apply routes through the SAME approveProposal path as every other proposal.
    await seedComment();
    const runner = new FakePiRunner([
      { reply: "Redis is overkill." },
      { reply: "an in-memory token bucket" },
    ]);
    const orch = new Orchestrator({ runner, db, now: () => "t" });
    await orch.discuss(docPath, {
      threadId: "c0001",
      annotationId: "c0001",
      stance: "critiquer",
      comment: "Why Redis?",
    });

    const result = await orch.improve(docPath, "c0001");
    expect(result.proposalId).toBeTruthy();
    const props = await listProposals(docPath, "c0001");
    expect(props).toHaveLength(1);
    expect(props[0]).toMatchObject({
      id: result.proposalId,
      newText: "an in-memory token bucket",
      status: "pending",
    });
    expect(props[0].edits).toEqual([]);
    expect(props[0].fullText).toBeUndefined();

    await orch.approveProposal(docPath, "c0001", result.proposalId!);
    const edited = await readFile(docPath, "utf8");
    expect(edited).toContain("an in-memory token bucket");
    expect(edited).not.toContain("Redis");
    expect((await listProposals(docPath, "c0001"))[0].status).toBe("approved");
  });

  it("works on an un-discussed comment by starting a fresh session", async () => {
    await seedComment(); // c0001 exists, never discussed → no session
    const runner = new FakePiRunner([{ reply: "a cleaner sentence" }]);
    const orch = new Orchestrator({ runner, db, now: () => "t" });
    const result = await orch.improve(docPath, "c0001");
    expect(result.newText).toBe("a cleaner sentence");
    expect(db.get("c0001")?.piSessionId).toMatch(/.+/); // a session now exists
  });

  it("improve starts a fresh session when the stored session is stale", async () => {
    await seedComment();
    const runner = new FakePiRunner([{ reply: "discussed" }, { reply: "cleaner text" }]);
    const orch = new Orchestrator({ runner, db, now: () => "t" });
    await orch.discuss(docPath, { threadId: "c0001", annotationId: "c0001", stance: "none", comment: "q" });
    db.upsert({ threadId: "c0001", status: "responded", piSessionId: "pi-stale-1" });
    const res = await orch.improve(docPath, "c0001");
    expect(res.newText).toBe("cleaner text");             // did not throw "unknown session"
    expect(db.get("c0001")?.piSessionId).not.toBe("pi-stale-1");
  });

  it("folds a prior discussion into a fresh replacement-only session (not the warm one)", async () => {
    await seedComment();
    const runner = new FakePiRunner([{ reply: "discussed reply" }, { reply: "rewrite A" }]);
    const orch = new Orchestrator({ runner, db, now: () => "t" });
    await orch.discuss(docPath, { threadId: "c0001", annotationId: "c0001", stance: "none", comment: "Why Redis?" });
    const res = await orch.improve(docPath, "c0001");
    expect(res.newText).toBe("rewrite A");
    // Improve never resumes the discuss session (which holds propose_edit); it starts a
    // fresh replacement-only one, so no message is ever send()'d.
    expect(runner.sentMessages).toHaveLength(0);
    const sid = db.get("c0001")!.piSessionId!;
    const ctx = runner.contextFor(sid)!;
    expect(ctx.replacementOnly).toBe(true);                          // no propose_edit even when discussed
    expect(ctx.comment.toLowerCase()).toContain("discussion");       // brief folds the discussion in
    expect(ctx.history?.some((h) => h.role === "agent")).toBe(true); // prior turns replayed as history
  });

  it("includes latest discussion details in the Improve comment and full history", async () => {
    await seedComment();
    const runner = new FakePiRunner([
      { reply: "Redis is for multi-node sharing; for our single-node deployment, prefer an in-memory token bucket." },
      { reply: "Yes, incorporate the single-node token-bucket conclusion into the sentence." },
      { reply: "an in-memory token bucket with a TTL" },
    ]);
    const orch = new Orchestrator({ runner, db, now: () => "t" });
    await orch.discuss(docPath, {
      threadId: "c0001",
      annotationId: "c0001",
      stance: "none",
      comment: "We only run one node; should this still say Redis?",
    });
    await orch.reply(docPath, "c0001", "Please incorporate the single-node token-bucket conclusion.");

    await orch.improve(docPath, "c0001");

    const sid = db.get("c0001")!.piSessionId!;
    const ctx = runner.contextFor(sid)!;
    expect(ctx.history?.map((h) => h.body)).toEqual([
      "We only run one node; should this still say Redis?",
      "Redis is for multi-node sharing; for our single-node deployment, prefer an in-memory token bucket.",
      "Please incorporate the single-node token-bucket conclusion.",
      "Yes, incorporate the single-node token-bucket conclusion into the sentence.",
    ]);
    expect(ctx.comment).toContain("single-node token-bucket conclusion");
    expect(ctx.comment).toContain("in-memory token bucket");
    expect(ctx.comment).toContain("Use the conversation so far");
  });

  it("uses a standalone rewrite brief on an un-discussed comment (no nonexistent discussion)", async () => {
    await seedComment(); // never discussed → fresh session, no replayed history
    const runner = new FakePiRunner([{ reply: "cleaner text" }]);
    const orch = new Orchestrator({ runner, db, now: () => "t" });
    await orch.improve(docPath, "c0001");
    const sid = db.get("c0001")!.piSessionId!;
    const comment = runner.contextFor(sid)!.comment.toLowerCase();
    expect(comment).toContain("rewrite");        // still asks for a rewrite
    expect(comment).not.toContain("discussion"); // but does not invoke a discussion that isn't there
  });

  it("marks the fresh Improve context replacement-only so no propose_edit is offered", async () => {
    await seedComment();
    const runner = new FakePiRunner([{ reply: "cleaner text" }]);
    const orch = new Orchestrator({ runner, db, now: () => "t" });
    await orch.improve(docPath, "c0001");
    const sid = db.get("c0001")!.piSessionId!;
    expect(runner.contextFor(sid)!.replacementOnly).toBe(true);
    // Phase 10: Improve is an explicit edit flow, not a conversation turn — it must not
    // inherit buildContext's anchored conversationOnly:true default (see improve()'s
    // own comment on why it overrides this back to false).
    expect(runner.contextFor(sid)!.conversationOnly).toBe(false);
  });

  it("returns the trimmed reply as the rewrite (no propose_edit in Improve)", async () => {
    await seedComment();
    const runner = new FakePiRunner([{ reply: "  cleaner rewrite  " }]);
    const orch = new Orchestrator({ runner, db, now: () => "t" });
    const res = await orch.improve(docPath, "c0001");
    expect(res.newText).toBe("cleaner rewrite");
  });

  it("HTML Improve uses prior discussion to persist a raw-source proposal", async () => {
    db.close();
    docPath = join(dir, "plan.html");
    const html =
      "<!doctype html>\n" +
      "<html><body><section><h2>Rate limit storage</h2><p>We store limits in Redis with a TTL.</p></section></body></html>\n";
    await writeFile(docPath, html, "utf8");
    db = new TaskDB(hadPaths(docPath).stateDb);
    await addAnnotation(docPath, {
      id: "c0001",
      type: "comment",
      anchor: { exact: "Rate limit storage", prefix: "", suffix: "" },
      status: "open",
      thread: "threads/c0001.md",
      session: "sessions/c0001.session.jsonl",
      createdAt: "t",
    });
    await initThread(docPath, {
      id: "c0001",
      anchorExact: "Rate limit storage",
      stance: "none",
      status: "responded",
      piSession: "sessions/c0001.session.jsonl",
    });
    await appendTurn(docPath, "c0001", {
      role: "you",
      timestamp: "t",
      body: "We only run one node; should this still say Redis?",
    });
    await appendTurn(docPath, "c0001", {
      role: "agent",
      timestamp: "t",
      body: "For a single-node deployment, prefer an in-memory token bucket.",
    });
    const runner = new FakePiRunner([
      {
        reply: "Proposed an HTML-safe edit.",
        proposal: {
          rationale: "single-node deployment",
          hunks: [
            {
              oldText: "<section><h2>Rate limit storage</h2><p>We store limits in Redis with a TTL.</p></section>",
              newText: "<section><h2>Rate limit storage</h2><p>We use an in-memory token bucket with a TTL for the single-node deployment.</p></section>",
            },
          ],
        },
      },
    ]);
    const orch = new Orchestrator({ runner, db, now: () => "t" });

    const result = await orch.improve(docPath, "c0001");

    const sid = db.get("c0001")!.piSessionId!;
    const ctx = runner.contextFor(sid)!;
    expect(ctx.htmlMode).toBe(true);
    expect(ctx.replacementOnly).not.toBe(true);
    // Phase 10: HTML Improve is an explicit edit flow too — same conversationOnly
    // override as markdown Improve (see the test above).
    expect(ctx.conversationOnly).toBe(false);
    expect(ctx.comment).toContain("single-node deployment");
    expect(ctx.surrounding).toContain("<h2>Rate limit storage</h2>");
    expect(ctx.history?.map((h) => h.body)).toEqual([
      "We only run one node; should this still say Redis?",
      "For a single-node deployment, prefer an in-memory token bucket.",
    ]);
    const props = await listProposals(docPath, "c0001");
    expect(props).toHaveLength(1);
    expect(result.proposalId).toBe(props[0].id);
    expect(props[0].edits[0].oldText).toContain("<section>");
    expect(props[0].edits[0].newText).toContain("in-memory token bucket");
  });

  it("HTML Improve rejects raw reply-only output instead of offering legacy apply", async () => {
    db.close();
    docPath = join(dir, "plan.html");
    const html = "<!doctype html>\n<html><body><h2>Rate limit storage</h2></body></html>\n";
    await writeFile(docPath, html, "utf8");
    db = new TaskDB(hadPaths(docPath).stateDb);
    await addAnnotation(docPath, {
      id: "c0001",
      type: "comment",
      anchor: createAnchor(html, html.indexOf("Rate limit storage"), html.indexOf("Rate limit storage") + "Rate limit storage".length),
      status: "open",
      thread: "threads/c0001.md",
      session: "sessions/c0001.session.jsonl",
      createdAt: "t",
    });
    const runner = new FakePiRunner([{ reply: "<p>Generic replacement</p>" }]);
    const orch = new Orchestrator({ runner, db, now: () => "t" });

    await expect(orch.improve(docPath, "c0001")).rejects.toThrow(/structured proposal/i);
    expect(await listProposals(docPath, "c0001")).toHaveLength(0);
    expect(await readFile(docPath, "utf8")).toBe(html);
  });
});

describe("Orchestrator.resolveDirectives", () => {
  it("returns count 0 and runs no agent when there are no directives", async () => {
    await seedComment();
    const runner = new FakePiRunner([]); // would throw if start() were called
    const orch = new Orchestrator({ runner, db, now: () => "t" });
    const res = await orch.resolveDirectives(docPath);
    expect(res.count).toBe(0);
  });

  it("asks the agent to resolve [[ ]] directives and persists the proposal", async () => {
    await writeFile(docPath, "Keep this. [[ make it formal ]] End.\n", "utf8");
    await ensurePointer(docPath);
    const runner = new FakePiRunner([
      {
        reply: "done",
        proposal: {
          rationale: "resolve directive",
          hunks: [{ oldText: "[[ make it formal ]]", newText: "" }],
        },
      },
    ]);
    const orch = new Orchestrator({ runner, db, now: () => "t" });
    const events: { type: string; text: string }[] = [];
    const res = await orch.resolveDirectives(docPath, (e) => events.push(e));
    expect(res.count).toBe(1);

    const sid = db.get("directive-1")!.piSessionId!;
    expect(runner.contextFor(sid)?.comment).toContain("[[ make it formal ]]");
    // Phase 10: resolveDirectives is an explicit edit flow, unchanged in capability — its
    // context must stay conversationOnly:false so propose_edit keeps being offered.
    expect(runner.contextFor(sid)?.conversationOnly).toBe(false);

    const props = await listProposals(docPath, "directive-1");
    expect(props).toHaveLength(1);
    expect(props[0].edits[0].oldText).toBe("[[ make it formal ]]");
    expect(events.some((e) => e.type === "proposal")).toBe(true);
  });

  it("launches one task/thread per directive", async () => {
    await writeFile(docPath, "A [[ one ]] B [[ two ]] C\n", "utf8");
    await ensurePointer(docPath);
    const runner = new FakePiRunner([
      { reply: "one done", proposal: { rationale: "one", hunks: [{ oldText: "[[ one ]]", newText: "" }] } },
      { reply: "two done", proposal: { rationale: "two", hunks: [{ oldText: "[[ two ]]", newText: "" }] } },
    ]);
    const orch = new Orchestrator({ runner, db, now: () => "t" });
    const res = await orch.resolveDirectives(docPath);
    expect(res.count).toBe(2);
    expect(db.get("directive-1")?.status).toBe("responded");
    expect(db.get("directive-2")?.status).toBe("responded");
    expect(runner.contextFor("fake-1")?.comment).toContain("[[ one ]]");
    expect(runner.contextFor("fake-2")?.comment).toContain("[[ two ]]");
    expect(await listProposals(docPath, "directive-1")).toHaveLength(1);
    expect(await listProposals(docPath, "directive-2")).toHaveLength(1);
  });

  it("swallows one directive's failure and continues the others; the no-text fallback never leaks into the returned summary", async () => {
    await writeFile(docPath, "A [[ boom ]] B [[ ok ]] C\n", "utf8");
    await ensurePointer(docPath);
    const runner: AgentRunner = {
      async start(ctx) {
        if (ctx.anchorExact === "[[ boom ]]") throw new Error("agent exploded");
        return { sessionId: "sid-ok", turn: { reply: "" } };
      },
      async send() {
        throw new Error("unexpected send");
      },
      async cancel() {},
    };
    const orch = new Orchestrator({ runner, db, now: () => "t" });

    const res = await orch.resolveDirectives(docPath);
    expect(res.count).toBe(2);
    expect(res.proposed).toBe(false);
    // rawReply (pre-fallback, empty string) is what the aggregated summary carries for
    // directive 2, not the "(the agent returned no text and no edit)" fallback that gets
    // substituted into its persisted thread turn.
    expect(res.reply).toBe("Directive 1: Error: agent exploded\n\nDirective 2: ");

    // failed directive: batch didn't abort, and it was swallowed + recorded, not rethrown.
    expect(db.get("directive-1")?.status).toBe("error");
    expect(db.get("directive-1")?.errorText).toBe("Error: agent exploded");
    const errThread = await readThread(docPath, "directive-1");
    expect(errThread.turns.map((t) => t.role)).toEqual(["system"]);
    expect(errThread.turns[0].body).toContain("agent exploded");

    // succeeded directive: the empty agent reply gets the no-text fallback in the PERSISTED
    // turn, but the un-substituted (empty) reply is what the batch summary reflects.
    expect(db.get("directive-2")?.status).toBe("responded");
    const okThread = await readThread(docPath, "directive-2");
    expect(okThread.turns.map((t) => t.role)).toEqual(["you", "agent"]);
    expect(okThread.turns[1].body).toBe("(the agent returned no text and no edit)");
  });
});

describe("Orchestrator standing instructions", () => {
  it("injects per-doc standing instructions into the agent context for discuss", async () => {
    await seedComment();
    await writeSettings(docPath, { scope: "folder", instructions: "Use active voice. Keep my terse style." });
    const runner = new FakePiRunner([{ reply: "ok" }]);
    const orch = new Orchestrator({ runner, db, now: () => "t" });
    await orch.discuss(docPath, { threadId: "c0001", annotationId: "c0001", stance: "none", comment: "q" });
    const sid = db.get("c0001")!.piSessionId!;
    expect(runner.contextFor(sid)?.instructions).toContain("active voice");
  });

  it("injects standing instructions into the review pass context", async () => {
    await seedComment();
    await writeSettings(docPath, { scope: "folder", instructions: "No passive voice." });
    const runner = new FakePiRunner([{ reply: "reviewed", findings: [] }]);
    const orch = new Orchestrator({ runner, db, now: () => "t" });
    await orch.review(docPath, { stance: "none" });
    expect(runner.contextFor("fake-1")?.instructions).toContain("No passive voice");
  });
});

describe("Orchestrator context flags", () => {
  // Phase 10: renamed from "discuss does not mark the context replacement-only
  // (propose_edit stays available)" — that parenthetical is no longer true (discuss is
  // now conversationOnly, so tool-policy withholds propose_edit too), even though the
  // literal `replacementOnly` assertion below still holds (replacementOnly and
  // conversationOnly are distinct flags — see AgentContext).
  it("discuss is conversationOnly, not replacement-only — a conversation turn, not Improve", async () => {
    await seedComment();
    const runner = new FakePiRunner([{ reply: "x" }]);
    const orch = new Orchestrator({ runner, db, now: () => "t" });
    await orch.discuss(docPath, { threadId: "c0001", annotationId: "c0001", stance: "none", comment: "q" });
    const sid = db.get("c0001")!.piSessionId!;
    expect(runner.contextFor(sid)!.replacementOnly).toBeFalsy();
    expect(runner.contextFor(sid)!.conversationOnly).toBe(true);
  });

  it("selects the markdown document toolchain without reading MCP from settings", async () => {
    await seedComment();
    await writeSettings(docPath, { scope: "folder" });
    await writeFile(
      hadPaths(docPath).settings,
      JSON.stringify(
        {
          scope: "folder",
          mcp: { enabled: true, presets: ["fast-html"] },
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );
    const runner = new FakePiRunner([{ reply: "x" }]);
    const orch = new Orchestrator({ runner, db, now: () => "t" });

    await orch.discuss(docPath, { threadId: "c0001", annotationId: "c0001", stance: "none", comment: "q" });

    const sid = db.get("c0001")!.piSessionId!;
    const ctx = runner.contextFor(sid)!;
    expect(ctx.docToolchain).toBe("markdown-editor");
    expect((ctx as { mcp?: unknown }).mcp).toBeUndefined();
  });

  it("selects the fast-html document toolchain for HTML", async () => {
    db.close();
    docPath = join(dir, "plan.html");
    const html = "<!doctype html><html><body><p>HTML body</p></body></html>";
    await writeFile(docPath, html, "utf8");
    await ensurePointer(docPath);
    db = new TaskDB(hadPaths(docPath).stateDb);
    await addAnnotation(docPath, {
      id: "c0001",
      type: "comment",
      anchor: createAnchor(html, html.indexOf("HTML"), html.indexOf("HTML") + "HTML".length),
      status: "open",
      thread: "threads/c0001.md",
      session: "sessions/c0001.session.jsonl",
      createdAt: "t",
    });
    const runner = new FakePiRunner([{ reply: "x" }]);
    const orch = new Orchestrator({ runner, db, now: () => "t" });

    await orch.discuss(docPath, { threadId: "c0001", annotationId: "c0001", stance: "none", comment: "q" });

    expect(runner.contextFor("fake-1")?.docToolchain).toBe("fast-html");
  });

  it("leaves unknown document types without an MCP toolchain", async () => {
    db.close();
    docPath = join(dir, "notes.txt");
    await writeFile(docPath, "Plain notes with anchor text.\n", "utf8");
    await ensurePointer(docPath);
    db = new TaskDB(hadPaths(docPath).stateDb);
    await addAnnotation(docPath, {
      id: "c0001",
      type: "comment",
      anchor: createAnchor("Plain notes with anchor text.\n", 0, "Plain".length),
      status: "open",
      thread: "threads/c0001.md",
      session: "sessions/c0001.session.jsonl",
      createdAt: "t",
    });
    const runner = new FakePiRunner([{ reply: "x" }]);
    const orch = new Orchestrator({ runner, db, now: () => "t" });

    await orch.discuss(docPath, { threadId: "c0001", annotationId: "c0001", stance: "none", comment: "q" });

    expect(runner.contextFor("fake-1")?.docToolchain).toBeUndefined();
  });
});

describe("Orchestrator.visualize", () => {
  it("asks the agent for a diagram of the highlighted text and returns it", async () => {
    await seedComment();
    const runner = new FakePiRunner([{ reply: "```mermaid\nflowchart TD\n  A-->B\n```" }]);
    const orch = new Orchestrator({ runner, db, now: () => "t" });
    const res = await orch.visualize(docPath, "c0001");
    expect(res.diagram).toContain("```mermaid");
    expect(db.get("c0001")?.piSessionId).toMatch(/.+/);
  });

  it("continues an existing live session when one is present", async () => {
    await seedComment();
    const runner = new FakePiRunner([{ reply: "discussed" }, { reply: "```mermaid\ngraph LR\n X-->Y\n```" }]);
    const orch = new Orchestrator({ runner, db, now: () => "t" });
    await orch.discuss(docPath, { threadId: "c0001", annotationId: "c0001", stance: "none", comment: "q" });
    const res = await orch.visualize(docPath, "c0001");
    expect(res.diagram).toContain("```mermaid");
  });
});

describe("Orchestrator turn docVersion stamping", () => {
  it("stamps you+agent turns with the doc version active at the time", async () => {
    await seedComment();
    const runner = new FakePiRunner([{ reply: "ok" }]);
    const orch = new Orchestrator({ runner, db, now: () => "t" });
    await orch.discuss(docPath, { threadId: "c0001", annotationId: "c0001", stance: "none", comment: "hi" });
    const thread = await readThread(docPath, "c0001");
    expect(thread.turns[0].docVersion).toMatch(/^v\d+$/);          // you-turn stamped
    expect(thread.turns[1].docVersion).toBe(thread.turns[0].docVersion); // agent-turn same version
  });
});

describe("Orchestrator.approveProposal — legacy single-span proposal", () => {
  it("resolves the anchor, edits the doc, re-anchors the annotation, and marks the proposal approved", async () => {
    // Migrated from the old "Orchestrator.applyProposal" suite (applyProposal is deleted
    // end-to-end): the legacy span-replacement behavior now lives in approveProposal's
    // back-compat branch (applyLegacySpan), driven by an on-disk legacy proposal
    // (newText, no edits/fullText) instead of a direct method call.
    await seedComment();
    const runner = new FakePiRunner([{ reply: "Use in-memory." }]);
    const orch = new Orchestrator({ runner, db, now: () => "2026-06-12T10:00:05.000Z" });
    await orch.discuss(docPath, {
      threadId: "c0001",
      annotationId: "c0001",
      stance: "critiquer",
      comment: "Why Redis?",
    });
    // Legacy-shaped proposal: as persisted before hunks/full-rewrite existed, or by a
    // markdown Improve rewrite (Orchestrator.improve's non-HTML branch).
    await addProposal(docPath, {
      id: "c0001#p1",
      threadId: "c0001",
      edits: [],
      newText: "an in-memory store",
      rationale: "single node",
      status: "pending",
      delivered: false,
      at: "2026-06-12T10:00:05.000Z",
    });

    await orch.approveProposal(docPath, "c0001", "c0001#p1");

    const edited = await readFile(docPath, "utf8");
    expect(edited).toContain("an in-memory store");
    expect(edited).not.toContain("Redis");
    const causes = (await listVersions(docPath)).map((e) => e.cause);
    // discuss() takes a turn-base snapshot of the original; the legacy apply's
    // pre-apply-backup has identical content so it dedupes into turn-base — only
    // the edited content becomes a new (agent-edit) version. Same dedup the old
    // applyProposal test observed.
    expect(causes).toEqual(["turn-base", "agent-edit"]);
    const ann = (await readAnnotations(docPath)).annotations[0];
    expect(ann.anchor.exact).toBe("an in-memory store");
    expect(ann.status).toBe("resolved");
    expect((await listProposals(docPath, "c0001"))[0].status).toBe("approved");
  });

  it("rejects the legacy path for HTML documents, leaving the doc and proposal untouched", async () => {
    // Migrated from the old "rejects the legacy direct-apply path for HTML documents"
    // applyProposal test.
    db.close();
    docPath = join(dir, "plan.html");
    const html = "<!doctype html>\n<html><body><h2>Rate limit storage</h2></body></html>\n";
    await writeFile(docPath, html, "utf8");
    db = new TaskDB(hadPaths(docPath).stateDb);
    await addAnnotation(docPath, {
      id: "c0001",
      type: "comment",
      anchor: createAnchor(html, html.indexOf("Rate limit storage"), html.indexOf("Rate limit storage") + "Rate limit storage".length),
      status: "open",
      thread: "threads/c0001.md",
      session: "sessions/c0001.session.jsonl",
      createdAt: "t",
    });
    await addProposal(docPath, {
      id: "c0001#p1",
      threadId: "c0001",
      edits: [],
      newText: "<p>Generic replacement</p>",
      rationale: "",
      status: "pending",
      delivered: false,
      at: "t",
    });
    const orch = new Orchestrator({ runner: new FakePiRunner([]), db, now: () => "t" });

    await expect(orch.approveProposal(docPath, "c0001", "c0001#p1")).rejects.toThrow(
      /approveProposal/,
    );
    expect(await readFile(docPath, "utf8")).toBe(html);
    expect((await listProposals(docPath, "c0001"))[0].status).toBe("pending");
  });
});

describe("Orchestrator proposals", () => {
  it("persists targeted hunks + emits a proposal event when the agent proposes", async () => {
    await seedComment();
    const runner = new FakePiRunner([
      { reply: "here's a tighter version", proposal: { rationale: "tighten", hunks: [{ oldText: "Redis", newText: "an in-memory store" }] } },
    ]);
    const orch = new Orchestrator({ runner, db, now: () => "t" });
    const events: { type: string; text: string }[] = [];
    await orch.discuss(docPath, { threadId: "c0001", annotationId: "c0001", stance: "none", comment: "tighten this" }, (e) => events.push(e));
    const props = await listProposals(docPath, "c0001");
    expect(props).toHaveLength(1);
    expect(props[0].edits).toEqual([{ oldText: "Redis", newText: "an in-memory store" }]);
    expect(props[0]).toMatchObject({ threadId: "c0001", status: "pending" });
    const ev = events.find((e) => e.type === "proposal");
    expect(ev).toBeTruthy();
    expect(JSON.parse(ev!.text).edits[0].oldText).toBe("Redis");
  });

  it("persists a fullRewrite: keeps fullText, diffs to display hunks, emits fullText", async () => {
    await seedComment();
    const rewrite = "We store limits in Memcached with a TTL.\n";
    const runner = new FakePiRunner([{ reply: "rewriting", proposal: { rationale: "rw", fullRewrite: rewrite } }]);
    const orch = new Orchestrator({ runner, db, now: () => "t" });
    const events: { type: string; text: string }[] = [];
    await orch.discuss(docPath, { threadId: "c0001", annotationId: "c0001", stance: "none", comment: "rewrite" }, (e) => events.push(e));
    const p = (await listProposals(docPath, "c0001"))[0];
    expect(p.fullText).toBe(rewrite);
    expect(p.edits.length).toBeGreaterThan(0);
    expect(p.edits.some((h) => h.newText.includes("Memcached"))).toBe(true);
    const ev = events.find((e) => e.type === "proposal");
    expect(ev).toBeTruthy();
    expect(JSON.parse(ev!.text).fullText).toBe(rewrite);
  });

  it("approve (rewrite) writes the new body and preserves frontmatter, marks approved", async () => {
    // Give the doc frontmatter so we can assert it survives the rewrite.
    await writeFile(docPath, `---\nhad: 1\n---\n${DOC}`, "utf8");
    await seedComment();
    const rewrite = "We store limits in Memcached with a TTL.\n";
    const runner = new FakePiRunner([{ reply: "rw", proposal: { rationale: "rw", fullRewrite: rewrite } }]);
    const orch = new Orchestrator({ runner, db, now: () => "t" });
    await orch.discuss(docPath, { threadId: "c0001", annotationId: "c0001", stance: "none", comment: "rewrite" });
    const id = (await listProposals(docPath, "c0001"))[0].id;
    await orch.approveProposal(docPath, "c0001", id);
    const after = await readFile(docPath, "utf8");
    expect(after).toContain("Memcached");
    expect(after).toContain("had:"); // frontmatter preserved
    expect((await listProposals(docPath, "c0001"))[0].status).toBe("approved");
  });

  it("approve (hunks) splices each oldText→newText, marks approved", async () => {
    await seedComment();
    const runner = new FakePiRunner([{ reply: "r", proposal: { rationale: "x", hunks: [{ oldText: "Redis", newText: "Memcached" }] } }]);
    const orch = new Orchestrator({ runner, db, now: () => "t" });
    await orch.discuss(docPath, { threadId: "c0001", annotationId: "c0001", stance: "none", comment: "tighten" });
    const id = (await listProposals(docPath, "c0001"))[0].id;
    await orch.approveProposal(docPath, "c0001", id);
    expect(await readFile(docPath, "utf8")).toContain("Memcached");
    expect((await listProposals(docPath, "c0001"))[0].status).toBe("approved");
  });

  it("approve rejects HTML hunks that replace tagged source with rendered plain text", async () => {
    db.close();
    docPath = join(dir, "plan.html");
    const html =
      "<!doctype html>\n" +
      "<html><body><ul><li><strong>Redis</strong> with a TTL</li></ul></body></html>\n";
    await writeFile(docPath, html, "utf8");
    db = new TaskDB(hadPaths(docPath).stateDb);
    await addAnnotation(docPath, {
      id: "c0001",
      type: "comment",
      anchor: createAnchor(html, html.indexOf("Redis"), html.indexOf("Redis") + "Redis".length),
      status: "open",
      thread: "threads/c0001.md",
      session: "sessions/c0001.session.jsonl",
      createdAt: "t",
    });
    const oldText = "<li><strong>Redis</strong> with a TTL</li>";
    const runner = new FakePiRunner([
      {
        reply: "done",
        proposal: {
          rationale: "r",
          hunks: [{ oldText, newText: "Use an in-memory store with a TTL" }],
        },
      },
    ]);
    const orch = new Orchestrator({ runner, db, now: () => "t" });
    await orch.discuss(docPath, { threadId: "c0001", annotationId: "c0001", stance: "none", comment: "fix" });
    const id = (await listProposals(docPath, "c0001"))[0].id;

    await expect(orch.approveProposal(docPath, "c0001", id)).rejects.toThrow(/HTML/i);
    expect(await readFile(docPath, "utf8")).toBe(html);
    expect((await listProposals(docPath, "c0001"))[0].status).toBe("pending");
  });

  it("approve rejects HTML hunks that insert raw tags into text-only source", async () => {
    db.close();
    docPath = join(dir, "plan.html");
    const html = "<!doctype html>\n<html><body><h2>Rate limit storage</h2></body></html>\n";
    await writeFile(docPath, html, "utf8");
    db = new TaskDB(hadPaths(docPath).stateDb);
    await addAnnotation(docPath, {
      id: "c0001",
      type: "comment",
      anchor: createAnchor(html, html.indexOf("Rate limit storage"), html.indexOf("Rate limit storage") + "Rate limit storage".length),
      status: "open",
      thread: "threads/c0001.md",
      session: "sessions/c0001.session.jsonl",
      createdAt: "t",
    });
    const runner = new FakePiRunner([
      {
        reply: "done",
        proposal: {
          rationale: "r",
          hunks: [{ oldText: "Rate limit storage", newText: "<p>Generic replacement</p>" }],
        },
      },
    ]);
    const orch = new Orchestrator({ runner, db, now: () => "t" });
    await orch.discuss(docPath, { threadId: "c0001", annotationId: "c0001", stance: "none", comment: "fix" });
    const id = (await listProposals(docPath, "c0001"))[0].id;

    await expect(orch.approveProposal(docPath, "c0001", id)).rejects.toThrow(/HTML proposal hunk/i);
    expect(await readFile(docPath, "utf8")).toBe(html);
    expect((await listProposals(docPath, "c0001"))[0].status).toBe("pending");
  });

  it("approve rejects malformed HTML output with repair feedback and leaves the doc unchanged", async () => {
    db.close();
    docPath = join(dir, "plan.html");
    const html =
      "<!doctype html>\n" +
      "<html><body><section><p>Redis</p></section></body></html>\n";
    await writeFile(docPath, html, "utf8");
    db = new TaskDB(hadPaths(docPath).stateDb);
    await addAnnotation(docPath, {
      id: "c0001",
      type: "comment",
      anchor: createAnchor(html, html.indexOf("Redis"), html.indexOf("Redis") + "Redis".length),
      status: "open",
      thread: "threads/c0001.md",
      session: "sessions/c0001.session.jsonl",
      createdAt: "t",
    });
    const runner = new FakePiRunner([
      {
        reply: "done",
        proposal: {
          rationale: "r",
          hunks: [{ oldText: "<p>Redis</p>", newText: "<p>Memcached" }],
        },
      },
      { reply: "retrying" },
    ]);
    const orch = new Orchestrator({ runner, db, now: () => "t" });
    await orch.discuss(docPath, { threadId: "c0001", annotationId: "c0001", stance: "none", comment: "fix" });
    const id = (await listProposals(docPath, "c0001"))[0].id;

    await expect(orch.approveProposal(docPath, "c0001", id)).rejects.toThrow(/HTML validation/i);
    expect(await readFile(docPath, "utf8")).toBe(html);
    const rejected = (await listProposals(docPath, "c0001"))[0];
    expect(rejected.status).toBe("rejected");
    expect(rejected.delivered).toBe(false);
    expect(rejected.feedback).toMatch(/HTML validation/i);

    await orch.reply(docPath, "c0001", "please fix the proposal");
    expect(runner.sentMessages.at(-1)).toContain("HTML validation");
    expect(runner.sentMessages.at(-1)).toContain("please fix the proposal");
    expect((await listProposals(docPath, "c0001"))[0].delivered).toBe(true);
  });

  it("approve applies valid HTML proposal output", async () => {
    db.close();
    docPath = join(dir, "plan.html");
    const html =
      "<!doctype html>\n" +
      "<html><body><section><p>Redis</p></section></body></html>\n";
    await writeFile(docPath, html, "utf8");
    db = new TaskDB(hadPaths(docPath).stateDb);
    await addAnnotation(docPath, {
      id: "c0001",
      type: "comment",
      anchor: createAnchor(html, html.indexOf("Redis"), html.indexOf("Redis") + "Redis".length),
      status: "open",
      thread: "threads/c0001.md",
      session: "sessions/c0001.session.jsonl",
      createdAt: "t",
    });
    const runner = new FakePiRunner([
      {
        reply: "done",
        proposal: {
          rationale: "r",
          hunks: [{ oldText: "<p>Redis</p>", newText: "<p>Memcached</p>" }],
        },
      },
    ]);
    const orch = new Orchestrator({ runner, db, now: () => "t" });
    await orch.discuss(docPath, { threadId: "c0001", annotationId: "c0001", stance: "none", comment: "fix" });
    const id = (await listProposals(docPath, "c0001"))[0].id;

    await orch.approveProposal(docPath, "c0001", id);
    expect(await readFile(docPath, "utf8")).toContain("<p>Memcached</p>");
    expect((await listProposals(docPath, "c0001"))[0].status).toBe("approved");
  });

  it("approve is atomic: a missing oldText throws and leaves status pending + doc unchanged", async () => {
    await seedComment();
    const runner = new FakePiRunner([{ reply: "r", proposal: { rationale: "x", hunks: [{ oldText: "NOT IN DOC", newText: "x" }] } }]);
    const orch = new Orchestrator({ runner, db, now: () => "t" });
    await orch.discuss(docPath, { threadId: "c0001", annotationId: "c0001", stance: "none", comment: "tighten" });
    const id = (await listProposals(docPath, "c0001"))[0].id;
    const before = await readFile(docPath, "utf8");
    await expect(orch.approveProposal(docPath, "c0001", id)).rejects.toThrow();
    expect((await listProposals(docPath, "c0001"))[0].status).toBe("pending");
    expect(await readFile(docPath, "utf8")).toBe(before);
  });

  it("approve rejects a degenerate proposal (no fullText, no edits): doc unchanged, stays pending", async () => {
    await seedComment();
    // An edit-less proposal: rationale only, no hunks and no fullRewrite.
    const runner = new FakePiRunner([{ reply: "done", proposal: { rationale: "noop" } }]);
    const orch = new Orchestrator({ runner, db, now: () => "t" });
    await orch.discuss(docPath, { threadId: "c0001", annotationId: "c0001", stance: "none", comment: "do nothing" });
    const id = (await listProposals(docPath, "c0001"))[0].id;
    const before = await readFile(docPath, "utf8");
    await expect(orch.approveProposal(docPath, "c0001", id)).rejects.toThrow();
    expect(await readFile(docPath, "utf8")).toBe(before); // byte-unchanged
    expect((await listProposals(docPath, "c0001"))[0].status).toBe("pending");
  });

  it("approve rejects a proposal if the doc changed since it was made (stale base)", async () => {
    await seedComment();
    const runner = new FakePiRunner([
      { reply: "done", proposal: { rationale: "r", fullRewrite: "Agent's new body.\n" } },
    ]);
    const orch = new Orchestrator({ runner, db, now: () => "t" });
    await orch.discuss(docPath, { threadId: "c0001", annotationId: "c0001", stance: "none", comment: "rewrite" });
    const id = (await listProposals(docPath, "c0001"))[0].id;
    // The reviewer edits the doc AFTER the proposal was made.
    await writeFile(docPath, "The reviewer edited this in the meantime.\n", "utf8");
    await expect(orch.approveProposal(docPath, "c0001", id)).rejects.toThrow(/changed/i);
    // The intervening edit is NOT clobbered, and the proposal stays pending.
    expect(await readFile(docPath, "utf8")).toContain("The reviewer edited this");
    expect((await listProposals(docPath, "c0001"))[0].status).toBe("pending");
  });

  it("approve maps duplicate-text hunks to successive occurrences (matches the editor's forward scan)", async () => {
    await writeFile(docPath, "a foo b foo c\n", "utf8");
    await ensurePointer(docPath);
    await addAnnotation(docPath, {
      id: "c0001",
      type: "comment",
      anchor: createAnchor("a foo b foo c\n", 2, 5),
      status: "open",
      thread: "threads/c0001.md",
      session: "sessions/c0001.session.jsonl",
      createdAt: "t",
    });
    const runner = new FakePiRunner([
      {
        reply: "done",
        proposal: {
          rationale: "r",
          hunks: [
            { oldText: "foo", newText: "FOO1" },
            { oldText: "foo", newText: "FOO2" },
          ],
        },
      },
    ]);
    const orch = new Orchestrator({ runner, db, now: () => "t" });
    await orch.discuss(docPath, { threadId: "c0001", annotationId: "c0001", stance: "none", comment: "fix" });
    const id = (await listProposals(docPath, "c0001"))[0].id;
    await orch.approveProposal(docPath, "c0001", id);
    // First "foo" → FOO1, SECOND "foo" → FOO2 (not both the first occurrence).
    expect(await readFile(docPath, "utf8")).toContain("a FOO1 b FOO2 c");
  });

  it("approve rejects a hunk with empty oldText (insertion has no anchor) instead of silently no-op'ing", async () => {
    await seedComment();
    const runner = new FakePiRunner([
      { reply: "done", proposal: { rationale: "r", hunks: [{ oldText: "", newText: "inserted text" }] } },
    ]);
    const orch = new Orchestrator({ runner, db, now: () => "t" });
    await orch.discuss(docPath, { threadId: "c0001", annotationId: "c0001", stance: "none", comment: "insert" });
    const id = (await listProposals(docPath, "c0001"))[0].id;
    const before = await readFile(docPath, "utf8");
    await expect(orch.approveProposal(docPath, "c0001", id)).rejects.toThrow(/anchor/i);
    expect(await readFile(docPath, "utf8")).toBe(before); // not silently "applied"
    expect((await listProposals(docPath, "c0001"))[0].status).toBe("pending");
  });

  it("reject queues a hunk-summary that rides along with the next reply, once", async () => {
    await seedComment();
    const runner = new FakePiRunner([
      { reply: "r1", proposal: { rationale: "x", hunks: [{ oldText: "Redis", newText: "bad rewrite" }] } },
      { reply: "r2" }, // the reply after rejection
      { reply: "r3" }, // a second reply — must NOT repeat the rejection
    ]);
    const orch = new Orchestrator({ runner, db, now: () => "t" });
    await orch.discuss(docPath, { threadId: "c0001", annotationId: "c0001", stance: "none", comment: "tighten" });
    const id = (await listProposals(docPath, "c0001"))[0].id;
    await orch.rejectProposal(docPath, "c0001", id);
    expect((await listProposals(docPath, "c0001"))[0].status).toBe("rejected");

    await orch.reply(docPath, "c0001", "try a different angle");
    // the rejected change rode along in the message handed to the agent
    expect(runner.sentMessages.at(-1)).toContain("rejected");
    expect(runner.sentMessages.at(-1)).toContain("bad rewrite");
    expect(runner.sentMessages.at(-1)).toContain("try a different angle");

    // delivered once: a second reply does NOT repeat it
    await orch.reply(docPath, "c0001", "second reply");
    expect(runner.sentMessages.at(-1)).not.toContain("bad rewrite");
    expect(runner.sentMessages.at(-1)).toContain("second reply");
  });

  // Root-cause coverage for the "stuck approved proposal card" bug:
  // approveProposal/rejectProposal previously had
  // NO guard against re-running on a proposal that already resolved — a lost approve
  // RESPONSE (dropped connection / sidecar restart AFTER the server durably applied it)
  // left the client's card live, and the retry click that followed either hit the
  // baseHash staleness check with a confusing "the document changed" error (approve) or
  // silently corrupted the record by flipping an APPLIED proposal's status back to
  // "rejected" (reject, no guard at all). Both now throw a clean, distinguishable
  // `proposal already <status>` error instead.
  it("approve on an already-approved proposal throws a distinguishable error instead of the confusing staleness error, doc/status untouched", async () => {
    await seedComment();
    await addProposal(docPath, {
      id: "c0001#p1",
      threadId: "c0001",
      edits: [{ oldText: "Redis", newText: "Memcached" }],
      rationale: "r",
      status: "approved",
      delivered: false,
      at: "t",
    });
    const orch = new Orchestrator({ runner: new FakePiRunner([]), db, now: () => "t" });
    const before = await readFile(docPath, "utf8");
    await expect(orch.approveProposal(docPath, "c0001", "c0001#p1")).rejects.toThrow(
      /proposal already approved/i,
    );
    expect(await readFile(docPath, "utf8")).toBe(before); // no re-apply
    expect((await listProposals(docPath, "c0001"))[0].status).toBe("approved");
  });

  it("approve on an already-rejected proposal throws a distinguishable error, doc/status untouched", async () => {
    await seedComment();
    await addProposal(docPath, {
      id: "c0001#p1",
      threadId: "c0001",
      edits: [{ oldText: "Redis", newText: "Memcached" }],
      rationale: "r",
      status: "rejected",
      delivered: false,
      at: "t",
    });
    const orch = new Orchestrator({ runner: new FakePiRunner([]), db, now: () => "t" });
    const before = await readFile(docPath, "utf8");
    await expect(orch.approveProposal(docPath, "c0001", "c0001#p1")).rejects.toThrow(
      /proposal already rejected/i,
    );
    expect(await readFile(docPath, "utf8")).toBe(before);
    expect((await listProposals(docPath, "c0001"))[0].status).toBe("rejected");
  });

  it("reject on an already-approved proposal throws instead of flipping its status back to rejected", async () => {
    await seedComment();
    await addProposal(docPath, {
      id: "c0001#p1",
      threadId: "c0001",
      edits: [{ oldText: "Redis", newText: "Memcached" }],
      rationale: "r",
      status: "approved",
      delivered: false,
      at: "t",
    });
    const orch = new Orchestrator({ runner: new FakePiRunner([]), db, now: () => "t" });
    await expect(orch.rejectProposal(docPath, "c0001", "c0001#p1")).rejects.toThrow(
      /proposal already approved/i,
    );
    // status MUST stay "approved" — corrupting it to "rejected" would later make
    // rejectFeedbackPrefix tell the agent an APPLIED edit was rejected.
    expect((await listProposals(docPath, "c0001"))[0].status).toBe("approved");
  });

  it("reject on an already-rejected proposal throws a distinguishable error (idempotent no-op)", async () => {
    await seedComment();
    await addProposal(docPath, {
      id: "c0001#p1",
      threadId: "c0001",
      edits: [{ oldText: "Redis", newText: "Memcached" }],
      rationale: "r",
      status: "rejected",
      delivered: false,
      at: "t",
    });
    const orch = new Orchestrator({ runner: new FakePiRunner([]), db, now: () => "t" });
    await expect(orch.rejectProposal(docPath, "c0001", "c0001#p1")).rejects.toThrow(
      /proposal already rejected/i,
    );
    expect((await listProposals(docPath, "c0001"))[0].status).toBe("rejected");
  });

  it("a lost approve RESPONSE self-heals: the retry the guard reports cleanly, never double-applies", async () => {
    // Simulates the exact race: approve applies the hunk + marks approved, but the
    // client never sees the response (dropped connection / sidecar restart) — the
    // retry click that follows must not double-apply or corrupt state, only report
    // the distinguishable "already approved".
    await seedComment();
    const runner = new FakePiRunner([
      { reply: "r", proposal: { rationale: "x", hunks: [{ oldText: "Redis", newText: "Memcached" }] } },
    ]);
    const orch = new Orchestrator({ runner, db, now: () => "t" });
    await orch.discuss(docPath, { threadId: "c0001", annotationId: "c0001", stance: "none", comment: "tighten" });
    const id = (await listProposals(docPath, "c0001"))[0].id;
    await orch.approveProposal(docPath, "c0001", id); // applies; "response" is the part that's lost client-side
    const applied = await readFile(docPath, "utf8");
    expect(applied).toContain("Memcached");
    await expect(orch.approveProposal(docPath, "c0001", id)).rejects.toThrow(/already approved/i);
    expect(await readFile(docPath, "utf8")).toBe(applied); // no double-apply
  });
});

describe("Orchestrator.branch", () => {
  it("forks a new thread seeded up to the edited message and resumes (latest doc)", async () => {
    await seedComment();
    const runner = new FakePiRunner([{ reply: "first" }, { reply: "branched reply" }]);
    const orch = new Orchestrator({ runner, db, now: () => "t" });
    await orch.discuss(docPath, { threadId: "c0001", annotationId: "c0001", stance: "none", comment: "orig question" });

    const res = await orch.branch(docPath, "c0001", 0, "revised question", { doc: "latest" });
    expect(res.branchThreadId).not.toBe("c0001");

    const branch = await readThread(docPath, res.branchThreadId);
    expect(branch.frontmatter.parent).toBe("c0001");
    expect(branch.frontmatter.branchFromTurn).toBe(0);
    expect(branch.frontmatter.baseDoc).toBe("latest");
    expect(branch.turns[0].body).toBe("revised question");
    expect(branch.turns.at(-1)?.role).toBe("agent");
    expect(branch.turns.at(-1)?.body).toBe("branched reply");

    const anns = (await readAnnotations(docPath)).annotations;
    const parentAnchor = anns.find((a) => a.id === "c0001")!.anchor.exact;
    expect(anns.find((a) => a.id === res.branchThreadId)?.anchor.exact).toBe(parentAnchor);

    const sid = db.get(res.branchThreadId)!.piSessionId!;
    // branchFromTurn 0 → no prior turns, so history is empty; the edited message is
    // the current comment, not history.
    expect((runner.contextFor(sid)?.history ?? []).length).toBe(0);
    // Phase 10: branch is a conversation turn too (forking is still just discussing) —
    // never edits or proposes.
    expect(runner.contextFor(sid)?.allowEdit).toBe(false);
    expect(runner.contextFor(sid)?.conversationOnly).toBe(true);

    // parent thread untouched
    expect((await readThread(docPath, "c0001")).turns[0].body).toBe("orig question");
    expect(db.get(res.branchThreadId)?.status).toBe("responded");
  });

  it("seeds prior turns as history and resumes from a later turn", async () => {
    await seedComment();
    const runner = new FakePiRunner([{ reply: "a1" }, { reply: "a2" }, { reply: "a3" }]);
    const orch = new Orchestrator({ runner, db, now: () => "t" });
    await orch.discuss(docPath, { threadId: "c0001", annotationId: "c0001", stance: "none", comment: "q1" });
    await orch.reply(docPath, "c0001", "q2"); // parent now: you q1, agent a1, you q2, agent a2

    // edit the 3rd turn (index 2, the "you q2") and branch
    const res = await orch.branch(docPath, "c0001", 2, "q2-revised", { doc: "latest" });
    const branch = await readThread(docPath, res.branchThreadId);
    // seeded prior turns (q1, a1) + edited you (q2-revised) + new agent (a3)
    expect(branch.turns.map((t) => t.body)).toEqual(["q1", "a1", "q2-revised", "a3"]);
    const sid = db.get(res.branchThreadId)!.piSessionId!;
    const hist = runner.contextFor(sid)?.history?.map((h) => h.body) ?? [];
    expect(hist).toContain("q1");
    expect(hist).toContain("a1");
    expect(hist).not.toContain("q2-revised"); // the edited msg is the current comment, not history
  });

  it("uses the doc at that turn when doc:'at-turn'", async () => {
    await seedComment();
    const runner = new FakePiRunner([{ reply: "r1" }, { reply: "r2" }]);
    const orch = new Orchestrator({ runner, db, now: () => "t" });
    await orch.discuss(docPath, { threadId: "c0001", annotationId: "c0001", stance: "none", comment: "q" });
    const v = (await readThread(docPath, "c0001")).turns[0].docVersion!;
    await writeFile(docPath, "TOTALLY DIFFERENT DOC\n", "utf8"); // mutate after the turn

    const res = await orch.branch(docPath, "c0001", 0, "q2", { doc: "at-turn" });
    const sid = db.get(res.branchThreadId)!.piSessionId!;
    expect(runner.contextFor(sid)?.docText).toContain("Redis");        // original doc, not the mutation
    expect((await readThread(docPath, res.branchThreadId)).frontmatter.baseVersion).toBe(v);
  });

  it("rejects branching from a non-you turn or an out-of-range index", async () => {
    await seedComment();
    const runner = new FakePiRunner([{ reply: "a1" }]);
    const orch = new Orchestrator({ runner, db, now: () => "t" });
    await orch.discuss(docPath, { threadId: "c0001", annotationId: "c0001", stance: "none", comment: "q1" });
    // index 1 is the agent turn, not a "you" turn
    await expect(orch.branch(docPath, "c0001", 1, "x", { doc: "latest" })).rejects.toThrow();
    // out of range
    await expect(orch.branch(docPath, "c0001", 99, "x", { doc: "latest" })).rejects.toThrow();
  });
});

// Phase 9 T2b: mirrors "Orchestrator.reply into an annotation-less thread" above —
// branch() now tolerates a missing PARENT annotation (directive-N threads, the
// "review" umbrella) the same way reply()/resumeFromTranscript already do.
describe("Orchestrator.branch into an annotation-less thread", () => {
  it("forks a seeded annotation-less directive-style thread with an empty anchor context", async () => {
    const runner = new FakePiRunner([{ reply: "Branch reply." }]);
    const orch = new Orchestrator({ runner, db, now: () => "t" });
    // Mirror what resolveDirectives leaves behind: a real thread with you+agent
    // turns, but NO addAnnotation call — directive-N threads never get one.
    await initThread(docPath, {
      id: "directive-1",
      anchorExact: "[[ make it formal ]]",
      stance: "none",
      status: "responded",
      piSession: "sessions/directive-1.session.jsonl",
      harness: "pi",
    });
    await appendTurn(docPath, "directive-1", {
      role: "you",
      timestamp: "t0",
      body: "Resolve inline directive:\n[[ make it formal ]]\n\nMake it formal.",
    });
    await appendTurn(docPath, "directive-1", {
      role: "agent",
      timestamp: "t0",
      meta: "directives",
      body: "done",
    });
    expect(
      (await readAnnotations(docPath)).annotations.find((a) => a.id === "directive-1"),
    ).toBeUndefined();

    const res = await orch.branch(docPath, "directive-1", 0, "Actually, keep it casual.", {
      doc: "latest",
    });
    expect(res.branchThreadId).not.toBe("directive-1");

    const branch = await readThread(docPath, res.branchThreadId);
    expect(branch.frontmatter.parent).toBe("directive-1");
    expect(branch.frontmatter.branchFromTurn).toBe(0);
    expect(branch.turns[0].body).toBe("Actually, keep it casual.");
    expect(branch.turns.at(-1)?.role).toBe("agent");
    expect(branch.turns.at(-1)?.body).toBe("Branch reply.");
    expect(db.get(res.branchThreadId)?.status).toBe("responded");

    // Fresh agent turn actually ran through FakePiRunner with an empty anchor/
    // surrounding — same "no highlight" prompt shape as an annotation-less reply().
    const sid = db.get(res.branchThreadId)!.piSessionId!;
    const ctx = runner.contextFor(sid)!;
    expect(ctx.anchorExact).toBe("");
    expect(ctx.surrounding).toBe("");

    // Parent thread untouched.
    expect((await readThread(docPath, "directive-1")).turns.map((t) => t.body)).toEqual([
      "Resolve inline directive:\n[[ make it formal ]]\n\nMake it formal.",
      "done",
    ]);
  });

  it("forks a seeded annotation-less review-umbrella-style thread with an empty anchor context", async () => {
    const runner = new FakePiRunner([{ reply: "Branch reply." }]);
    const orch = new Orchestrator({ runner, db, now: () => "t" });
    // Mirror what review() leaves behind for the umbrella thread: no addAnnotation
    // call for "review" itself (only per-finding comment threads get one).
    await initThread(docPath, {
      id: "review",
      anchorExact: "",
      stance: "none",
      status: "responded",
      piSession: "sessions/review.session.jsonl",
      harness: "pi",
    });
    await appendTurn(docPath, "review", {
      role: "you",
      timestamp: "t0",
      body: "Review the document for risks, gaps, unclear passages, and concrete improvements.",
    });
    await appendTurn(docPath, "review", {
      role: "agent",
      timestamp: "t0",
      meta: "review",
      body: "(findings filed as comments)",
    });
    expect(
      (await readAnnotations(docPath)).annotations.find((a) => a.id === "review"),
    ).toBeUndefined();

    const res = await orch.branch(docPath, "review", 0, "Focus only on the TTL choice.", {
      doc: "latest",
    });
    const branch = await readThread(docPath, res.branchThreadId);
    expect(branch.frontmatter.parent).toBe("review");
    expect(branch.turns[0].body).toBe("Focus only on the TTL choice.");
    expect(branch.turns.at(-1)?.body).toBe("Branch reply.");
    expect(db.get(res.branchThreadId)?.status).toBe("responded");

    const sid = db.get(res.branchThreadId)!.piSessionId!;
    const ctx = runner.contextFor(sid)!;
    expect(ctx.anchorExact).toBe("");
    expect(ctx.surrounding).toBe("");
  });

  it("still errors branching a thread that doesn't exist", async () => {
    const runner = new FakePiRunner([]); // would throw if start/send were called
    const orch = new Orchestrator({ runner, db, now: () => "t" });
    await expect(
      orch.branch(docPath, "does-not-exist", 0, "x", { doc: "latest" }),
    ).rejects.toThrow();
  });

  it("keeps an anchored parent's branch behavior byte-identical (uses the parent annotation)", async () => {
    await seedComment();
    const runner = new FakePiRunner([{ reply: "first" }, { reply: "branched reply" }]);
    const orch = new Orchestrator({ runner, db, now: () => "t" });
    await orch.discuss(docPath, { threadId: "c0001", annotationId: "c0001", stance: "none", comment: "orig question" });

    const res = await orch.branch(docPath, "c0001", 0, "revised question", { doc: "latest" });
    const sid = db.get(res.branchThreadId)!.piSessionId!;
    const ctx = runner.contextFor(sid)!;
    const parentAnchor = (await readAnnotations(docPath)).annotations.find((a) => a.id === "c0001")!
      .anchor.exact;
    // Unchanged from before this task: an anchored parent still hands the branch
    // the real anchor text, not an empty one.
    expect(ctx.anchorExact).toBe(parentAnchor);
  });

  it("the fork is itself chattable (reply) and forkable (a fork of a fork keeps a unique id)", async () => {
    const runner = new FakePiRunner([
      { reply: "first branch reply" },
      { reply: "second branch reply" },
      { reply: "follow-up reply" },
    ]);
    const orch = new Orchestrator({ runner, db, now: () => "t" });
    await initThread(docPath, {
      id: "directive-1",
      anchorExact: "[[ x ]]",
      stance: "none",
      status: "responded",
      piSession: "sessions/directive-1.session.jsonl",
      harness: "pi",
    });
    await appendTurn(docPath, "directive-1", { role: "you", timestamp: "t0", body: "Resolve [[ x ]]" });
    await appendTurn(docPath, "directive-1", {
      role: "agent",
      timestamp: "t0",
      meta: "directives",
      body: "done",
    });

    const first = await orch.branch(docPath, "directive-1", 0, "first edit", { doc: "latest" });
    const second = await orch.branch(docPath, first.branchThreadId, 0, "second edit", { doc: "latest" });

    // No id collision: the second fork got its own thread file, distinct from the first.
    expect(second.branchThreadId).not.toBe(first.branchThreadId);
    expect(second.branchThreadId).not.toBe("directive-1");
    const secondThread = await readThread(docPath, second.branchThreadId);
    expect(secondThread.frontmatter.parent).toBe(first.branchThreadId);
    expect(secondThread.turns[0].body).toBe("second edit");
    expect(secondThread.turns.at(-1)?.body).toBe("second branch reply");
    // The first fork's own thread is untouched by forking IT.
    const firstThread = await readThread(docPath, first.branchThreadId);
    expect(firstThread.turns[0].body).toBe("first edit");
    expect(firstThread.turns.at(-1)?.body).toBe("first branch reply");

    // The fork is chattable too — reply() keeps working on it normally (Phase-8 T2b's
    // tolerant lookup covers it either way: found here since branch() always leaves the
    // fork itself a real bookkeeping annotation — see branch()'s own comment — but reply()
    // degrades to the same empty-anchor shape if that were ever absent).
    await orch.reply(docPath, first.branchThreadId, "one more note");
    const afterReply = await readThread(docPath, first.branchThreadId);
    expect(afterReply.turns.map((t) => t.body)).toEqual([
      "first edit",
      "first branch reply",
      "one more note",
      "follow-up reply",
    ]);
  });
});
