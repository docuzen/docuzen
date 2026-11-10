// End-to-end: a REAL PiRunner turn through the REAL pi SDK, against a local mock of an
// OpenAI-compatible chat-completions endpoint. Everything else in this directory tests
// pi-runner's pure helpers with hand-built event objects; this is the one test that fails
// if the SDK's actual wire/event behaviour stops matching what pi-runner.ts assumes — the
// thing to run before (and after) bumping @earendil-works/pi-coding-agent.
//
// Hermetic: PI_CODING_AGENT_DIR points the SDK at a temp models.json; no network, no key.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { AgentContext, AgentEvent } from "../../src/agent/types.js";

type ChatRequest = { messages: { role: string }[]; tools?: { function?: { name?: string } }[] };
let server: Server;
let agentDir: string;
let workDir: string;
const requests: ChatRequest[] = [];
/** One scripted response per incoming chat-completions request, in order. */
let script: object[][] = [];
/** When set, the next request is held open (headers sent, no chunks) until the client aborts. */
let hang = false;
let modelsJsonPath: string;
let baseUrl: string;

function writeModels(modelIds: string[]): void {
  writeFileSync(
    modelsJsonPath,
    JSON.stringify({
      providers: {
        mock: {
          api: "openai-completions",
          baseUrl,
          apiKey: "test-key",
          models: modelIds.map((id) => ({ id, name: id })),
        },
      },
    }),
  );
}

function chunk(delta: object, finish: string | null = null): object {
  return { id: "c1", object: "chat.completion.chunk", created: 1, model: "mock-model", choices: [{ index: 0, delta, finish_reason: finish }] };
}

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      if (!req.url?.endsWith("/chat/completions")) {
        res.writeHead(404).end();
        return;
      }
      requests.push(JSON.parse(body) as ChatRequest);
      if (hang) {
        hang = false;
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(": keep-alive\n\n"); // stream opened, never completed
        return;
      }
      const chunks = script.shift();
      if (!chunks) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "mock: no scripted response left", type: "invalid_request_error" } }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;

  agentDir = mkdtempSync(join(tmpdir(), "pi-e2e-agent-"));
  workDir = mkdtempSync(join(tmpdir(), "pi-e2e-work-"));
  writeFileSync(join(workDir, "doc.md"), "# Title\n\nWe store limits in Redis with a TTL.\n");
  modelsJsonPath = join(agentDir, "models.json");
  baseUrl = `http://127.0.0.1:${port}/v1`;
  writeModels(["mock-model"]);
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_OFFLINE = "1";
  process.env.PI_SKIP_VERSION_CHECK = "1";
});

afterAll(async () => {
  delete process.env.PI_CODING_AGENT_DIR;
  delete process.env.PI_OFFLINE;
  delete process.env.PI_SKIP_VERSION_CHECK;
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(agentDir, { recursive: true, force: true });
  rmSync(workDir, { recursive: true, force: true });
});

function ctx(extra: Partial<AgentContext> = {}): AgentContext {
  return {
    docText: "# Title\n\nWe store limits in Redis with a TTL.",
    anchorExact: "Redis",
    surrounding: "limits in Redis with a TTL",
    comment: "Why Redis?",
    stancePrompt: "You are a neutral collaborator.",
    docPath: join(workDir, "doc.md"),
    scopeDir: workDir,
    ...extra,
  };
}

async function newRunner() {
  // Imported lazily: the SDK resolves its agent dir from the env set in beforeAll.
  const { PiRunner } = await import("../../src/agent/pi-runner.js");
  return PiRunner.create({ provider: "mock", modelId: "mock-model" });
}

