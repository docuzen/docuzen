import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile, access } from "node:fs/promises";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { hadPaths } from "../../src/had/paths.js";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { RpcHandler } from "../../src/rpc/handler.js";
import { FakePiRunner } from "../../src/agent/fake-runner.js";
import { createCodexHarness } from "../../src/agent/codex-runner.js";
import { HarnessRegistry } from "../../src/agent/harness-registry.js";
import { TaskDB } from "../../src/state/task-db.js";
import AdmZip from "adm-zip";
import { readAppConfig } from "../../src/config/app-config.js";
import {
  addAnnotation,
  createAnchor,
  listVersions,
  initThread,
  appendTurn,
} from "../../src/index.js";

let dir: string;
let docPath: string;
let handler: RpcHandler;
const DOC = "We store limits in Redis with a TTL.\n";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "rpc-"));
  docPath = join(dir, "plan.md");
  await writeFile(docPath, DOC, "utf8");
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
  handler = new RpcHandler({
    runner: new FakePiRunner([
      { reply: "Redis is for multi-node sharing." },
      { reply: "Fine, in-memory." },
    ]),
    now: () => "2026-06-12T10:00:05.000Z",
  });
});
afterEach(async () => {
  handler.closeAll();
  await rm(dir, { recursive: true, force: true });
});

