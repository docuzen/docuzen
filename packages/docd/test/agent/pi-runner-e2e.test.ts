// End-to-end: a REAL PiRunner turn through the REAL pi SDK, against a local mock of an
// OpenAI-compatible chat-completions endpoint. Everything else in this directory tests
// pi-runner's pure helpers with hand-built event objects; this is the one test that fails
// if the SDK's actual wire/event behaviour stops matching what pi-runner.ts assumes — the
// thing to run before (and after) bumping @earendil-works/pi-coding-agent.
//
// Hermetic: PI_CODING_AGENT_DIR points the SDK at a temp models.json; no network, no key.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { AddressInfo } from "node:net";
import type { AgentContext, AgentEvent, AgentTurn } from "../../src/agent/types.js";

type ChatMessage = { role: string; content?: unknown; tool_call_id?: string };
type ChatRequest = { messages: ChatMessage[]; tools?: { function?: { name?: string } }[] };
let server: Server;
let agentDir: string;
let workDir: string;
const requests: ChatRequest[] = [];
/** The URL path and Authorization header of each request, parallel to `requests`. */
const requestMeta: { url: string; auth: string | undefined }[] = [];
/** One scripted response per incoming chat-completions request, in order. */
let script: object[][] = [];
/** When set, the next request is held open (headers sent, no chunks) until the client aborts. */
let hang = false;
let modelsJsonPath: string;
let baseUrl: string;

function writeModels(
  modelIds: string[],
  provider: { baseUrl?: string; apiKey?: string } = {},
): void {
  writeFileSync(
    modelsJsonPath,
    JSON.stringify({
      providers: {
        mock: {
          api: "openai-completions",
          baseUrl: provider.baseUrl ?? baseUrl,
          apiKey: provider.apiKey ?? "test-key",
          models: modelIds.map((id) => ({ id, name: id })),
        },
      },
    }),
  );
}

function chunk(delta: object, finish: string | null = null): object {
  return { id: "c1", object: "chat.completion.chunk", created: 1, model: "mock-model", choices: [{ index: 0, delta, finish_reason: finish }] };
}

/** A complete scripted text reply. */
function reply(text: string): object[] {
  return [chunk({ role: "assistant", content: text }), chunk({}, "stop")];
}

/** One assistant message calling several tools at once (ids call_0, call_1, ...). */
function toolCalls(calls: { name: string; args: object }[]): object[] {
  return [
    chunk({
      role: "assistant",
      content: null,
      tool_calls: calls.map((c, i) => ({
        index: i,
        id: `call_${i}`,
        type: "function",
        function: { name: c.name, arguments: JSON.stringify(c.args) },
      })),
    }),
    chunk({}, "tool_calls"),
  ];
}

/** Text of a chat message, whether its content is a string or an array of parts. */
function messageText(m: ChatMessage | undefined): string {
  if (!m) return "";
  if (typeof m.content === "string") return m.content;
  return JSON.stringify(m.content ?? "");
}

