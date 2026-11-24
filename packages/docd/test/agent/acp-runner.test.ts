// AcpRunner — the shim from AgentRunner onto the Agent Client Protocol — driven against
// scripted ACP agents built with the SDK's own agent side: in process for the protocol
// rules, and once as a real child process over stdio.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  agent,
  methods,
  PROTOCOL_VERSION,
  type AgentContext as AcpAgentContext,
  type NewSessionRequest,
  type NewSessionResponse,
  type PermissionOption,
  type RequestPermissionResponse,
  type StopReason,
} from "@agentclientprotocol/sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AcpRunner, createAcpHarness, findOnPath, type AcpAgentSpec, type AcpTransport } from "../../src/agent/acp-runner.js";
import type { AgentContext, AgentEvent } from "../../src/agent/types.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface PromptArgs {
  sessionId: string;
  text: string;
  client: AcpAgentContext;
  say: (text: string) => Promise<void>;
  think: (text: string) => Promise<void>;
  tool: (title: string) => Promise<void>;
  isCancelled: () => boolean;
}

interface FakeAgentOptions {
  session?: Omit<NewSessionResponse, "sessionId">;
  /** Advertise session/close + session/resume, so the runner parks sessions between turns. */
  parks?: boolean;
  /** Fail session/resume with this message. */
  resumeError?: string;
  prompt: (args: PromptArgs) => Promise<StopReason | void>;
}

/** A scripted in-process ACP agent, plus a log of what the runner asked of it. */
function fakeAgent(opts: FakeAgentOptions) {
  const log = {
    newSessions: [] as NewSessionRequest[],
    setMode: [] as string[],
    setConfig: [] as { configId: string; value: unknown }[],
    prompts: [] as { sessionId: string; text: string }[],
    cancels: [] as string[],
    closes: [] as string[],
    resumes: [] as string[],
  };
  const cancelled = new Set<string>();
  let n = 0;
  const app = agent({ name: "fake" })
    .onRequest(methods.agent.initialize, () => ({
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: opts.parks ? { sessionCapabilities: { close: {}, resume: {} } } : {},
    }))
    .onRequest(methods.agent.session.close, ({ params }) => {
      log.closes.push(params.sessionId);
      return {};
    })
    .onRequest(methods.agent.session.resume, async ({ params }) => {
      log.resumes.push(params.sessionId);
      if (opts.resumeError) throw new Error(opts.resumeError);
      return { ...opts.session };
    })
    .onRequest(methods.agent.session.new, ({ params }) => {
      log.newSessions.push(params);
      return { sessionId: `s${++n}`, ...opts.session };
    })
    .onRequest(methods.agent.session.setMode, ({ params }) => {
      log.setMode.push(params.modeId);
      return {};
    })
    .onRequest(methods.agent.session.setConfigOption, ({ params }) => {
      log.setConfig.push({ configId: params.configId, value: params.value });
      return { configOptions: [] };
    })
    .onNotification(methods.agent.session.cancel, ({ params }) => {
      log.cancels.push(params.sessionId);
      cancelled.add(params.sessionId);
    })
    .onRequest(methods.agent.session.prompt, async ({ params, client }) => {
      const text = params.prompt.map((b) => (b.type === "text" ? b.text : "")).join("");
      log.prompts.push({ sessionId: params.sessionId, text });
      const update = (u: Parameters<AcpAgentContext["notify"]>[1] extends never ? never : object) =>
        client.notify(methods.client.session.update, { sessionId: params.sessionId, update: u as never });
      const stop = await opts.prompt({
        sessionId: params.sessionId,
        text,
        client,
        say: (t) => update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: t } }),
        think: (t) => update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: t } }),
        tool: (title) => update({ sessionUpdate: "tool_call", toolCallId: title, title, kind: "read", status: "completed" }),
        isCancelled: () => cancelled.has(params.sessionId),
      });
      return { stopReason: stop ?? (cancelled.has(params.sessionId) ? "cancelled" : "end_turn") };
    });
  return { app, log };
}

/** An in-process transport whose "process exit" the test controls. */
function inProcess(app: ReturnType<typeof fakeAgent>["app"], stderr = "") {
  let exit!: () => void;
  const exited = new Promise<void>((r) => {
    exit = r;
  });
  const launches: number[] = [];
  const launch = (): AcpTransport => {
    launches.push(Date.now());
    return { target: app, stderr: () => stderr, exited, dispose: () => exit() };
  };
  return { launch, exit, launches };
}

