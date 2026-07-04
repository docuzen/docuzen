import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  serializeThread,
  parseThread,
  initThread,
  appendTurn,
  readThread,
  updateThreadFrontmatter,
  writeThread,
} from "../../src/had/thread.js";
import type { ThreadFile } from "../../src/had/types.js";

let dir: string;
let docPath: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "had-"));
  docPath = join(dir, "plan.md");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const thread: ThreadFile = {
  frontmatter: {
    id: "c0001",
    anchorExact: "stored in Redis",
    stance: "critiquer",
    status: "responded",
    piSession: "sessions/c0001.session.jsonl",
  },
  turns: [
    { role: "you", timestamp: "2026-06-12T10:00:00.000Z", body: "Why Redis?" },
    {
      role: "agent",
      timestamp: "2026-06-12T10:00:30.000Z",
      meta: "critiquer · claude-fable-5",
      body: "In-memory works for one node.",
    },
  ],
};

describe("thread serialize/parse round-trip", () => {
  it("parses what it serializes", () => {
    const text = serializeThread(thread);
    const back = parseThread(text);
    expect(back).toEqual(thread);
  });

  it("serialized form has frontmatter and headed turns", () => {
    const text = serializeThread(thread);
    expect(text).toContain("stance: critiquer");
    expect(text).toContain("## you —");
    expect(text).toContain("## agent (critiquer · claude-fable-5) —");
    expect(text).toContain("Why Redis?");
  });

  it("preserves multi-line and multi-paragraph bodies", () => {
    const multi: ThreadFile = {
      frontmatter: thread.frontmatter,
      turns: [
        {
          role: "agent",
          timestamp: "2026-06-12T10:00:30.000Z",
          meta: "none · m",
          body: "Line one.\n\nLine two after a blank.\n- a bullet",
        },
      ],
    };
    expect(parseThread(serializeThread(multi))).toEqual(multi);
  });
});

describe("thread reasoning (thinking) persistence", () => {
  it("round-trips an agent turn's reasoning, hidden in an HTML comment", () => {
    const t: ThreadFile = {
      frontmatter: thread.frontmatter,
      turns: [
        { role: "you", timestamp: "t1", body: "Why Redis?" },
        {
          role: "agent",
          timestamp: "t2",
          meta: "critiquer · m",
          thinking: "Consider the single-node case.\nRedis adds operational cost.",
          body: "In-memory works for one node.",
        },
      ],
    };
    const text = serializeThread(t);
    // reasoning is stored but hidden from rendered markdown (HTML comment)
    expect(text).toContain("<!--think");
    expect(text).toContain("Redis adds operational cost.");
    // and it is not confused for the reply body
    expect(text).toContain("In-memory works for one node.");
    expect(parseThread(text)).toEqual(t);
  });

  it("omits the comment block (and the field) when a turn has no reasoning", () => {
    const text = serializeThread(thread);
    expect(text).not.toContain("<!--think");
    expect(parseThread(text).turns[1].thinking).toBeUndefined();
  });
});

describe("thread docVersion + lineage persistence", () => {
  it("round-trips per-turn docVersion and lineage frontmatter", () => {
    const t: ThreadFile = {
      frontmatter: {
        id: "c0007", anchorExact: "x", stance: "none", status: "responded",
        piSession: "sessions/c0007.session.jsonl",
        parent: "c0001", branchFromTurn: 2, baseVersion: "v0003", baseDoc: "at-turn",
      },
      turns: [
        { role: "you", timestamp: "t1", body: "edited q", docVersion: "v0003" },
        { role: "agent", timestamp: "t2", meta: "none", body: "a", docVersion: "v0003" },
      ],
    };
    expect(parseThread(serializeThread(t))).toEqual(t);
  });

  it("omits lineage + docVersion when absent (backward compatible)", () => {
    // `thread` is the existing top-level fixture in this file (no lineage, no docVersion)
    const text = serializeThread(thread);
    expect(text).not.toContain("parent:");
    expect(text).not.toMatch(/::v\d+/);
    expect(parseThread(text)).toEqual(thread);
  });

  it("round-trips frontmatter.model", () => {
    const t: ThreadFile = {
      frontmatter: { id: "c0001", anchorExact: "x", stance: "none", status: "responded", piSession: "sessions/c0001.session.jsonl", model: "litellm/gpt-5.5" },
      turns: [{ role: "you", timestamp: "t", body: "q" }],
    };
    expect(parseThread(serializeThread(t))).toEqual(t);
  });

  it("round-trips a turn with BOTH docVersion in the header and a thinking block", () => {
    const t: ThreadFile = {
      frontmatter: thread.frontmatter,
      turns: [
        {
          role: "agent",
          timestamp: "2026-06-12T10:00:30.000Z",
          meta: "critiquer · m",
          thinking: "Reason about the single-node case.",
          body: "In-memory works for one node.",
          docVersion: "v0003",
        },
      ],
    };
    const text = serializeThread(t);
    expect(text).toContain("## agent (critiquer · m) — 2026-06-12T10:00:30.000Z ::v0003");
    expect(text).toContain("<!--think");
    expect(parseThread(text)).toEqual(t);
  });
});

describe("thread file I/O", () => {
  it("writeThread overwrites the whole thread file (mkdir + replace)", async () => {
    await writeThread(docPath, {
      frontmatter: {
        id: "c0001",
        anchorExact: "x",
        stance: "none",
        status: "open",
        piSession: "sessions/c0001.session.jsonl",
      },
      turns: [{ role: "you", timestamp: "t1", body: "first" }],
    });
    expect((await readThread(docPath, "c0001")).turns[0].body).toBe("first");
    // overwrite, not append
    await writeThread(docPath, {
      frontmatter: {
        id: "c0001",
        anchorExact: "x",
        stance: "none",
        status: "open",
        piSession: "sessions/c0001.session.jsonl",
      },
      turns: [{ role: "you", timestamp: "t2", body: "second" }],
    });
    const back = await readThread(docPath, "c0001");
    expect(back.turns).toHaveLength(1);
    expect(back.turns[0].body).toBe("second");
  });

  it("inits, appends, and reads back turns", async () => {
    await initThread(docPath, thread.frontmatter);
    await appendTurn(docPath, "c0001", thread.turns[0]);
    await appendTurn(docPath, "c0001", thread.turns[1]);
    const back = await readThread(docPath, "c0001");
    expect(back.turns).toHaveLength(2);
    expect(back.turns[1].meta).toBe("critiquer · claude-fable-5");
    expect(back.frontmatter.stance).toBe("critiquer");
  });

  it("updates frontmatter in place without disturbing turns", async () => {
    await initThread(docPath, thread.frontmatter);
    await appendTurn(docPath, "c0001", thread.turns[0]);
    await updateThreadFrontmatter(docPath, "c0001", { stance: "supporter", status: "responded" });
    const back = await readThread(docPath, "c0001");
    expect(back.frontmatter.stance).toBe("supporter");
    expect(back.frontmatter.status).toBe("responded");
    expect(back.frontmatter.anchorExact).toBe("stored in Redis"); // untouched
    expect(back.turns).toHaveLength(1);
  });
});
