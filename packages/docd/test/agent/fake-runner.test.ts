import { describe, it, expect } from "vitest";
import { FakePiRunner } from "../../src/agent/fake-runner.js";
import type { AgentContext } from "../../src/agent/types.js";

const ctx: AgentContext = {
  docText: "store in Redis",
  anchorExact: "Redis",
  surrounding: "store in Redis with a TTL",
  comment: "Why Redis?",
  stancePrompt: "Challenge the text.",
};

describe("FakePiRunner", () => {
  it("returns scripted turns in order and assigns a session id", async () => {
    const runner = new FakePiRunner([
      { reply: "Because it is shared." },
      {
        reply: "Switching to in-memory.",
        proposal: { rationale: "single node", hunks: [{ oldText: "Redis", newText: "in-memory" }] },
      },
    ]);
    const first = await runner.start(ctx);
    expect(first.sessionId).toMatch(/.+/);
    expect(first.turn.reply).toBe("Because it is shared.");
    const second = await runner.send(first.sessionId, "But we have one node.");
    expect(second.reply).toBe("Switching to in-memory.");
    expect(second.proposal?.hunks?.[0].newText).toBe("in-memory");
  });

  it("records the context it was started with (for assertions)", async () => {
    const runner = new FakePiRunner([{ reply: "ok" }]);
    const { sessionId } = await runner.start(ctx);
    expect(runner.contextFor(sessionId)?.comment).toBe("Why Redis?");
  });

  it("streams the scripted reply through onToken when provided", async () => {
    const runner = new FakePiRunner([{ reply: "streamed reply" }]);
    const chunks: string[] = [];
    const { turn } = await runner.start(ctx, (e) => chunks.push(e.text));
    expect(chunks.join("")).toBe("streamed reply");
    expect(turn.reply).toBe("streamed reply");
  });

  it("throws if scripted turns are exhausted", async () => {
    const runner = new FakePiRunner([{ reply: "only one" }]);
    const { sessionId } = await runner.start(ctx);
    await expect(runner.send(sessionId, "more?")).rejects.toThrow(/exhausted/);
  });
});

const mkCtx = (over: Partial<AgentContext> = {}): AgentContext => ({
  docText: "doc",
  anchorExact: "x",
  surrounding: "x",
  comment: "c",
  stancePrompt: "",
  ...over,
});

describe("AgentContext.modelId", () => {
  it("is carried through start() so the runner can pick a model per session", async () => {
    const runner = new FakePiRunner([{ reply: "ok" }]);
    const { sessionId } = await runner.start(mkCtx({ modelId: "anthropic/claude" }));
    expect(runner.contextFor(sessionId)?.modelId).toBe("anthropic/claude");
  });
});
