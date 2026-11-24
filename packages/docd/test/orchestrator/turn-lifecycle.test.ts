// What happens to a turn while it is still running: the document changing underneath it,
// Stop, a second request for the same thread, a doc reopen, and the comment being deleted.
// The gated runner below parks every start()/send() until the test releases it, so each
// test can act in the middle of a turn. Its cancel() mirrors PiRunner's: it resolves the
// parked turn normally with whatever had streamed so far.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Orchestrator } from "../../src/orchestrator/orchestrator.js";
import { TaskDB } from "../../src/state/task-db.js";
import { hadPaths } from "../../src/had/paths.js";
import {
  addAnnotation,
  addProposal,
  listProposals,
  readThread,
  readSettings,
  writeSettings,
} from "../../src/had/index.js";
import { createAnchor } from "../../src/anchor/index.js";
import { HarnessRegistry, PI_CAPABILITIES } from "../../src/agent/harness-registry.js";
import { handoffTranscript } from "../../src/orchestrator/context.js";
import { FakePiRunner } from "../../src/agent/fake-runner.js";
import type { AgentContext, AgentRunner, AgentTurn } from "../../src/agent/types.js";

const DOC = "# Plan\n\nWe store limits in Redis with a TTL.\n\nRollout goes to 5% first.\n";
const SENTENCE = "We store limits in Redis with a TTL.";

let dir: string;
let docPath: string;
let db: TaskDB;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "turn-life-"));
  docPath = join(dir, "plan.md");
  await writeFile(docPath, DOC, "utf8");
  db = new TaskDB(hadPaths(docPath).stateDb);
});
afterEach(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true });
});

async function seedComment(id = "c0001", exact = SENTENCE) {
  const start = DOC.indexOf(exact);
  await addAnnotation(docPath, {
    id,
    type: "comment",
    anchor: createAnchor(DOC, start, start + exact.length),
    status: "open",
    thread: `threads/${id}.md`,
    session: `sessions/${id}.session.jsonl`,
    createdAt: "t",
  });
}
const editing = () => writeSettings(docPath, { scope: "folder", agentEdit: "direct" });

interface Parked {
  kind: "start" | "send";
  ctx?: AgentContext;
  message?: string;
  cancelKey?: string;
  resolve: (t: AgentTurn) => void;
  reject: (e: unknown) => void;
}

/** A runner whose every turn waits for the test to finish it. */
class GatedRunner implements AgentRunner {
  readonly parked: Parked[] = [];
  readonly cancelled: string[] = [];
  readonly sessions = new Set<string>();
  private seq = 0;
  private keyBySession = new Map<string, string | undefined>();

  async start(ctx: AgentContext): Promise<{ sessionId: string; turn: AgentTurn }> {
    const sessionId = `g-${++this.seq}`;
    this.sessions.add(sessionId);
    this.keyBySession.set(sessionId, ctx.cancelKey);
    const turn = await new Promise<AgentTurn>((resolve, reject) =>
      this.parked.push({ kind: "start", ctx, cancelKey: ctx.cancelKey, resolve, reject }),
    );
    return { sessionId, turn };
  }
  send(sessionId: string, message: string): Promise<AgentTurn> {
    return new Promise<AgentTurn>((resolve, reject) =>
      this.parked.push({ kind: "send", message, cancelKey: this.keyBySession.get(sessionId), resolve, reject }),
    );
  }
  async cancel(cancelKey: string): Promise<void> {
    this.cancelled.push(cancelKey);
    // PiRunner semantics: the aborted turn resolves normally with the partial reply.
    for (const p of this.parked.splice(0)) {
      if (p.cancelKey === cancelKey) p.resolve({ reply: "" });
      else this.parked.push(p);
    }
  }
  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }
  /** Wait until `n` turns are parked. */
  async waitForParked(n = 1): Promise<void> {
    await vi.waitFor(() => expect(this.parked.length).toBeGreaterThanOrEqual(n));
  }
  /** Finish the oldest parked turn. */
  finish(turn: AgentTurn): void {
    const p = this.parked.shift();
    if (!p) throw new Error("nothing parked");
    p.resolve(turn);
  }
  fail(err: Error): void {
    const p = this.parked.shift();
    if (!p) throw new Error("nothing parked");
    p.reject(err);
  }
}