const PLAN_MODES: Omit<NewSessionResponse, "sessionId"> = {
  modes: {
    currentModeId: "default",
    availableModes: [
      { id: "default", name: "Default" },
      { id: "plan", name: "Plan" },
    ],
  },
};

const spec = (over: Partial<AcpAgentSpec> = {}): AcpAgentSpec => ({
  id: "claude-code",
  label: "Claude Code",
  command: "claude-agent-acp",
  readOnlyMode: "plan",
  ...over,
});

let dir: string;
let docPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "acp-runner-"));
  docPath = join(dir, "doc.md");
  writeFileSync(docPath, "# Doc\n\nThe quick brwon fox.\n");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function ctx(over: Partial<AgentContext> = {}): AgentContext {
  return {
    docText: "# Doc\n\nThe quick brwon fox.\n",
    anchorExact: "brwon",
    surrounding: "The quick brwon fox.",
    comment: "Fix the typo.",
    stancePrompt: "Be brief.",
    docPath,
    scopeDir: dir,
    cancelKey: `${docPath}#t1`,
    ...over,
  };
}

describe("AcpRunner — a turn", () => {
  it("streams reply, reasoning and tool calls, and starts text after a tool call on a new paragraph", async () => {
    const { app, log } = fakeAgent({
      session: PLAN_MODES,
      prompt: async ({ say, think, tool }) => {
        await think("Looking at the passage.");
        await say("Let me read the file.");
        await tool("Read doc.md");
        await think("Found it.");
        await say("It should be ");
        await say("**brown**.");
      },
    });
    const runner = new AcpRunner(spec(), { launch: inProcess(app).launch });
    const events: AgentEvent[] = [];
    const { sessionId, turn } = await runner.start(ctx({ conversationOnly: true }), (e) => events.push(e));

    expect(turn.reply).toBe("Let me read the file.\n\nIt should be **brown**.");
    expect(turn.thinking).toBe("Looking at the passage.\n\nFound it.");
    expect(events.map((e) => e.type)).toEqual(["thinking", "token", "tool", "thinking", "token", "token"]);
    // What streamed is exactly what is kept.
    expect(events.filter((e) => e.type === "token").map((e) => e.text).join("")).toBe(turn.reply);
    expect(log.newSessions[0]).toEqual({ cwd: dir, mcpServers: [] });
    expect(log.prompts[0].text).toContain("You are running as Docuzen's Claude Code external harness adapter.");
    expect(sessionId).toMatch(/^claude-code-[0-9a-f-]{36}$/);
    expect(runner.hasSession(sessionId, "another document")).toBe(false);
    runner.dispose();
  });

  it("turns a trailing json block into a proposal in propose mode, and leaves it as prose in a conversation turn", async () => {
    const block =
      'Fixed the typo.\n\n```json\n{"rationale":"typo","hunks":[{"oldText":"brwon","newText":"brown"}]}\n```';
    const { app } = fakeAgent({ session: PLAN_MODES, prompt: async ({ say }) => void (await say(block)) });
    const runner = new AcpRunner(spec(), { launch: inProcess(app).launch });

    const propose = await runner.start(ctx());
    expect(propose.turn.reply).toBe("Fixed the typo.");
    expect(propose.turn.proposal).toEqual({ rationale: "typo", hunks: [{ oldText: "brwon", newText: "brown" }] });

    const talk = await runner.start(ctx({ conversationOnly: true }));
    expect(talk.turn.proposal).toBeUndefined();
    expect(talk.turn.reply).toBe(block);
    runner.dispose();
  });

  it("continues the same agent session on send(), keeping the reply contract the session started with", async () => {
    const block = '```json\n{"rationale":"r","hunks":[{"oldText":"a","newText":"b"}]}\n```';
    const { app, log } = fakeAgent({ session: PLAN_MODES, prompt: async ({ say }) => void (await say(block)) });
    const runner = new AcpRunner(spec(), { launch: inProcess(app).launch });
    const { sessionId } = await runner.start(ctx({ conversationOnly: true }));
    expect(runner.hasSession(sessionId)).toBe(true);

    const next = await runner.send(sessionId, "And now?");
    expect(log.prompts.map((p) => p.sessionId)).toEqual(["s1", "s1"]);
    expect(log.prompts[1].text).toBe("And now?");
    expect(next.proposal).toBeUndefined();

    runner.release(sessionId);
    expect(runner.hasSession(sessionId)).toBe(false);
    await expect(runner.send(sessionId, "again")).rejects.toThrow(/no longer running/);
    runner.dispose();
  });

  it("explains an empty reply by the agent's stop reason", async () => {
    const { app } = fakeAgent({ session: PLAN_MODES, prompt: async () => "max_tokens" });
    const runner = new AcpRunner(spec(), { launch: inProcess(app).launch });
    await expect(runner.start(ctx())).rejects.toThrow("Claude Code hit its output limit before replying");
    runner.dispose();
  });
});