describe("PiRunner end-to-end against a mock chat-completions server", () => {
  it("streams a conversation reply and returns it as the turn", async () => {
    requests.length = 0;
    script = [[chunk({ role: "assistant", content: "Redis gives " }), chunk({ content: "atomic counters." }), chunk({}, "stop")]];
    const events: AgentEvent[] = [];
    const runner = await newRunner();

    const { sessionId, turn } = await runner.start(ctx({ conversationOnly: true }), (e) => events.push(e));

    expect(turn.reply).toBe("Redis gives atomic counters.");
    expect(events.filter((e) => e.type === "token").map((e) => e.text).join("")).toBe("Redis gives atomic counters.");
    expect(runner.hasSession(sessionId)).toBe(true);
    // Conversation turns must not be offered an edit tool.
    const toolNames = (requests[0].tools ?? []).map((t) => t.function?.name);
    expect(toolNames).not.toContain("propose_edit");
    expect(toolNames).toContain("read");
  }, 30_000);

  it("captures a propose_edit tool call as the turn's proposal and continues the same session", async () => {
    requests.length = 0;
    script = [
      [
        chunk({
          role: "assistant",
          content: null,
          tool_calls: [
            {
              index: 0,
              id: "call_1",
              type: "function",
              function: {
                name: "propose_edit",
                arguments: JSON.stringify({
                  rationale: "tighter",
                  edits: [{ oldText: "We store limits in Redis with a TTL.", newText: "Limits live in Redis with a TTL." }],
                }),
              },
            },
          ],
        }),
        chunk({}, "tool_calls"),
      ],
      [chunk({ role: "assistant", content: "Proposed a tighter sentence." }), chunk({}, "stop")],
      [chunk({ role: "assistant", content: "Follow-up answer." }), chunk({}, "stop")],
    ];
    const runner = await newRunner();
    const events: AgentEvent[] = [];

    const { sessionId, turn } = await runner.start(ctx(), (e) => events.push(e));

    // Tool activity reaches the UI as a "tool" event naming the tool.
    expect(events.filter((e) => e.type === "tool").map((e) => e.text)).toEqual(["propose_edit"]);
    expect(requests[0].tools?.map((t) => t.function?.name)).toContain("propose_edit");
    expect(turn.proposal).toEqual({
      rationale: "tighter",
      hunks: [{ oldText: "We store limits in Redis with a TTL.", newText: "Limits live in Redis with a TTL." }],
    });
    expect(turn.reply).toBe("Proposed a tighter sentence.");
    // The tool result went back to the model as a second request in the same session.
    expect(requests).toHaveLength(2);
    expect(requests[1].messages.some((m) => m.role === "tool")).toBe(true);

    const follow = await runner.send(sessionId, "And then?");
    expect(follow.reply).toBe("Follow-up answer.");
    expect(follow.proposal).toBeUndefined(); // per-turn state is reset between prompts
  }, 30_000);

  it("rejects at construction when the default model is not in pi's registry", async () => {
    const { PiRunner } = await import("../../src/agent/pi-runner.js");
    await expect(PiRunner.create({ provider: "mock", modelId: "nope" })).rejects.toThrow(
      "pi model mock/nope not found",
    );
  });

  it("resolves a per-turn model that was added to models.json after the runner started", async () => {
    const runner = await newRunner();
    writeModels(["mock-model", "late-model"]); // e.g. added in Settings while the app is open
    requests.length = 0;
    script = [[chunk({ role: "assistant", content: "from the late model" }), chunk({}, "stop")]];

    const { turn } = await runner.start(ctx({ conversationOnly: true, modelId: "mock/late-model" }));

    expect(turn.reply).toBe("from the late model");
    expect((requests[0] as unknown as { model: string }).model).toBe("late-model");
    writeModels(["mock-model"]);
  }, 30_000);

  it("Stop mid-stream settles the turn normally instead of throwing", async () => {
    requests.length = 0;
    hang = true;
    const runner = await newRunner();
    const pending = runner.start(ctx({ conversationOnly: true, cancelKey: "doc#c0001" }));
    // Wait until the request is actually in flight, then press Stop.
    for (let i = 0; i < 200 && requests.length === 0; i++) await new Promise((r) => setTimeout(r, 25));
    expect(requests).toHaveLength(1);
    await runner.cancel("doc#c0001");

    const { turn } = await pending; // must resolve: chat.ts's Stop handler relies on it
    expect(turn.reply).toBe("");
  }, 30_000);

  it("surfaces a gateway failure as a thrown error, not a silent empty reply", async () => {
    requests.length = 0;
    script = []; // the mock answers 400 with an error body
    const runner = await newRunner();
    await expect(runner.start(ctx({ conversationOnly: true }))).rejects.toThrow(/no scripted response left|400/);
  }, 60_000);
});