describe("a proposal's base is the document the agent saw (H8)", () => {
  it("Editing mode refuses a full rewrite when the user saved an edit while the agent was working", async () => {
    const withDirective = DOC.replace("Rollout goes to 5% first.", "Rollout goes to 5% first. [[ say which region ]]");
    await writeFile(docPath, withDirective, "utf8");
    await editing();
    const runner = new GatedRunner();
    const orch = new Orchestrator({ runner, db, now: () => "t" });

    const pass = orch.resolveDirectives(docPath);
    await runner.waitForParked();
    // The user saves an edit while the agent is still thinking.
    const userEdit = withDirective.replace("# Plan", "# Plan (reviewed by ops)");
    await writeFile(docPath, userEdit, "utf8");
    // The agent's rewrite was computed against the document BEFORE that save.
    const rewrite = withDirective.replace(" [[ say which region ]]", " Region: eu-west-1.");
    runner.finish({ reply: "Done.", proposal: { rationale: "resolve", fullRewrite: rewrite } });
    const res = await pass;

    expect(res.applied).toBe(0);
    expect(await readFile(docPath, "utf8")).toBe(userEdit);
    const [p] = await listProposals(docPath, "directive-1");
    expect(p.status).toBe("pending");
  });

  it("Suggesting mode refuses to approve a rewrite made against text the user changed during the turn", async () => {
    const runner = new GatedRunner();
    const orch = new Orchestrator({ runner, db, now: () => "t" });

    const review = orch.review(docPath, { stance: "none" });
    await runner.waitForParked();
    const userEdit = DOC.replace("Rollout goes to 5% first.", "Rollout goes to 10% first.");
    await writeFile(docPath, userEdit, "utf8");
    // Rewritten from the text the agent was given, which still says 5%.
    const rewrite = DOC.replace("Redis with a TTL", "Redis (shared across nodes) with a TTL");
    runner.finish({
      reply: "",
      findings: [{ anchorText: "Redis", comment: "Say why Redis.", fullRewrite: rewrite }],
    });
    const { findings } = await review;
    const proposalId = findings[0].proposalId!;
    await expect(orch.approveProposal(docPath, findings[0].annotationId, proposalId)).rejects.toThrow(
      /document changed/,
    );
    expect(await readFile(docPath, "utf8")).toBe(userEdit);
  });
});

describe("Stop (H11)", () => {
  it("a stopped markdown Improve in Editing mode changes nothing and records no proposal", async () => {
    await seedComment();
    await editing();
    const runner = new GatedRunner();
    const orch = new Orchestrator({ runner, db, now: () => "t" });

    const improve = orch.improve(docPath, "c0001");
    await runner.waitForParked();
    await orch.cancel(docPath, "c0001");

    await expect(improve).rejects.toThrow(/stopped/i);
    expect(await readFile(docPath, "utf8")).toBe(DOC);
    expect(await listProposals(docPath, "c0001")).toEqual([]);
    expect(db.get("c0001")?.status).toBe("error");
  });

  it("an Improve whose reply is empty is refused instead of deleting the passage", async () => {
    await seedComment();
    await editing();
    const orch = new Orchestrator({ runner: new FakePiRunner([{ reply: "  \n" }]), db, now: () => "t" });

    await expect(orch.improve(docPath, "c0001")).rejects.toThrow(/no replacement text/i);
    expect(await readFile(docPath, "utf8")).toBe(DOC);
    expect(await listProposals(docPath, "c0001")).toEqual([]);
  });

  it("a stopped Panel does not go on to ask the remaining models", async () => {
    await seedComment();
    const runner = new GatedRunner();
    const orch = new Orchestrator({ runner, db, now: () => "t" });

    const panel = orch.panel(
      docPath,
      { threadId: "c0001", annotationId: "c0001", stance: "none", comment: "Why Redis?" },
      ["p/m1", "p/m2", "p/m3"],
    );
    await runner.waitForParked();
    await orch.cancel(docPath, "c0001");
    await panel;

    // Only the first model was ever started.
    expect(runner.parked).toHaveLength(0);
    const thread = await readThread(docPath, "c0001");
    expect(thread.turns.filter((t) => t.role === "agent").map((t) => t.meta)).toEqual(["p/m1"]);
    expect(db.get("c0001")?.status).toBe("responded");
  });

  it("a Stop that arrives when nothing is running does not leak into the next turn", async () => {
    await seedComment();
    await editing();
    const orch = new Orchestrator({ runner: new FakePiRunner([{ reply: "Limits live in Redis with a TTL." }]), db, now: () => "t" });
    await orch.cancel(docPath, "c0001");

    const res = await orch.improve(docPath, "c0001");
    expect(res.applied).toBe(true);
  });
});