describe("AcpRunner — parking sessions between turns", () => {
  it("closes each session after its turn and resumes it, back in read-only mode, for the next reply", async () => {
    const { app, log } = fakeAgent({ parks: true, session: PLAN_MODES, prompt: async ({ say }) => void (await say("ok")) });
    const runner = new AcpRunner(spec(), { launch: inProcess(app).launch });
    const { sessionId } = await runner.start(ctx({ conversationOnly: true }));
    await sleep(10); // the close is not awaited by the turn
    expect(log.closes).toEqual(["s1"]);
    expect(runner.hasSession(sessionId)).toBe(true);

    await runner.send(sessionId, "and?");
    expect(log.resumes).toEqual(["s1"]);
    expect(log.setMode).toEqual(["plan", "plan"]);
    expect(log.prompts.map((p) => p.sessionId)).toEqual(["s1", "s1"]);
    await sleep(10);
    expect(log.closes).toEqual(["s1", "s1"]);
    runner.dispose();
  });

  it("keeps the session open when the agent can close but not resume", async () => {
    const { app, log } = fakeAgent({ session: PLAN_MODES, prompt: async ({ say }) => void (await say("ok")) });
    const runner = new AcpRunner(spec(), { launch: inProcess(app).launch });
    const { sessionId } = await runner.start(ctx());
    await runner.send(sessionId, "again");
    expect(log.closes).toEqual([]);
    expect(log.resumes).toEqual([]);
    runner.dispose();
  });

  it("drops a session that will not resume, so the next reply replays the thread instead", async () => {
    const { app, log } = fakeAgent({
      parks: true,
      resumeError: "session file missing",
      session: PLAN_MODES,
      prompt: async ({ say }) => void (await say("ok")),
    });
    const runner = new AcpRunner(spec(), { launch: inProcess(app).launch });
    const { sessionId } = await runner.start(ctx());
    await expect(runner.send(sessionId, "and?")).rejects.toThrow(
      /Claude Code could not reopen this conversation: .*session file missing/,
    );
    expect(runner.hasSession(sessionId)).toBe(false);
    expect(log.prompts.length).toBe(1);
    runner.dispose();
  });

  it("a Stop pressed while the session is resuming means the reply is never sent", async () => {
    const { app, log } = fakeAgent({ parks: true, session: PLAN_MODES, prompt: async ({ say }) => void (await say("ok")) });
    const runner = new AcpRunner(spec(), { launch: inProcess(app).launch });
    const { sessionId } = await runner.start(ctx());
    const reply = runner.send(sessionId, "and?");
    await runner.cancel(`${docPath}#t1`);
    await expect(reply).rejects.toThrow("Claude Code run cancelled");
    expect(log.prompts.length).toBe(1);
    await sleep(10);
    expect(log.closes).toEqual(["s1", "s1"]);
    runner.dispose();
  });

  it("a reply refused because a turn is still running does not close the session under that turn", async () => {
    let finish!: () => void;
    let turns = 0;
    const { app, log } = fakeAgent({
      parks: true,
      session: PLAN_MODES,
      prompt: async ({ say }) => {
        if (++turns === 2) await new Promise<void>((r) => (finish = r));
        await say(`turn ${turns}`);
      },
    });
    const runner = new AcpRunner(spec(), { launch: inProcess(app).launch });
    const { sessionId } = await runner.start(ctx());
    const running = runner.send(sessionId, "long one");
    while (log.prompts.length < 2) await sleep(5);
    await expect(runner.send(sessionId, "too soon")).rejects.toThrow("Claude Code is still answering in this session");
    await sleep(10);
    expect(log.closes).toEqual(["s1"]);
    finish();
    expect((await running).reply).toBe("turn 2");
    await sleep(10);
    expect(log.closes).toEqual(["s1", "s1"]);
    runner.dispose();
  });

  it("release() closes an open session on the agent", async () => {
    const { app, log } = fakeAgent({ session: PLAN_MODES, prompt: async ({ say }) => void (await say("ok")) });
    const { app: parkApp, log: parkLog } = fakeAgent({ parks: true, session: PLAN_MODES, prompt: async ({ say }) => void (await say("ok")) });
    // No close capability: nothing is sent. With it, the parked session is already closed.
    const a = new AcpRunner(spec(), { launch: inProcess(app).launch });
    a.release((await a.start(ctx())).sessionId);
    expect(log.closes).toEqual([]);
    const b = new AcpRunner(spec(), { launch: inProcess(parkApp).launch });
    b.release((await b.start(ctx())).sessionId);
    await sleep(10);
    expect(parkLog.closes).toEqual(["s1"]);
    a.dispose();
    b.dispose();
  });
});