describe("RpcHandler", () => {
  it("echoes the request id and reports ok on success", async () => {
    const res = await handler.handle({
      id: "r1",
      method: "discuss",
      params: { docPath, threadId: "c0001", annotationId: "c0001", stance: "critiquer", comment: "Why Redis?" },
    });
    expect(res.id).toBe("r1");
    expect(res.ok).toBe(true);
  });

  it("drives discuss → getThread end to end", async () => {
    await handler.handle({
      id: "r1",
      method: "discuss",
      params: { docPath, threadId: "c0001", annotationId: "c0001", stance: "critiquer", comment: "Why Redis?" },
    });
    const res = await handler.handle({
      id: "r2",
      method: "getThread",
      params: { docPath, threadId: "c0001" },
    });
    expect(res.ok).toBe(true);
    const result = res.ok ? (res.result as { turns: { role: string }[] }) : { turns: [] };
    expect(result.turns.map((t) => t.role)).toEqual(["you", "agent"]);
  });

  it("listTasks reflects task liveness for the doc", async () => {
    await handler.handle({
      id: "r1",
      method: "discuss",
      params: { docPath, threadId: "c0001", annotationId: "c0001", stance: "none", comment: "Why Redis?" },
    });
    const res = await handler.handle({ id: "r2", method: "listTasks", params: { docPath } });
    const tasks = res.ok ? (res.result as { status: string }[]) : [];
    expect(tasks[0].status).toBe("responded");
  });

  it("discuss streams a proposal event when the agent proposes, then approve/list work", async () => {
    const h = new RpcHandler({
      runner: new FakePiRunner([
        { reply: "tighter", proposal: { rationale: "single node", hunks: [{ oldText: "Redis", newText: "an in-memory store" }] } },
      ]),
      now: () => "t",
    });
    const events: { event: string; data: unknown }[] = [];
    await h.handle(
      { id: "p1", method: "discuss", params: { docPath, threadId: "c0001", annotationId: "c0001", stance: "none", comment: "tighten" } },
      (e) => events.push(e),
    );
    expect(events.some((e) => e.event === "proposal")).toBe(true);

    const list = await h.handle({ id: "p2", method: "listProposals", params: { docPath, threadId: "c0001" } });
    const props = list.ok ? (list.result as { id: string; status: string }[]) : [];
    expect(props).toHaveLength(1);
    const id = props[0].id;

    const ap = await h.handle({ id: "p3", method: "approveProposal", params: { docPath, threadId: "c0001", proposalId: id } });
    expect(ap.ok).toBe(true);
    const list2 = await h.handle({ id: "p4", method: "listProposals", params: { docPath, threadId: "c0001" } });
    const props2 = list2.ok ? (list2.result as { status: string }[]) : [];
    expect(props2[0].status).toBe("approved");
    h.closeAll();
  });

  it("rejectProposal marks it rejected", async () => {
    const h = new RpcHandler({
      runner: new FakePiRunner([
        { reply: "r", proposal: { rationale: "x", hunks: [{ oldText: "Redis", newText: "bad" }] } },
      ]),
      now: () => "t",
    });
    await h.handle({ id: "r1", method: "discuss", params: { docPath, threadId: "c0001", annotationId: "c0001", stance: "none", comment: "x" } });
    const listed = await h.handle({ id: "r2", method: "listProposals", params: { docPath, threadId: "c0001" } });
    const id = (listed.ok ? (listed.result as { id: string }[]) : [])[0].id;
    const rj = await h.handle({ id: "r3", method: "rejectProposal", params: { docPath, threadId: "c0001", proposalId: id } });
    expect(rj.ok).toBe(true);
    const after = await h.handle({ id: "r4", method: "listProposals", params: { docPath, threadId: "c0001" } });
    expect((after.ok ? (after.result as { status: string }[]) : [])[0].status).toBe("rejected");
    h.closeAll();
  });

  it("streams discuss tokens through the emit callback, then resolves ok", async () => {
    const frames: { event: string; data: unknown }[] = [];
    const res = await handler.handle(
      {
        id: "d1",
        method: "discuss",
        params: { docPath, threadId: "t1", annotationId: "c0001", stance: "none", comment: "Why?" },
      },
      (f) => frames.push(f),
    );
    expect(res.ok).toBe(true);
    expect(frames.some((f) => f.event === "token")).toBe(true);
    expect(frames.map((f) => f.data).join("")).toContain("Redis");
  });

  it("createAnnotation records the author from deps", async () => {
    const authored = new RpcHandler({ runner: new FakePiRunner([]), now: () => "t", author: "saurabh" });
    const res = await authored.handle({
      id: "au",
      method: "createAnnotation",
      params: { docPath, kind: "comment", anchor: { exact: "Redis", prefix: "", suffix: "" } },
    });
    expect(res.ok && (res.result as { author: string }).author).toBe("saurabh");
    authored.closeAll();
  });

  it("resolveComment sets the annotation status to resolved", async () => {
    const c = await handler.handle({
      id: "rc1",
      method: "createAnnotation",
      params: { docPath, kind: "comment", anchor: { exact: "Redis", prefix: "", suffix: "" } },
    });
    const id = c.ok ? (c.result as { id: string }).id : "";
    await handler.handle({ id: "rc2", method: "resolveComment", params: { docPath, id } });
    const list = await handler.handle({ id: "rc3", method: "listAnnotations", params: { docPath } });
    const a = list.ok ? (list.result as { id: string; status: string }[]).find((x) => x.id === id) : null;
    expect(a?.status).toBe("resolved");
  });

  it("deleteAnnotation removes the annotation and its thread file", async () => {
    const c = await handler.handle({
      id: "x1",
      method: "createAnnotation",
      params: { docPath, kind: "comment", anchor: { exact: "Redis", prefix: "", suffix: "" }, color: "pink" },
    });
    const id = c.ok ? (c.result as { id: string }).id : "";
    await handler.handle({ id: "x2", method: "saveComment", params: { docPath, id, anchorExact: "Redis", body: "note" } });
    await expect(access(hadPaths(docPath).threadFile(id))).resolves.toBeUndefined(); // exists

    const res = await handler.handle({ id: "x3", method: "deleteAnnotation", params: { docPath, id } });
    expect(res.ok).toBe(true);

    const list = await handler.handle({ id: "x4", method: "listAnnotations", params: { docPath } });
    const ids = list.ok ? (list.result as { id: string }[]).map((a) => a.id) : [];
    expect(ids).not.toContain(id);
    await expect(access(hadPaths(docPath).threadFile(id))).rejects.toThrow(); // gone
  });

  it("reviewDocument materializes findings as annotations + proposals and streams finding events", async () => {
    const h = new RpcHandler({
      runner: new FakePiRunner([
        {
          reply: "Reviewed.",
          findings: [
            {
              anchorText: "Redis",
              comment: "Reconsider Redis for a single node.",
              severity: "issue",
              kind: "risk",
              edits: [{ oldText: "Redis", newText: "an in-memory store" }],
            },
            { anchorText: "TTL", comment: "Clarify the TTL window.", severity: "suggestion", kind: "clarity" },
          ],
        },
      ]),
      now: () => "t",
    });
    const events: { event: string; data: unknown }[] = [];
    const res = await h.handle(
      { id: "rv1", method: "reviewDocument", params: { docPath, stance: "critiquer", rubric: "find risks" } },
      (e) => events.push(e),
    );
    expect(res.ok).toBe(true);
    const result = res.ok ? (res.result as { batchId: string; findings: unknown[] }) : { batchId: "", findings: [] };
    expect(result.findings).toHaveLength(2);
    expect(events.filter((e) => e.event === "finding")).toHaveLength(2);

    const anns = await h.handle({ id: "rv2", method: "listAnnotations", params: { docPath } });
    const list = anns.ok ? (anns.result as { id: string; origin?: string }[]) : [];
    // seeded c0001 + two agent findings
    expect(list.filter((a) => a.origin === "agent")).toHaveLength(2);

    const props = await h.handle({ id: "rv3", method: "listProposals", params: { docPath } });
    expect((props.ok ? (props.result as unknown[]) : []).length).toBe(1);
    h.closeAll();
  });

  it("visualize returns a diagram for an annotation", async () => {
    const h = new RpcHandler({ runner: new FakePiRunner([{ reply: "```mermaid\nflowchart TD\n  A-->B\n```" }]), now: () => "t" });
    const c = await h.handle({ id:"vz0", method:"createAnnotation", params:{ docPath, kind:"comment", anchor:{ exact:"Redis", prefix:"", suffix:"" } } });
    const id = c.ok ? (c.result as { id: string }).id : "";
    const res = await h.handle({ id:"vz1", method:"visualize", params:{ docPath, threadId: id } });
    expect(res.ok).toBe(true);
    const diagram = res.ok ? (res.result as { diagram: string }).diagram : "";
    expect(diagram).toContain("```mermaid");
    h.closeAll();
  });

  it("panel runs a comment through multiple models, persisting one agent turn each", async () => {
    const h = new RpcHandler({
      runner: new FakePiRunner([{ reply: "answer from A" }, { reply: "answer from B" }]),
      now: () => "t",
    });
    const res = await h.handle({
      id: "p1",
      method: "panel",
      params: { docPath, threadId: "c0001", annotationId: "c0001", stance: "none", comment: "Why Redis?", models: ["litellm/gpt-5.5", "litellm/claude-opus-4-8"] },
    });
    expect(res.ok).toBe(true);
    const t = await h.handle({ id: "p2", method: "getThread", params: { docPath, threadId: "c0001" } });
    const turns = t.ok ? (t.result as { turns: { role: string; meta?: string }[] }).turns : [];
    expect(turns.map((x) => x.role)).toEqual(["you", "agent", "agent"]);
    expect(turns[1].meta).toContain("litellm/gpt-5.5");
    expect(turns[2].meta).toContain("litellm/claude-opus-4-8");
    h.closeAll();
  });

  it("panel tags streamed token frames with the producing model", async () => {
    const h = new RpcHandler({
      runner: new FakePiRunner([{ reply: "A1" }, { reply: "B1" }]),
      now: () => "t",
    });
    const frames: { event: string; data: unknown; model?: string }[] = [];
    const res = await h.handle(
      { id: "p1", method: "panel", params: { docPath, threadId: "c0001", annotationId: "c0001", stance: "none", comment: "q", models: ["litellm/gpt-5.5", "litellm/claude-opus-4-8"] } },
      (f) => frames.push(f as { event: string; data: unknown; model?: string }),
    );
    expect(res.ok).toBe(true);
    const tokenModels = frames.filter((f) => f.event === "token").map((f) => f.model);
    expect(tokenModels).toContain("litellm/gpt-5.5");
    expect(tokenModels).toContain("litellm/claude-opus-4-8");
    h.closeAll();
  });

  it("branchThread forks a new thread from an edited message", async () => {
    await handler.handle({
      id: "b1", method: "discuss",
      params: { docPath, threadId: "c0001", annotationId: "c0001", stance: "none", comment: "q1" },
    });
    const res = await handler.handle({
      id: "b2", method: "branchThread",
      params: { docPath, threadId: "c0001", atTurnIndex: 0, message: "revised", doc: "latest" },
    });
    expect(res.ok).toBe(true);
    const result = res.ok ? (res.result as { branchThreadId: string }) : { branchThreadId: "" };
    expect(result.branchThreadId).not.toBe("c0001");

    const t = await handler.handle({ id: "b3", method: "getThread", params: { docPath, threadId: result.branchThreadId } });
    const turns = t.ok ? (t.result as { turns: { role: string; body: string }[] }).turns : [];
    expect(turns[0].body).toBe("revised");
    expect(turns.at(-1)?.role).toBe("agent");
  });

  it("openDoc marks branched annotations with their parent thread", async () => {
    await handler.handle({
      id: "bp1", method: "discuss",
      params: { docPath, threadId: "c0001", annotationId: "c0001", stance: "none", comment: "q1" },
    });
    const branched = await handler.handle({
      id: "bp2",
      method: "branchThread",
      params: { docPath, threadId: "c0001", atTurnIndex: 0, message: "revised", doc: "latest" },
    });
    const branchThreadId = branched.ok ? (branched.result as { branchThreadId: string }).branchThreadId : "";

    const opened = await handler.handle({ id: "bp3", method: "openDoc", params: { docPath } });
    const annotations = opened.ok
      ? (opened.result as { annotations: { id: string; parent?: string }[] }).annotations
      : [];

    expect(annotations.find((a) => a.id === branchThreadId)?.parent).toBe("c0001");
    expect(annotations.find((a) => a.id === "c0001")?.parent).toBeUndefined();
  });

  it("branchThread streams the agent reply tokens through emit", async () => {
    await handler.handle({
      id: "s1", method: "discuss",
      params: { docPath, threadId: "c0001", annotationId: "c0001", stance: "none", comment: "q1" },
    });
    const events: { event: string; data: unknown }[] = [];
    const res = await handler.handle(
      { id: "s2", method: "branchThread", params: { docPath, threadId: "c0001", atTurnIndex: 0, message: "revised", doc: "latest" } },
      (e) => events.push(e),
    );
    expect(res.ok).toBe(true);
    expect(events.some((e) => e.event === "token")).toBe(true);
  });

  it("saveModels then listModels round-trips through the handler (no key leak)", async () => {
    const modelsPath = join(dir, "models.json");
    const h = new RpcHandler({ runner: new FakePiRunner([]), now: () => "t", modelsPath });
    await h.handle({ id: "m1", method: "saveModels", params: { models: [
      { key: "litellm/gpt-5.5", name: "GPT", provider: "litellm", modelId: "gpt-5.5", baseUrl: "https://h/v1", apiKey: "sk-x", reasoningEffort: "medium" },
    ] } });
    const res = await h.handle({ id: "m2", method: "listModels", params: {} });
    expect(res.ok).toBe(true);
    const models = res.ok ? (res.result as { key: string; hasKey: boolean; apiKey?: string }[]) : [];
    expect(models[0]).toMatchObject({ key: "litellm/gpt-5.5", hasKey: true });
    expect(models[0].apiKey).toBeUndefined();
    h.closeAll();
  });

  it("listHarnesses returns registered Pi and Codex harness capabilities", async () => {
    const registry = HarnessRegistry.single(new FakePiRunner([]));
    registry.register(
      createCodexHarness({
        detect: () => ({ available: false, reason: "codex not found on PATH" }),
      }),
    );
    const h = new RpcHandler({ registry, now: () => "t" });

    const res = await h.handle({ id: "h1", method: "listHarnesses", params: {} });
    expect(res.ok).toBe(true);
    const harnesses = res.ok
      ? (res.result as { id: string; available: boolean; capabilities: { proposeEdits: boolean; webSearch: string } }[])
      : [];
    expect(harnesses.find((h) => h.id === "pi")).toMatchObject({
      id: "pi",
      capabilities: { proposeEdits: true, webSearch: "docuzen-managed" },
    });
    expect(harnesses.find((h) => h.id === "codex")).toMatchObject({
      id: "codex",
      available: false,
      capabilities: { webSearch: "harness-managed" },
    });
  });

  it("discuss threads modelId through to the thread frontmatter", async () => {
    const res = await handler.handle({ id: "d1", method: "discuss", params: { docPath, threadId: "c0001", annotationId: "c0001", stance: "none", comment: "q", modelId: "anthropic/claude" } });
    expect(res.ok).toBe(true);
    const t = await handler.handle({ id: "d2", method: "getThread", params: { docPath, threadId: "c0001" } });
    const fm = t.ok ? (t.result as { frontmatter: { model?: string } }).frontmatter : {};
    expect(fm.model).toBe("anthropic/claude");
  });

  it("cancelTurn resolves ok (no throw) for a thread", async () => {
    await handler.handle({ id: "c1", method: "discuss", params: { docPath, threadId: "c0001", annotationId: "c0001", stance: "none", comment: "q" } });
    const res = await handler.handle({ id: "c2", method: "cancelTurn", params: { docPath, threadId: "c0001" } });
    expect(res.ok).toBe(true);
  });

  describe("setSettings — write-through to app config", () => {
    let cfgDir: string;

    beforeEach(() => {
      cfgDir = mkdtempSync(join(tmpdir(), "docd-cfg-"));
      process.env.DOCUZEN_CONFIG_DIR = cfgDir;
    });

    afterEach(() => {
      delete process.env.DOCUZEN_CONFIG_DIR;
      rmSync(cfgDir, { recursive: true, force: true });
    });

    it("setSettings harness='codex' updates app config default and preserves existing [pi] section", async () => {
      writeFileSync(
        join(cfgDir, "config.toml"),
        '[harness]\ndefault = "pi"\n\n[pi]\nmodel = "litellm/gpt-5"\n',
        "utf8",
      );
      const res = await handler.handle({
        id: "sw1",
        method: "setSettings",
        params: { docPath, settings: { scope: "folder", harness: "codex" } },
      });
      expect(res.ok).toBe(true);
      const cfg = readAppConfig();
      expect(cfg.harness).toEqual({ default: "codex" });
      // the pre-existing [pi] model must survive
      expect(cfg.pi).toEqual({ model: "litellm/gpt-5" });
    });

    it("setSettings harness='pi' updates app config default", async () => {
      writeFileSync(
        join(cfgDir, "config.toml"),
        '[harness]\ndefault = "codex"\n',
        "utf8",
      );
      const res = await handler.handle({
        id: "sw2",
        method: "setSettings",
        params: { docPath, settings: { scope: "folder", harness: "pi" } },
      });
      expect(res.ok).toBe(true);
      expect(readAppConfig().harness).toEqual({ default: "pi" });
    });

    it("setSettings harness='claude-code' does NOT write through to app config", async () => {
      writeFileSync(
        join(cfgDir, "config.toml"),
        '[harness]\ndefault = "pi"\n',
        "utf8",
      );
      const res = await handler.handle({
        id: "sw3",
        method: "setSettings",
        params: { docPath, settings: { scope: "folder", harness: "claude-code" } },
      });
      expect(res.ok).toBe(true);
      // app config must remain unchanged
      expect(readAppConfig().harness).toEqual({ default: "pi" });
    });
  });

  it("returns ok:false with an error message for an unknown method", async () => {
    const res = await handler.handle({ id: "r9", method: "nonsense", params: {} });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/nonsense/);
  });

  it("returns ok:false instead of throwing when a delegate errors", async () => {
    const res = await handler.handle({
      id: "r9",
      method: "discuss",
      params: { docPath, threadId: "z", annotationId: "missing", stance: "none", comment: "x" },
    });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/missing/);
  });

  // task-0: verifies the last hop of runner → runTurn → transition(error) → RPC rejection —
  // the ACTUAL failure detail a fixed PiRunner throws (not a generic "no content" placeholder)
  // must reach the client's {ok:false, error} response byte-for-byte, since chat.ts's bubble
  // renders `res.error` verbatim.
  it("propagates a runner's actual failure detail (not a generic placeholder) all the way to res.error", async () => {
    const h = new RpcHandler({
      runner: {
        async start() {
          throw new Error("401 model litellm/gpt-9 not allowed for this account");
        },
        async send() {
          throw new Error("unexpected send");
        },
        async cancel() {},
      },
      now: () => "t",
    });
    const res = await h.handle({
      id: "r10",
      method: "discuss",
      params: { docPath, threadId: "c0001", annotationId: "c0001", stance: "none", comment: "Why Redis?" },
    });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toBe("401 model litellm/gpt-9 not allowed for this account");
    h.closeAll();
  });

  it("openDoc returns the markdown body (no had frontmatter) and existing annotations", async () => {
    const res = await handler.handle({ id: "r1", method: "openDoc", params: { docPath } });
    expect(res.ok).toBe(true);
    const result = res.ok ? (res.result as { text: string; annotations: unknown[] }) : null;
    expect(result!.text).toContain("We store limits in Redis with a TTL.");
    expect(result!.text).not.toContain("had:"); // pointer frontmatter stripped
    expect(result!.annotations).toHaveLength(1);
  });

  it("openDoc reconciles a stuck running task left by a killed sidecar into error + errorText", async () => {
    // Simulate a crash: a thread stuck "running" in the TaskDB with no completed agent
    // turn (as a killed sidecar would leave it), seeded directly rather than through the
    // handler (the handler's runner always completes synchronously).
    await initThread(docPath, {
      id: "stuck1",
      anchorExact: "x",
      stance: "none",
      status: "running",
      piSession: "sessions/stuck1.session.jsonl",
    });
    await appendTurn(docPath, "stuck1", { role: "you", timestamp: "t1", body: "q" });
    const seedDb = new TaskDB(hadPaths(docPath).stateDb);
    seedDb.upsert({ threadId: "stuck1", status: "running", piSessionId: "fake-1" });
    seedDb.close();

    await handler.handle({ id: "od1", method: "openDoc", params: { docPath } });

    const res = await handler.handle({ id: "lt1", method: "listTasks", params: { docPath } });
    const tasks = res.ok
      ? (res.result as { threadId: string; status: string; errorText?: string | null }[])
      : [];
    const stuck = tasks.find((t) => t.threadId === "stuck1");
    expect(stuck?.status).toBe("error");
    expect(stuck?.errorText).toBe("interrupted — sidecar restarted");
  });

  it("openDoc still succeeds when a running row's thread file is missing entirely (sidecar killed before initThread ran) — the stuck row reads back as error instead of blocking the doc open forever", async () => {
    // No initThread call here at all: the TaskDB row exists but the thread file
    // it points at was never created, simulating a sidecar killed between review()
    // marking the row "running" and initThread creating the thread file.
    const seedDb = new TaskDB(hadPaths(docPath).stateDb);
    seedDb.upsert({ threadId: "missing1", status: "running", piSessionId: "fake-1" });
    seedDb.close();

    const res = await handler.handle({ id: "od2", method: "openDoc", params: { docPath } });
    expect(res.ok).toBe(true);
    const result = res.ok ? (res.result as { text: string }) : null;
    expect(result!.text).toContain("We store limits in Redis with a TTL.");

    const lt = await handler.handle({ id: "lt2", method: "listTasks", params: { docPath } });
    const tasks = lt.ok
      ? (lt.result as { threadId: string; status: string; errorText?: string | null }[])
      : [];
    const stuck = tasks.find((t) => t.threadId === "missing1");
    expect(stuck?.status).toBe("error");
    expect(stuck?.errorText).toBe("interrupted — sidecar restarted");
  });

  it("createAnnotation assigns a sequential id and persists with color + kind", async () => {
    const anchor = { exact: "token-bucket", prefix: "", suffix: "" };
    const res = await handler.handle({
      id: "r2",
      method: "createAnnotation",
      params: { docPath, kind: "highlight", anchor, color: "green" },
    });
    expect(res.ok).toBe(true);
    const created = res.ok ? (res.result as { id: string; type: string; color: string }) : null;
    expect(created!.id).toBe("c0002"); // c0001 seeded in beforeEach
    expect(created!.type).toBe("highlight");
    expect(created!.color).toBe("green");

    // persisted to disk
    const back = await handler.handle({ id: "r3", method: "listAnnotations", params: { docPath } });
    const list = back.ok ? (back.result as { id: string; color?: string }[]) : [];
    expect(list).toHaveLength(2);
    expect(list.find((a) => a.id === "c0002")?.color).toBe("green");
  });

  it("saveComment persists the body; openDoc returns it on the annotation", async () => {
    const created = await handler.handle({
      id: "a1",
      method: "createAnnotation",
      params: { docPath, kind: "comment", anchor: { exact: "Redis", prefix: "", suffix: "" }, color: "pink" },
    });
    const id = created.ok ? (created.result as { id: string }).id : "";
    await handler.handle({
      id: "a2",
      method: "saveComment",
      params: { docPath, id, anchorExact: "Redis", body: "Why not in-memory?" },
    });

    const opened = await handler.handle({ id: "a3", method: "openDoc", params: { docPath } });
    const anns = opened.ok ? (opened.result as { annotations: { id: string; body?: string }[] }).annotations : [];
    expect(anns.find((a) => a.id === id)?.body).toBe("Why not in-memory?");
  });

  it("saveDoc writes the body back without adding frontmatter and snapshots a version", async () => {
    const res = await handler.handle({
      id: "s1",
      method: "saveDoc",
      params: { docPath, text: "# Edited Plan\n\nNew body.\n" },
    });
    expect(res.ok).toBe(true);
    const onDisk = await readFile(docPath, "utf8");
    expect(onDisk).toBe("# Edited Plan\n\nNew body.\n"); // no had: frontmatter injected
    const versions = await listVersions(docPath);
    expect(versions.some((v) => v.cause === "manual-save")).toBe(true);
  });

  it("importHadz unzips a bundle and openDoc on the result restores annotations", async () => {
    await handler.handle({
      id: "i1",
      method: "createAnnotation",
      params: { docPath, kind: "highlight", anchor: { exact: "Redis", prefix: "", suffix: "" }, color: "blue" },
    });
    const exp = await handler.handle({ id: "i2", method: "exportHadz", params: { docPath } });
    const hadzPath = exp.ok ? (exp.result as { path: string }).path : "";
    const dest = join(dir, "imported");

    const imp = await handler.handle({
      id: "i3",
      method: "importHadz",
      params: { hadzPath, destDir: dest },
    });
    expect(imp.ok).toBe(true);
    const importedDoc = imp.ok ? (imp.result as { docPath: string }).docPath : "";
    expect(importedDoc).toMatch(/plan\.md$/);

    const opened = await handler.handle({ id: "i4", method: "openDoc", params: { docPath: importedDoc } });
    const anns = opened.ok ? (opened.result as { annotations: { color?: string }[] }).annotations : [];
    // the seeded c0001 + the blue highlight both travel in the bundle
    expect(anns).toHaveLength(2);
    expect(anns.some((a) => a.color === "blue")).toBe(true);
  });

  it("openDoc on an .html file returns it raw with format html, leaving the file untouched", async () => {
    const htmlPath = join(dir, "report.html");
    const html = "<h1>Report</h1>\n<p>Latency is high.</p>\n";
    await writeFile(htmlPath, html, "utf8");
    const res = await handler.handle({ id: "h1", method: "openDoc", params: { docPath: htmlPath } });
    expect(res.ok).toBe(true);
    const r = res.ok ? (res.result as { text: string; format: string }) : null;
    expect(r!.format).toBe("html");
    expect(r!.text).toContain("<h1>Report</h1>");
    // the html file must NOT be corrupted with yaml frontmatter
    expect(await readFile(htmlPath, "utf8")).toBe(html);
  });

  it("listThreads returns the branch tree", async () => {
    await handler.handle({ id: "lt1", method: "discuss", params: { docPath, threadId: "c0001", annotationId: "c0001", stance: "none", comment: "q1" } });
    const res = await handler.handle({ id: "lt2", method: "listThreads", params: { docPath } });
    expect(res.ok).toBe(true);
    const nodes = res.ok ? (res.result as { id: string; title: string }[]) : [];
    expect(nodes.some((n) => n.id === "c0001")).toBe(true);
  });

  it("listVersions returns version entries after a discuss snapshots the doc", async () => {
    await handler.handle({ id: "lv1", method: "discuss", params: { docPath, threadId: "c0001", annotationId: "c0001", stance: "none", comment: "q" } });
    const res = await handler.handle({ id: "lv2", method: "listVersions", params: { docPath } });
    expect(res.ok).toBe(true);
    const versions = res.ok ? (res.result as { id: string; cause: string }[]) : [];
    expect(versions.length).toBeGreaterThan(0);
    expect(versions[0].id).toMatch(/^v\d+$/);
  });

  it("readVersion returns the doc content at a version id", async () => {
    // discuss cuts a turn-base snapshot (v0001) of the current doc
    await handler.handle({ id: "rv1", method: "discuss", params: { docPath, threadId: "c0001", annotationId: "c0001", stance: "none", comment: "q" } });
    const res = await handler.handle({ id: "rv2", method: "readVersion", params: { docPath, versionId: "v0001" } });
    expect(res.ok).toBe(true);
    const out = res.ok ? (res.result as { content: string }) : { content: "" };
    expect(out.content).toContain("Redis");
  });

  it("exportHadz writes a .hadz zip containing the doc and .had entries", async () => {
    await handler.handle({
      id: "e1",
      method: "createAnnotation",
      params: { docPath, kind: "highlight", anchor: { exact: "Redis", prefix: "", suffix: "" }, color: "blue" },
    });
    const res = await handler.handle({ id: "e2", method: "exportHadz", params: { docPath } });
    expect(res.ok).toBe(true);
    const outPath = res.ok ? (res.result as { path: string }).path : "";
    expect(outPath).toMatch(/\.hadz$/);
    const entries = new AdmZip(outPath).getEntries().map((e) => e.entryName);
    expect(entries.some((n) => n.endsWith("plan.md"))).toBe(true);
    expect(entries.some((n) => n.includes(".had/") && n.endsWith("annotations.json"))).toBe(true);
  });

  it("restoreVersion writes a past version's content back as the current doc", async () => {
    // discuss snapshots the original doc as v0001
    await handler.handle({ id: "re1", method: "discuss", params: { docPath, threadId: "c0001", annotationId: "c0001", stance: "none", comment: "q" } });
    const original = await readFile(docPath, "utf8");
    // mutate the live doc via saveDoc (cuts another version)
    await handler.handle({ id: "re2", method: "saveDoc", params: { docPath, text: "completely different body" } });
    expect(await readFile(docPath, "utf8")).not.toBe(original);
    // restore v0001
    const res = await handler.handle({ id: "re3", method: "restoreVersion", params: { docPath, versionId: "v0001" } });
    expect(res.ok).toBe(true);
    expect(await readFile(docPath, "utf8")).toBe(original); // doc is the v0001 content again
    // the pre-restore state is preserved as a version (nothing lost)
    const vres = await handler.handle({ id: "re4", method: "listVersions", params: { docPath } });
    const versions = vres.ok ? (vres.result as { cause: string }[]) : [];
    expect(versions.length).toBeGreaterThanOrEqual(2);
  });

  it("restoreVersion restores the annotations captured at that version", async () => {
    // seed an annotation, snapshot a version that has it, then delete it + snapshot empty
    await handler.handle({ id: "r0", method: "createAnnotation", params: { docPath, kind: "comment", anchor: { exact: "Redis", prefix: "", suffix: "" } } });
    await handler.handle({ id: "r1", method: "saveDoc", params: { docPath, text: "with comment" } });   // version captures the comment
    const vRes = await handler.handle({ id: "r2", method: "listVersions", params: { docPath } });
    const vWith = (vRes.ok ? (vRes.result as { id: string }[]) : []).at(-1)!.id;
    // delete all annotations
    const lRes = await handler.handle({ id: "r3", method: "listAnnotations", params: { docPath } });
    const items = lRes.ok ? (lRes.result as { id: string }[]) : [];
    for (const a of items) await handler.handle({ id: "rd" + a.id, method: "deleteAnnotation", params: { docPath, id: a.id } });
    await handler.handle({ id: "r4", method: "saveDoc", params: { docPath, text: "no comment" } });
    // restore the version that had the comment
    await handler.handle({ id: "r5", method: "restoreVersion", params: { docPath, versionId: vWith } });
    const aRes = await handler.handle({ id: "r6", method: "listAnnotations", params: { docPath } });
    const after = aRes.ok ? (aRes.result as { id: string }[]) : [];
    expect(after.length).toBeGreaterThan(0);   // the comment is back
  });

  it("exportHadz with versionId bundles that version's doc content; without it uses the live doc", async () => {
    await handler.handle({ id: "ex0", method: "discuss", params: { docPath, threadId: "c0001", annotationId: "c0001", stance: "none", comment: "q" } });
    const v1content = (await handler.handle({ id: "ex1", method: "readVersion", params: { docPath, versionId: "v0001" } }));
    const versionDoc = v1content.ok ? (v1content.result as { content: string }).content : "";
    await handler.handle({ id: "ex2", method: "saveDoc", params: { docPath, text: "live doc body now" } });

    const outV = join(dir, "at-version.hadz");
    await handler.handle({ id: "ex3", method: "exportHadz", params: { docPath, outPath: outV, versionId: "v0001" } });
    const zipV = new AdmZip(outV);
    const docEntryV = zipV.getEntries().find((e) => e.entryName === basename(docPath))!;
    expect(docEntryV.getData().toString("utf8")).toBe(versionDoc);
    // the version bundle must STILL include the .had sidecar
    expect(zipV.getEntries().some((e) => e.entryName.includes(".had/"))).toBe(true);

    const outCur = join(dir, "current.hadz");
    await handler.handle({ id: "ex4", method: "exportHadz", params: { docPath, outPath: outCur } });
    const zipCur = new AdmZip(outCur);
    const docEntryCur = zipCur.getEntries().find((e) => e.entryName === basename(docPath))!;
    expect(docEntryCur.getData().toString("utf8")).toContain("live doc body now");
  });
});