/** Codex's and the ACP runner's Stop: the turn rejects ("… run cancelled") after streaming. */
class RejectOnStopRunner implements AgentRunner {
  private parked: { key?: string; reject: (e: unknown) => void; resolve: (t: AgentTurn) => void }[] = [];
  async start(ctx: AgentContext, onToken?: (e: { type: "token" | "thinking"; text: string }) => void) {
    onToken?.({ type: "thinking", text: "Weighing it." });
    onToken?.({ type: "token", text: "Redis is shared " });
    onToken?.({ type: "token", text: "across nodes" });
    const turn = await new Promise<AgentTurn>((resolve, reject) => this.parked.push({ key: ctx.cancelKey, resolve, reject }));
    return { sessionId: "r-1", turn };
  }
  send(): Promise<AgentTurn> {
    return new Promise<AgentTurn>((resolve, reject) => this.parked.push({ resolve, reject }));
  }
  async cancel(key: string): Promise<void> {
    for (const p of this.parked.splice(0)) if (p.key === key) p.reject(new Error("Codex run cancelled"));
  }
  hasSession(): boolean {
    return false;
  }
  get waiting(): number {
    return this.parked.length;
  }
  finish(reply: string): void {
    this.parked.shift()!.resolve({ reply });
  }
}

describe("Stop on a harness that rejects a stopped turn (Codex, Claude Code)", () => {
  it("is not an error: the turn keeps what had streamed, like Pi, and the thread goes on", async () => {
    await seedComment();
    const runner = new RejectOnStopRunner();
    const orch = new Orchestrator({ runner, db, now: () => "t" });
    const asked = orch.discuss(docPath, { threadId: "c0001", annotationId: "c0001", stance: "none", comment: "Why Redis?" });
    await vi.waitFor(() => expect(runner.waiting).toBe(1));
    await orch.cancel(docPath, "c0001");
    await expect(asked).resolves.toBeUndefined();

    let thread = await readThread(docPath, "c0001");
    expect(thread.turns.map((t) => [t.role, t.body])).toEqual([["you", "Why Redis?"], ["agent", "Redis is shared across nodes"]]);
    expect(thread.turns[1].thinking).toBe("Weighing it.");
    expect(db.get("c0001")?.status).toBe("responded");

    // The stopped start left no session: the next reply replays the thread and answers.
    const next = orch.reply(docPath, "c0001", "And the TTL?");
    await vi.waitFor(() => expect(runner.waiting).toBe(1));
    runner.finish("It expires stale limits.");
    await next;
    thread = await readThread(docPath, "c0001");
    expect(thread.turns.map((t) => t.body).slice(-2)).toEqual(["And the TTL?", "It expires stale limits."]);
  });
});