describe("AcpRunner — read-only mode", () => {
  it("switches every session into the read-only mode before the first prompt", async () => {
    const order: string[] = [];
    const { app, log } = fakeAgent({
      session: PLAN_MODES,
      prompt: async ({ say }) => {
        order.push(`prompt after ${log.setMode.join(",")}`);
        await say("ok");
      },
    });
    const runner = new AcpRunner(spec(), { launch: inProcess(app).launch });
    await runner.start(ctx());
    expect(order).toEqual(["prompt after plan"]);
    runner.dispose();
  });

  it("uses the mode config option when the agent describes modes that way", async () => {
    const { app, log } = fakeAgent({
      session: {
        configOptions: [
          {
            id: "permission_mode",
            name: "Mode",
            category: "mode",
            type: "select",
            currentValue: "default",
            options: [
              { group: "safe", name: "Safe", options: [{ value: "plan", name: "Plan" }] },
              { group: "other", name: "Other", options: [{ value: "default", name: "Default" }] },
            ],
          },
        ],
      },
      prompt: async ({ say }) => void (await say("ok")),
    });
    const runner = new AcpRunner(spec(), { launch: inProcess(app).launch });
    await runner.start(ctx());
    expect(log.setConfig).toEqual([{ configId: "permission_mode", value: "plan" }]);
    expect(log.setMode).toEqual([]);
    runner.dispose();
  });

  it("refuses an agent that does not offer the read-only mode, before sending any prompt", async () => {
    const { app, log } = fakeAgent({
      session: { modes: { currentModeId: "yolo", availableModes: [{ id: "yolo", name: "YOLO" }] } },
      prompt: async ({ say }) => void (await say("should not run")),
    });
    const runner = new AcpRunner(spec(), { launch: inProcess(app).launch });
    await expect(runner.start(ctx())).rejects.toThrow(
      'Claude Code did not offer its read-only mode "plan" (offered: yolo). Docuzen will not run it without one.',
    );
    expect(log.prompts).toEqual([]);
    runner.dispose();
  });

  it("refuses an agent that offers modes when config names none, and runs one that offers none", async () => {
    const withModes = fakeAgent({ session: PLAN_MODES, prompt: async ({ say }) => void (await say("x")) });
    const a = new AcpRunner(spec({ id: "acp:x", label: "X", readOnlyMode: undefined }), {
      launch: inProcess(withModes.app).launch,
    });
    await expect(a.start(ctx())).rejects.toThrow(/offers modes \(default, plan\).*Set read_only_mode/);
    expect(withModes.log.prompts).toEqual([]);
    a.dispose();

    const noModes = fakeAgent({ prompt: async ({ say }) => void (await say("fine")) });
    const b = new AcpRunner(spec({ id: "acp:y", label: "Y", readOnlyMode: undefined }), {
      launch: inProcess(noModes.app).launch,
    });
    expect((await b.start(ctx())).turn.reply).toBe("fine");
    b.dispose();
  });

  it("stops the turn and drops the session when the agent leaves read-only mode on its own", async () => {
    const { app, log } = fakeAgent({
      session: PLAN_MODES,
      prompt: async ({ client, sessionId, say, isCancelled }) => {
        await say("Switching to default mode.");
        await client.notify(methods.client.session.update, {
          sessionId,
          update: { sessionUpdate: "current_mode_update", currentModeId: "default" },
        });
        while (!isCancelled()) await sleep(5);
        return "cancelled";
      },
    });
    const runner = new AcpRunner(spec(), { launch: inProcess(app).launch });
    await expect(runner.start(ctx())).rejects.toThrow(
      'Claude Code left its read-only mode (now "default"). Docuzen stopped the turn.',
    );
    await sleep(10);
    expect(log.cancels).toEqual(["s1"]);
    runner.dispose();
  });
});