/** Resolve with the promise's value, or reject if it hasn't settled within `ms`. */
function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${what} did not settle within ${ms}ms`)), ms)),
  ]);
}

async function untilRequests(n: number): Promise<void> {
  for (let i = 0; i < 200 && requests.length < n; i++) await new Promise((r) => setTimeout(r, 25));
  expect(requests).toHaveLength(n);
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
      requestMeta.push({ url: req.url, auth: req.headers.authorization });
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

function resetRequests(): void {
  requests.length = 0;
  requestMeta.length = 0;
}

describe("PiRunner loads no code, settings or prompts from the document's folder or pi's config", () => {
  it("runs no project or global extension, ignores project settings, context files and SYSTEM.md, and sends a '/' reply verbatim", async () => {
    // An untrusted folder (a cloned repo, a downloaded archive) with pi project config in it.
    const root = mkdtempSync(join(tmpdir(), "pi-e2e-untrusted-"));
    const markers = mkdtempSync(join(tmpdir(), "pi-e2e-markers-"));
    const project = join(root, "project");
    const extensionSource = (marker: string) =>
      `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(join(markers, marker))}, "ran");\nexport default function () {}\n`;
    mkdirSync(join(project, ".pi", "extensions"), { recursive: true });
    mkdirSync(join(project, ".pi", "prompts"), { recursive: true });
    writeFileSync(join(project, ".pi", "extensions", "evil.ts"), extensionSource("project-extension"));
    // Project settings naming an extension elsewhere on disk.
    writeFileSync(join(root, "elsewhere.ts"), extensionSource("settings-extension"));
    writeFileSync(join(project, ".pi", "settings.json"), JSON.stringify({ extensions: [join(root, "elsewhere.ts")] }));
    writeFileSync(join(project, ".pi", "prompts", "summarize.md"), "PROJECT-TEMPLATE-CANARY $@\n");
    writeFileSync(join(project, ".pi", "SYSTEM.md"), "PROJECT-SYSTEM-CANARY\n");
    writeFileSync(join(project, ".pi", "APPEND_SYSTEM.md"), "PROJECT-APPEND-CANARY\n");
    writeFileSync(join(root, "AGENTS.md"), "ANCESTOR-AGENTS-CANARY\n"); // an ancestor of the doc folder
    writeFileSync(join(project, "CLAUDE.md"), "PROJECT-CLAUDE-CANARY\n");
    writeFileSync(join(project, "doc.md"), "# Title\n\nWe store limits in Redis with a TTL.\n");
    // pi's global config dir: decision — none of it loads for docuzen's sessions either.
    const globalFiles = [
      join(agentDir, "extensions", "global.ts"),
      join(agentDir, "prompts", "summarize.md"),
      join(agentDir, "AGENTS.md"),
      join(agentDir, "settings.json"),
    ];
    mkdirSync(join(agentDir, "extensions"), { recursive: true });
    mkdirSync(join(agentDir, "prompts"), { recursive: true });
    writeFileSync(globalFiles[0], extensionSource("global-extension"));
    writeFileSync(globalFiles[1], "GLOBAL-TEMPLATE-CANARY $@\n");
    writeFileSync(globalFiles[2], "GLOBAL-AGENTS-CANARY\n");
    writeFileSync(globalFiles[3], JSON.stringify({ extensions: [join(root, "elsewhere.ts")] }));
    try {
      resetRequests();
      script = [reply("Discussed."), reply("Answered.")];
      const runner = await newRunner();
      const docPath = join(project, "doc.md");
      const { sessionId } = await runner.start(ctx({ conversationOnly: true, docPath, scopeDir: project }));
      const follow = await runner.send(sessionId, "/summarize the risks");

      expect(follow.reply).toBe("Answered.");
      expect(existsSync(join(markers, "project-extension"))).toBe(false);
      expect(existsSync(join(markers, "settings-extension"))).toBe(false);
      expect(existsSync(join(markers, "global-extension"))).toBe(false);
      const system = messageText(requests[0].messages.find((m) => m.role === "system"));
      expect(system).not.toBe("");
      for (const canary of [
        "PROJECT-SYSTEM-CANARY",
        "PROJECT-APPEND-CANARY",
        "ANCESTOR-AGENTS-CANARY",
        "PROJECT-CLAUDE-CANARY",
        "GLOBAL-AGENTS-CANARY",
      ]) {
        expect(system).not.toContain(canary);
      }
      // The reply that starts with "/" reached the model as the reviewer typed it.
      const lastUser = messageText(requests[1].messages.filter((m) => m.role === "user").at(-1));
      expect(lastUser).toContain("/summarize the risks");
      expect(lastUser).not.toContain("TEMPLATE-CANARY");
    } finally {
      for (const f of globalFiles) rmSync(f, { force: true });
      rmSync(root, { recursive: true, force: true });
      rmSync(markers, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("PiRunner's file tools stay inside the session's scope folder", () => {
  it("refuses ../, absolute, ~ and symlinked paths that leave the scope, and still reads inside it", async () => {
    const outside = mkdtempSync(join(tmpdir(), "pi-e2e-outside-"));
    const scope = mkdtempSync(join(tmpdir(), "pi-e2e-scope-"));
    const home = mkdtempSync(join(tmpdir(), "pi-e2e-home-"));
    writeFileSync(join(outside, "secret.txt"), "TOP-SECRET-OUTSIDE\n");
    writeFileSync(join(home, "secret.txt"), "TOP-SECRET-HOME\n");
    writeFileSync(join(scope, "doc.md"), "# Title\n\nWe store limits in Redis with a TTL.\n");
    mkdirSync(join(scope, "notes"));
    writeFileSync(join(scope, "notes", "inside.md"), "INSIDE-NOTE\n");
    symlinkSync(outside, join(scope, "escape")); // a directory link that leaves the scope
    symlinkSync(join(outside, "secret.txt"), join(scope, "leak.txt")); // a file link that leaves it
    symlinkSync(join(scope, "notes", "inside.md"), join(scope, "alias.md")); // a link that stays inside
    const savedHome = process.env.HOME;
    process.env.HOME = home;
    const calls = [
      { name: "read", args: { path: `../${basename(outside)}/secret.txt` } },
      { name: "read", args: { path: join(outside, "secret.txt") } },
      { name: "read", args: { path: "~/secret.txt" } },
      { name: "read", args: { path: "leak.txt" } },
      { name: "read", args: { path: "escape/secret.txt" } },
      { name: "read", args: { path: `file://${join(outside, "secret.txt")}` } }, // pi accepts file URLs
      { name: "ls", args: { path: "@.." } }, // pi strips a leading "@"
      { name: "ls", args: { path: "escape" } },
      { name: "ls", args: { path: ".." } },
      { name: "ls", args: { path: "~" } },
      { name: "grep", args: { pattern: "TOP-SECRET", path: outside } },
      { name: "grep", args: { pattern: "TOP-SECRET", path: "escape" } },
      { name: "grep", args: { pattern: "TOP-SECRET", path: "leak.txt" } },
      { name: "find", args: { pattern: "*.txt", path: "~" } },
      { name: "find", args: { pattern: "*", path: "escape" } },
      { name: "find", args: { pattern: "*", path: `../${basename(outside)}` } },
      // Inside the scope: still allowed.
      { name: "read", args: { path: "notes/inside.md" } },
      { name: "read", args: { path: "notes/../alias.md" } },
      { name: "ls", args: { path: "notes" } },
    ];
    try {
      resetRequests();
      script = [toolCalls(calls), reply("Done.")];
      const runner = await newRunner();
      await runner.start(ctx({ conversationOnly: true, docPath: join(scope, "doc.md"), scopeDir: scope }));

      expect(requests).toHaveLength(2);
      const results = new Map(
        requests[1].messages.filter((m) => m.role === "tool").map((m) => [m.tool_call_id, messageText(m)]),
      );
      expect(results.size).toBe(calls.length);
      const outsideCount = calls.length - 3;
      for (let i = 0; i < calls.length; i++) {
        const text = results.get(`call_${i}`) ?? "";
        expect(text, JSON.stringify(calls[i])).not.toContain("TOP-SECRET");
        if (i < outsideCount) expect(text, JSON.stringify(calls[i])).toMatch(/outside the folder/);
      }
      expect(results.get(`call_${outsideCount}`)).toContain("INSIDE-NOTE");
      expect(results.get(`call_${outsideCount + 1}`)).toContain("INSIDE-NOTE");
      expect(results.get(`call_${outsideCount + 2}`)).toContain("inside.md");
    } finally {
      process.env.HOME = savedHome;
      for (const d of [outside, scope, home]) rmSync(d, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("PiRunner Stop targets the run in flight for a thread", () => {
  it("Stop still aborts a reply after an Improve ran on the same thread", async () => {
    const key = "doc#c0042";
    const runner = await newRunner();
    resetRequests();
    script = [reply("Discussed."), reply("Rewritten passage.")];
    const { sessionId } = await runner.start(ctx({ conversationOnly: true, cancelKey: key }));
    // Improve: a one-shot session on the same thread (same cancel key).
    await runner.start(ctx({ improveMode: true, replacementOnly: true, conversationOnly: false, cancelKey: key }));

    resetRequests();
    hang = true;
    const pending = runner.send(sessionId, "And what about failover?");
    await untilRequests(1);
    await runner.cancel(key);

    const turn = await within(pending, 5_000, "the stopped reply");
    expect(turn.reply).toBe("");
  }, 30_000);

  it("Stop pressed while the session is still being created stops the turn before the model is asked", async () => {
    const key = "doc#c0043";
    const runner = await newRunner();
    resetRequests();
    script = [reply("This reply should never be requested.")];
    const pending = runner.start(ctx({ conversationOnly: true, cancelKey: key }));
    await runner.cancel(key); // start() is still awaiting createAgentSession

    const { sessionId, turn } = await within(pending, 5_000, "the stopped start");
    expect(turn.reply).toBe("");
    expect(requests).toHaveLength(0);
    // The session never received the document, so a later reply must not continue it.
    expect(runner.hasSession(sessionId)).toBe(false);
    script = [];
  }, 30_000);

  it("a Stop with nothing running does not swallow the thread's next turn", async () => {
    const key = "doc#c0044";
    const runner = await newRunner();
    resetRequests();
    script = [reply("First."), reply("Second.")];
    const { sessionId } = await runner.start(ctx({ conversationOnly: true, cancelKey: key }));
    await runner.cancel(key); // idle: nothing to stop

    const next: AgentTurn = await runner.send(sessionId, "Go on.");
    expect(next.reply).toBe("Second.");
  }, 30_000);
});

describe("PiRunner session lifecycle", () => {
  it("drops an Improve session once its turn is done (it is never continued)", async () => {
    resetRequests();
    script = [reply("Rewritten passage.")];
    const runner = await newRunner();
    const { sessionId, turn } = await runner.start(
      ctx({ improveMode: true, replacementOnly: true, conversationOnly: false }),
    );
    expect(turn.reply).toBe("Rewritten passage.");
    expect(runner.hasSession(sessionId)).toBe(false);
  }, 30_000);

  it("drops a session whose first turn failed (the caller never learns its id)", async () => {
    resetRequests();
    script = []; // the mock answers 400
    const runner = await newRunner();
    await expect(runner.start(ctx({ conversationOnly: true }))).rejects.toThrow();
    // Ids are per-runner and sequential, so the failed start was this runner's pi-1.
    expect(runner.hasSession("pi-1")).toBe(false);
  }, 60_000);
});

describe("PiRunner follows models.json edits made while it runs", () => {
  it("uses a rotated key and a moved gateway for the default model without a restart", async () => {
    const runner = await newRunner();
    const origin = baseUrl.replace(/\/v1$/, "");
    writeModels(["mock-model"], { apiKey: "rotated-key", baseUrl: `${origin}/v2` }); // e.g. edited in Settings
    try {
      resetRequests();
      script = [reply("From the moved gateway.")];
      const { turn } = await runner.start(ctx({ conversationOnly: true })); // default model: no ctx.modelId

      expect(turn.reply).toBe("From the moved gateway.");
      expect(requestMeta[0]).toEqual({ url: "/v2/chat/completions", auth: "Bearer rotated-key" });
    } finally {
      writeModels(["mock-model"]);
    }
  }, 30_000);
});