describe("one turn per thread (M17)", () => {
  it("refuses a second discuss on a thread whose first is still running, without touching its transcript", async () => {
    await seedComment();
    const runner = new GatedRunner();
    const orch = new Orchestrator({ runner, db, now: () => "t" });
    const args = { threadId: "c0001", annotationId: "c0001", stance: "none", comment: "Why Redis?" };

    const first = orch.discuss(docPath, args);
    await runner.waitForParked();
    await expect(orch.discuss(docPath, { ...args, comment: "again" })).rejects.toThrow(/already running/);
    await expect(orch.reply(docPath, "c0001", "and?")).rejects.toThrow(/already running/);
    await expect(orch.improve(docPath, "c0001")).rejects.toThrow(/already running/);

    runner.finish({ reply: "Shared across nodes." });
    await first;
    const thread = await readThread(docPath, "c0001");
    expect(thread.turns.map((t) => t.body)).toEqual(["Why Redis?", "Shared across nodes."]);
    expect(runner.parked).toHaveLength(0);
  });

  it("frees the thread once its turn settles, including after a failure", async () => {
    await seedComment();
    const runner = new GatedRunner();
    const orch = new Orchestrator({ runner, db, now: () => "t" });
    const args = { threadId: "c0001", annotationId: "c0001", stance: "none", comment: "Why Redis?" };

    const first = orch.discuss(docPath, args);
    await runner.waitForParked();
    runner.fail(new Error("model unavailable"));
    await expect(first).rejects.toThrow("model unavailable");

    const retry = orch.discuss(docPath, args);
    await runner.waitForParked();
    runner.finish({ reply: "ok" });
    await expect(retry).resolves.toBeUndefined();
  });

  it("turns on different threads run side by side", async () => {
    await seedComment("c0001");
    await seedComment("c0002", "Rollout goes to 5% first.");
    const runner = new GatedRunner();
    const orch = new Orchestrator({ runner, db, now: () => "t" });

    const a = orch.discuss(docPath, { threadId: "c0001", annotationId: "c0001", stance: "none", comment: "a" });
    const b = orch.discuss(docPath, { threadId: "c0002", annotationId: "c0002", stance: "none", comment: "b" });
    await runner.waitForParked(2);
    runner.finish({ reply: "ra" });
    runner.finish({ reply: "rb" });
    await Promise.all([a, b]);
    expect(db.get("c0001")?.status).toBe("responded");
    expect(db.get("c0002")?.status).toBe("responded");
  });

  it("refuses a second directive pass on the same document while the first is running", async () => {
    await writeFile(docPath, DOC.replace("first.", "first. [[ name the region ]]"), "utf8");
    const runner = new GatedRunner();
    const orch = new Orchestrator({ runner, db, now: () => "t" });

    const first = orch.resolveDirectives(docPath);
    await runner.waitForParked();
    await expect(orch.resolveDirectives(docPath)).rejects.toThrow(/already/);
    runner.finish({ reply: "no edit" });
    await expect(first).resolves.toMatchObject({ count: 1 });
    // And a later pass is allowed again.
    const again = orch.resolveDirectives(docPath);
    await runner.waitForParked();
    runner.finish({ reply: "no edit" });
    await expect(again).resolves.toMatchObject({ count: 1 });
  });
});

describe("reconcile leaves turns that are running in this process alone (H7)", () => {
  it("a doc reopen mid-turn does not mark the live turn interrupted", async () => {
    await seedComment();
    const runner = new GatedRunner();
    const orch = new Orchestrator({ runner, db, now: () => "t" });

    const turn = orch.discuss(docPath, { threadId: "c0001", annotationId: "c0001", stance: "none", comment: "q" });
    await runner.waitForParked();
    const result = await orch.reconcile(docPath);

    expect(result.errored).toEqual([]);
    expect(db.get("c0001")?.status).toBe("running");
    runner.finish({ reply: "a" });
    await turn;
    expect(db.get("c0001")?.status).toBe("responded");
  });

  it("still reconciles rows nothing in this process is running", async () => {
    await seedComment();
    db.upsert({ threadId: "c0009", status: "running", piSessionId: null });
    const runner = new GatedRunner();
    const orch = new Orchestrator({ runner, db, now: () => "t" });

    const turn = orch.discuss(docPath, { threadId: "c0001", annotationId: "c0001", stance: "none", comment: "q" });
    await runner.waitForParked();
    const result = await orch.reconcile(docPath);
    expect(result.errored).toEqual(["c0009"]);
    runner.finish({ reply: "a" });
    await turn;
  });
});

describe("deleting a comment mid-turn (M12)", () => {
  it("cancels the live turn and leaves no task row behind", async () => {
    await seedComment();
    const runner = new GatedRunner();
    const orch = new Orchestrator({ runner, db, now: () => "t" });

    const turn = orch.discuss(docPath, { threadId: "c0001", annotationId: "c0001", stance: "none", comment: "q" });
    await runner.waitForParked();
    await orch.discardThread(docPath, "c0001");
    expect(runner.cancelled).toContain(`${docPath}#c0001`);
    await turn.catch(() => undefined);

    expect(db.get("c0001")).toBeNull();
  });

  it("removes a finished thread's task row", async () => {
    await seedComment();
    const orch = new Orchestrator({ runner: new FakePiRunner([{ reply: "a" }]), db, now: () => "t" });
    await orch.discuss(docPath, { threadId: "c0001", annotationId: "c0001", stance: "none", comment: "q" });
    await orch.discardThread(docPath, "c0001");
    expect(db.get("c0001")).toBeNull();
  });
});