const OPTIONS: PermissionOption[] = [
  { optionId: "allow-always", name: "Always allow", kind: "allow_always" },
  { optionId: "allow-once", name: "Allow", kind: "allow_once" },
  { optionId: "reject-once", name: "Reject", kind: "reject_once" },
  { optionId: "reject-always", name: "Always reject", kind: "reject_always" },
];

describe("AcpRunner — what the agent may do", () => {
  it("allows read-only tool calls inside the folder once, and rejects everything else once", async () => {
    mkdirSync(join(dir, "sub"));
    symlinkSync("/etc", join(dir, "sub", "escape"));
    const asked: Record<string, string> = {};
    const { app } = fakeAgent({
      session: PLAN_MODES,
      prompt: async ({ client, sessionId, say }) => {
        const ask = async (name: string, kind: string, paths: string[], options = OPTIONS) => {
          const res: RequestPermissionResponse = await client.request(methods.client.session.requestPermission, {
            sessionId,
            toolCall: {
              toolCallId: name,
              title: name,
              kind: kind as never,
              locations: paths.map((path) => ({ path })),
            },
            options,
          });
          asked[name] = res.outcome.outcome === "selected" ? res.outcome.optionId : "cancelled";
        };
        await ask("read inside", "read", [docPath]);
        await ask("search relative", "search", ["sub"]);
        await ask("think", "think", []);
        await ask("web fetch", "fetch", []);
        await ask("read outside", "read", ["/etc/hosts"]);
        await ask("read through symlink", "read", [join(dir, "sub", "escape", "hosts")]);
        await ask("edit", "edit", [docPath]);
        await ask("delete", "delete", [docPath]);
        await ask("move", "move", [docPath]);
        await ask("shell", "execute", []);
        await ask("leave plan mode", "switch_mode", []);
        await ask("unknown tool", "other", []);
        await ask("read, no once option", "read", [docPath], OPTIONS.filter((o) => o.kind !== "allow_once"));
        await ask("edit, only always options", "edit", [docPath], OPTIONS.filter((o) => o.kind.endsWith("always")));
        await say("done");
      },
    });
    const runner = new AcpRunner(spec(), { launch: inProcess(app).launch });
    const events: AgentEvent[] = [];
    await runner.start(ctx(), (e) => events.push(e));

    expect(asked).toEqual({
      "read inside": "allow-once",
      "search relative": "allow-once",
      think: "allow-once",
      "web fetch": "allow-once",
      "read outside": "reject-once",
      "read through symlink": "reject-once",
      edit: "reject-once",
      delete: "reject-once",
      move: "reject-once",
      shell: "reject-once",
      "leave plan mode": "reject-once",
      "unknown tool": "reject-once",
      "read, no once option": "reject-once",
      "edit, only always options": "cancelled",
    });
    expect(events.filter((e) => e.type === "tool").map((e) => e.text)).toContain("refused: shell");
    runner.dispose();
  });

  it("reads files inside the folder for the agent, refuses outside ones, and never writes", async () => {
    mkdirSync(join(dir, "sub"));
    symlinkSync("/etc", join(dir, "sub", "escape"));
    const results: Record<string, string> = {};
    const { app } = fakeAgent({
      session: PLAN_MODES,
      prompt: async ({ client, sessionId, say }) => {
        const attempt = async (name: string, run: () => Promise<unknown>) => {
          try {
            results[name] = JSON.stringify(await run());
          } catch (e) {
            results[name] = `error: ${(e as Error).message}`;
          }
        };
        await attempt("whole", () => client.request(methods.client.fs.readTextFile, { sessionId, path: docPath }));
        await attempt("lines", () =>
          client.request(methods.client.fs.readTextFile, { sessionId, path: docPath, line: 3, limit: 1 }),
        );
        await attempt("outside", () => client.request(methods.client.fs.readTextFile, { sessionId, path: "/etc/hosts" }));
        await attempt("symlink", () =>
          client.request(methods.client.fs.readTextFile, { sessionId, path: join(dir, "sub", "escape", "hosts") }),
        );
        await attempt("write", () =>
          client.request(methods.client.fs.writeTextFile, { sessionId, path: docPath, content: "pwned" }),
        );
        await say("done");
      },
    });
    const runner = new AcpRunner(spec(), { launch: inProcess(app).launch });
    await runner.start(ctx());

    expect(results.whole).toBe(JSON.stringify({ content: "# Doc\n\nThe quick brwon fox.\n" }));
    expect(results.lines).toBe(JSON.stringify({ content: "The quick brwon fox." }));
    expect(results.outside).toMatch(/^error: .*outside the folder this session may read/);
    expect(results.symlink).toMatch(/^error: .*outside the folder this session may read/);
    expect(results.write).toMatch(/^error: .*does not let agents write files/);
    expect(readFileSync(docPath, "utf8")).toBe("# Doc\n\nThe quick brwon fox.\n");
    runner.dispose();
  });
});

describe("interactive permission requests", () => {
  it.each(["allow", "reject", "stop"] as const)("settles %s once and dismisses the prompt", async (choice) => {
    let outcome: RequestPermissionResponse | undefined;
    const { app } = fakeAgent({ session: PLAN_MODES, prompt: async ({ client, sessionId, say }) => {
      outcome = await client.request(methods.client.session.requestPermission, {
        sessionId, toolCall: { toolCallId: "r", title: "Read document", kind: "read", locations: [{ path: docPath }] },
        options: OPTIONS,
      });
      await say("done");
    } });
    const runner = new AcpRunner(spec({ selectedMode: () => "default" }), { launch: inProcess(app).launch });
    const events: string[] = [];
    let id = "";
    const turn = runner.start(ctx(), e => {
      events.push(e.type);
      if (e.type !== "permission") return;
      id = JSON.parse(e.text).id;
      if (choice === "stop") void runner.cancel(ctx().cancelKey!);
      else expect(runner.answerPermission(id, choice === "allow")).toBe(true);
    });
    if (choice === "stop") await expect(turn).rejects.toThrow("cancelled");
    else await turn;
    expect(outcome?.outcome).toEqual({ outcome: "selected", optionId: choice === "allow" ? "allow-once" : "reject-once" });
    expect(events).toContain("permissionClosed");
    expect(runner.answerPermission(id, true)).toBe(false);
    runner.dispose();
  });
});