describe("review findings get their own conversations (H9)", () => {
  it("a reply to a finding starts a fresh anchored conversation, not the shared review session", async () => {
    const runner = new FakePiRunner([
      {
        reply: "",
        findings: [
          { anchorText: "Redis", comment: "Why Redis?" },
          { anchorText: "5%", comment: "Why 5%?" },
        ],
      },
      { reply: "Because it is shared." },
    ]);
    const orch = new Orchestrator({ runner, db, now: () => "t" });
    const { findings } = await orch.review(docPath, { stance: "none" });
    const reviewSession = runner.lastSessionId();

    for (const f of findings) expect(db.get(f.annotationId)?.piSessionId).toBeNull();
    expect(db.get("review")?.piSessionId).toBeNull();

    await orch.reply(docPath, findings[0].annotationId, "Explain more");
    expect(runner.sentMessages).toEqual([]);
    const sid = runner.lastSessionId()!;
    expect(sid).not.toBe(reviewSession);
    const ctx = runner.contextFor(sid)!;
    expect(ctx.reviewMode).toBeUndefined();
    expect(ctx.conversationOnly).toBe(true);
    expect(ctx.anchorExact).toBe("Redis");
  });
});

describe("handoff in the same discussion", () => {
  it("transfers visible history and document context and commits the destination only after success", async () => {
    await seedComment();
    await writeSettings(docPath, { scope: "folder", harness: "pi", instructions: "Keep the rollout gradual." });
    const pi = new FakePiRunner([{ reply: "Agreed on Juniper." }]);
    const claude = new FakePiRunner([{ reply: "The code is Juniper." }, { reply: "Continuing." }]);
    const registry = HarnessRegistry.single(pi);
    registry.register({ id: "claude-code", label: "Claude Code", capabilities: PI_CAPABILITIES, runner: claude, available: true });
    registry.register({ id: "codex", label: "Codex", capabilities: PI_CAPABILITIES, runner: new FakePiRunner([]), available: true });
    const orch = new Orchestrator({ registry, db, now: () => "t" });
    await orch.discuss(docPath, { threadId: "c0001", annotationId: "c0001", stance: "none", comment: "Our code is Juniper." });
    await orch.reply(docPath, "c0001", "What was our code?", undefined, undefined, "claude-code:haiku", "claude-code");
    const context = claude.contextFor(claude.lastSessionId()!);
    expect(context).toMatchObject({ docText: DOC, anchorExact: SENTENCE, instructions: "Keep the rollout gradual.", modelId: "claude-code:haiku",
      history: [{ role: "you", body: "Our code is Juniper." }, { role: "agent", body: "Agreed on Juniper." }] });
    const thread = await readThread(docPath, "c0001");
    expect(thread.frontmatter).toMatchObject({ harness: "claude-code", model: "claude-code:haiku" });
    expect(thread.turns).toHaveLength(4);
    // Each reply names the harness and model that wrote it, and the switch.
    expect(thread.turns.filter((t) => t.role === "agent").map((t) => t.meta)).toEqual(["none · Pi", "none · Claude Code · claude-code:haiku · from Pi"]);
    await orch.reply(docPath, "c0001", "Continue");
    expect(claude.sentMessages).toEqual(["Continue"]);
    await expect(orch.reply(docPath, "c0001", "Switch", undefined, undefined, "codex:test", "codex")).rejects.toThrow();
    expect((await readThread(docPath, "c0001")).frontmatter).toMatchObject({ harness: "claude-code", model: "claude-code:haiku" });
  });

  it("Ask all models in a discussion keeps its transcript and gives each model the discussion so far", async () => {
    await seedComment();
    const pi = new FakePiRunner([{ reply: "Redis is shared." }, { reply: "m1 view" }, { reply: "m2 view" }]);
    const orch = new Orchestrator({ registry: HarnessRegistry.single(pi), db, now: () => "t" });
    await orch.discuss(docPath, { threadId: "c0001", annotationId: "c0001", stance: "none", comment: "Why Redis?" });
    await orch.panel(docPath, { threadId: "c0001", annotationId: "c0001", stance: "none", comment: "Compare." }, ["p/m1", "p/m2"]);
    const thread = await readThread(docPath, "c0001");
    expect(thread.turns.map((t) => t.body)).toEqual(["Why Redis?", "Redis is shared.", "Compare.", "m1 view", "m2 view"]);
    expect(pi.contextFor(pi.lastSessionId()!)?.history).toEqual([
      { role: "you", body: "Why Redis?" },
      { role: "agent", body: "Redis is shared." },
    ]);
  });

  it("Ask all models runs on the discussion's own harness, and is refused on one that can't fan out", async () => {
    await seedComment();
    const pi = new FakePiRunner([{ reply: "Pi answer." }, { reply: "m1 view" }]);
    const codex = new FakePiRunner([{ reply: "Codex answer." }]);
    const registry = HarnessRegistry.single(pi);
    registry.register({ id: "codex", label: "Codex", capabilities: { ...PI_CAPABILITIES, multiModelPanel: false }, runner: codex, available: true });
    const orch = new Orchestrator({ registry, db, now: () => "t" });
    await orch.discuss(docPath, { threadId: "c0001", annotationId: "c0001", stance: "none", comment: "Why Redis?" });
    // The document moves to Codex; the Pi discussion's panel still runs on Pi.
    await writeSettings(docPath, { scope: "folder", harness: "codex" });
    await orch.panel(docPath, { threadId: "c0001", annotationId: "c0001", stance: "none", comment: "Compare." }, ["p/m1"]);
    expect(codex.sentMessages).toEqual([]);
    expect((await readThread(docPath, "c0001")).frontmatter.harness).toBe("pi");

    await seedComment("c0002", "Rollout goes to 5% first.");
    await orch.discuss(docPath, { threadId: "c0002", annotationId: "c0002", stance: "none", comment: "Why 5%?" });
    const before = await readThread(docPath, "c0002");
    await expect(orch.panel(docPath, { threadId: "c0002", annotationId: "c0002", stance: "none", comment: "Compare." }, ["p/m1"]))
      .rejects.toThrow(/Codex can't ask several models/);
    expect((await readThread(docPath, "c0002")).turns).toEqual(before.turns);
  });

  it("a document keeps the harness its first discussion ran on when the app default moves", async () => {
    const cfgDir = await mkdtemp(join(tmpdir(), "turn-life-cfg-"));
    process.env.DOCUZEN_CONFIG_DIR = cfgDir;
    try {
      await writeFile(join(cfgDir, "config.toml"), '[harness]\ndefault = "pi"\n');
      await seedComment();
      const pi = new FakePiRunner([{ reply: "Pi one." }, { reply: "Pi two." }]);
      const codex = new FakePiRunner([{ reply: "Codex." }]);
      const registry = HarnessRegistry.single(pi);
      registry.register({ id: "codex", label: "Codex", capabilities: PI_CAPABILITIES, runner: codex, available: true });
      const orch = new Orchestrator({ registry, db, now: () => "t" });
      await orch.discuss(docPath, { threadId: "c0001", annotationId: "c0001", stance: "none", comment: "Why Redis?" });
      // Another document's Settings makes Codex the app default (setSettings writes it through).
      await writeFile(join(cfgDir, "config.toml"), '[harness]\ndefault = "codex"\n');
      expect((await readSettings(docPath)).harness).toBe("pi");
      await seedComment("c0002", "Rollout goes to 5% first.");
      await orch.discuss(docPath, { threadId: "c0002", annotationId: "c0002", stance: "none", comment: "Why 5%?" });
      expect((await readThread(docPath, "c0002")).frontmatter.harness).toBe("pi");
      expect(codex.lastSessionId()).toBeUndefined();
    } finally {
      delete process.env.DOCUZEN_CONFIG_DIR;
      await rm(cfgDir, { recursive: true, force: true });
    }
  });

  it("keeps the opening request and the newest context when the transcript exceeds the budget", () => {
    const prior = [{ role: "you" as const, body: "Initial goal" }, { role: "agent" as const, body: "x".repeat(80_000) }, { role: "you" as const, body: "Recent decision" }];
    const result = handoffTranscript(prior, "/tmp/thread.md");
    expect(result.history[0]).toEqual(prior[0]);
    expect(result.history.at(-1)).toEqual(prior.at(-1));
    expect(result.history.map(t => t.body).join("").length).toBeLessThanOrEqual(48_000);
    expect(result.note).toContain("/tmp/thread.md");
  });
});

describe("changing the model mid-thread (M8)", () => {
  it("a reply naming a different model moves the thread to that model and remembers it", async () => {
    await seedComment();
    const runner = new FakePiRunner([{ reply: "a1" }, { reply: "a2" }, { reply: "a3" }]);
    const orch = new Orchestrator({ runner, db, now: () => "t" });
    await orch.discuss(docPath, { threadId: "c0001", annotationId: "c0001", stance: "none", comment: "q1", modelId: "p/old" });

    await orch.reply(docPath, "c0001", "q2", undefined, undefined, "p/new");
    expect(runner.sentMessages).toEqual([]); // not sent into the old model's live session
    const sid = runner.lastSessionId()!;
    expect(runner.contextFor(sid)?.modelId).toBe("p/new");
    expect((await readThread(docPath, "c0001")).frontmatter.model).toBe("p/new");

    // The next reply on the same model continues that live session.
    await orch.reply(docPath, "c0001", "q3", undefined, undefined, "p/new");
    expect(runner.sentMessages).toEqual(["q3"]);
  });
});

describe("branching from the latest doc (M9)", () => {
  it("stamps a version that holds exactly the text the branch reasoned about", async () => {
    await seedComment();
    const runner = new FakePiRunner([{ reply: "a1" }, { reply: "b1" }]);
    const orch = new Orchestrator({ runner, db, now: () => "t" });
    await orch.discuss(docPath, { threadId: "c0001", annotationId: "c0001", stance: "none", comment: "q1" });
    // Edited outside the app: no snapshot was taken for this text.
    const edited = DOC.replace("5%", "1%");
    await writeFile(docPath, edited, "utf8");

    const { branchThreadId } = await orch.branch(docPath, "c0001", 0, "q1 again", { doc: "latest" });
    const baseVersion = (await readThread(docPath, branchThreadId)).frontmatter.baseVersion!;
    expect(baseVersion).toBeTruthy();
    const { readVersion } = await import("../../src/had/index.js");
    expect(await readVersion(docPath, baseVersion)).toBe(edited);
  });
});

describe("a failed reply keeps what it was meant to deliver (M10)", () => {
  it("re-sends reject feedback and the stance change on the retry", async () => {
    await seedComment();
    const runner = new GatedRunner();
    const orch = new Orchestrator({ runner, db, now: () => "t" });
    const first = orch.discuss(docPath, { threadId: "c0001", annotationId: "c0001", stance: "none", comment: "q1" });
    await runner.waitForParked();
    runner.finish({ reply: "a1" });
    await first;
    await addProposal(docPath, {
      id: "p0001",
      threadId: "c0001",
      edits: [{ oldText: "Redis", newText: "Memcached" }],
      rationale: "swap",
      status: "rejected",
      delivered: false,
      at: "t",
    });

    const failing = orch.reply(docPath, "c0001", "q2", undefined, "critiquer");
    await runner.waitForParked();
    expect(runner.parked[0].message).toMatch(/rejected your earlier proposed edit/);
    expect(runner.parked[0].message).toMatch(/Your stance is now/);
    runner.fail(new Error("network down"));
    await expect(failing).rejects.toThrow("network down");
    expect((await listProposals(docPath, "c0001"))[0].delivered).toBe(false);

    const retry = orch.reply(docPath, "c0001", "q2", undefined, "critiquer");
    await runner.waitForParked();
    expect(runner.parked[0].message).toMatch(/rejected your earlier proposed edit/);
    expect(runner.parked[0].message).toMatch(/Your stance is now/);
    runner.finish({ reply: "a2" });
    await retry;
    expect((await listProposals(docPath, "c0001"))[0].delivered).toBe(true);

    // Delivered once: the next reply carries neither.
    const next = orch.reply(docPath, "c0001", "q3", undefined, "critiquer");
    await runner.waitForParked();
    expect(runner.parked[0].message).toBe("q3");
    runner.finish({ reply: "a3" });
    await next;
  });
});