describe("AcpRunner — stopping", () => {
  it("cancel() asks the agent to stop the turn and the turn ends as cancelled", async () => {
    const { app, log } = fakeAgent({
      session: PLAN_MODES,
      prompt: async ({ say, isCancelled }) => {
        await say("thinking hard…");
        while (!isCancelled()) await sleep(5);
        return "cancelled";
      },
    });
    const runner = new AcpRunner(spec(), { launch: inProcess(app).launch });
    const run = runner.start(ctx());
    while (!log.prompts.length) await sleep(5);
    await runner.cancel(`${docPath}#t1`);
    await expect(run).rejects.toThrow("Claude Code run cancelled");
    expect(log.cancels).toEqual(["s1"]);
    runner.dispose();
  });

  it("ends a cancelled turn after the grace period when the agent ignores the cancel", async () => {
    let release!: () => void;
    const { app, log } = fakeAgent({
      session: PLAN_MODES,
      prompt: () => new Promise<void>((r) => (release = r)),
    });
    const runner = new AcpRunner(spec(), { launch: inProcess(app).launch, cancelGraceMs: 30 });
    const run = runner.start(ctx());
    while (!log.prompts.length) await sleep(5);
    await runner.cancel(`${docPath}#t1`);
    await expect(run).rejects.toThrow("Claude Code run cancelled");
    release();
    runner.dispose();
  });

  it("a Stop pressed while the session is still being created means no prompt is ever sent", async () => {
    const { app, log } = fakeAgent({ session: PLAN_MODES, prompt: async ({ say }) => void (await say("no")) });
    const runner = new AcpRunner(spec(), { launch: inProcess(app).launch });
    const run = runner.start(ctx());
    await runner.cancel(`${docPath}#t1`);
    await expect(run).rejects.toThrow("Claude Code run cancelled");
    expect(log.prompts).toEqual([]);
    runner.dispose();
  });

  it("an agent that exits mid-turn ends the turn with its stderr, drops its sessions, and is relaunched next time", async () => {
    let turns = 0;
    const { app } = fakeAgent({
      session: PLAN_MODES,
      prompt: async ({ say }) => {
        turns++;
        if (turns === 2) await new Promise(() => {});
        await say(`turn ${turns}`);
      },
    });
    const t = inProcess(app, "panic: out of tokens");
    const runner = new AcpRunner(spec(), { launch: t.launch });
    const first = await runner.start(ctx());
    const second = runner.start(ctx());
    await sleep(20);
    t.exit();
    await expect(second).rejects.toThrow(/Claude Code exited[\s\S]*panic: out of tokens/);
    expect(runner.hasSession(first.sessionId)).toBe(false);
    expect(t.launches.length).toBe(1);

    // The next turn launches a new agent process.
    const t2 = inProcess(fakeAgent({ session: PLAN_MODES, prompt: async ({ say }) => void (await say("back")) }).app);
    (runner as unknown as { opts: { launch: typeof t2.launch } }).opts.launch = t2.launch;
    expect((await runner.start(ctx())).turn.reply).toBe("back");
    expect(t2.launches.length).toBe(1);
    runner.dispose();
  });
});

describe("AcpRunner — a real agent process over stdio", () => {
  const fixture = fileURLToPath(new URL("./fixtures/fake-acp-agent.mjs", import.meta.url));

  it("launches the agent, speaks ACP over its stdio, and stops it on dispose()", async () => {
    const runner = new AcpRunner(
      spec({ id: "acp:fake", label: "Fake", command: process.execPath, args: [fixture], readOnlyMode: "read-only" }),
    );
    const { sessionId, turn } = await runner.start(ctx());
    const match = /^pid (\d+) mode read-only$/.exec(turn.reply);
    expect(match).not.toBeNull();
    const pid = Number(match![1]);
    expect(runner.hasSession(sessionId)).toBe(true);

    runner.dispose();
    for (let i = 0; i < 200; i++) {
      try {
        process.kill(pid, 0);
        await sleep(10);
      } catch {
        break;
      }
    }
    expect(() => process.kill(pid, 0)).toThrow();
    expect(runner.hasSession(sessionId)).toBe(false);
  });

  it("reports an agent that cannot be started", async () => {
    const runner = new AcpRunner(spec({ command: join(dir, "missing-agent") }), { initTimeoutMs: 5_000 });
    await expect(runner.start(ctx())).rejects.toThrow(/Claude Code could not start[\s\S]*ENOENT/);
  });
});

describe("createAcpHarness", () => {
  it("lists a missing agent as unavailable, with how to install it", () => {
    const h = createAcpHarness(spec({ installHint: "install it with: npm i -g x" }), { find: () => null });
    expect(h).toMatchObject({
      id: "claude-code",
      available: false,
      unavailableReason: "claude-agent-acp not found on PATH (install it with: npm i -g x)",
    });
  });

  it("runs an installed agent from the path it was found at", () => {
    const h = createAcpHarness(spec(), { find: () => "/opt/bin/claude-agent-acp" });
    expect(h).toMatchObject({ id: "claude-code", available: true, status: "claude-agent-acp (ACP)" });
    expect(h.runner).toBeInstanceOf(AcpRunner);
  });

  it("findOnPath only finds executables", () => {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "agent"), "#!/bin/sh\n", { mode: 0o755 });
    writeFileSync(join(bin, "notexec"), "", { mode: 0o644 });
    expect(findOnPath("agent", bin)).toBe(join(bin, "agent"));
    expect(findOnPath("notexec", bin)).toBeNull();
    expect(findOnPath(join(bin, "agent"), "")).toBe(join(bin, "agent"));
  });
});
