// A thin shim from Docuzen's AgentRunner onto the Agent Client Protocol (ACP), the
// stdio JSON-RPC protocol editors use to drive coding agents (Claude Code through
// claude-agent-acp, Gemini CLI, OpenCode, Goose, …). One AcpRunner drives one agent:
// a single long-lived agent process per harness, one ACP session per Docuzen session.
//
// Claude's tool profile is set by the host independently of the user's permission mode.
// Interactive grants expire with the turn. Custom adapters can pin a mode in config.
// Every adapter returns edits through Docuzen's structured proposal contract.
//
// An agent that can close and resume sessions has each session closed when its turn
// ends and resumed for the next reply: claude-agent-acp keeps a Claude Code process
// (several hundred MB) per open session, so leaving every discussed thread open would
// grow without bound. Agents that cannot do both keep their sessions open.
import { randomUUID } from "node:crypto";
import { methods as previewMethods, type SessionOptionsResponse } from "@agentclientprotocol/sdk/unstable";
import { spawn } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { Readable, Writable } from "node:stream";
import {
  AgentApp,
  client,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
  type ClientConnection,
  type InitializeResponse,
  type NewSessionResponse,
  type ReadTextFileRequest,
  type ReadTextFileResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionConfigOption,
  type SessionNotification,
  type StopReason,
  type Stream,
} from "@agentclientprotocol/sdk";
import type { AgentHarness, HarnessCapabilities, HarnessId } from "./harness-registry.js";
import { buildHarnessPrompt, canProposeEdits, extractTrailingProposal } from "./harness-prompt.js";
import { scopeCheck, type ScopeCheck } from "./scoped-file-tools.js";
import type { AgentContext, AgentRunner, AgentTurn, TokenSink } from "./types.js";

export const ACP_CAPABILITIES: HarnessCapabilities = {
  proposeEdits: true,
  directEdit: false,
  reviewFindings: false,
  webSearch: "harness-managed",
  documentTools: "none",
  thinking: true,
  cancel: true,
  multiModelPanel: false,
};

/** One ACP agent Docuzen can run: how to launch it and how to keep it read-only. */
export interface AcpAgentSpec {
  id: HarnessId;
  label: string;
  /** Executable (on PATH, or a path) that speaks ACP on stdio. */
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /**
   * The session mode Docuzen switches every session into before the first prompt
   * ("plan" for Claude Code). When unset, an agent that offers modes is refused (the
   * user must name one in config.toml), and one that offers none runs as it is, with
   * every non-read tool call refused at its permission prompt.
   */
  readOnlyMode?: string;
  /** Supplied only for adapters with a host-controlled document tool profile. */
  selectedMode?: () => string;
  sessionMeta?: Record<string, unknown>;
  /** Appended to the "not found" reason, e.g. how to install the adapter. */
  installHint?: string;
}

/** A connection to an agent: the ACP stream (or an in-process agent, for tests) plus the process around it. */
export interface AcpTransport {
  target: Stream | AgentApp;
  /** The last part of the agent's stderr, for error messages. */
  stderr(): string;
  /** Resolves when the agent process exits. */
  exited: Promise<void>;
  /** Stop the agent process. */
  dispose(): void;
}

export type AcpLauncher = (spec: AcpAgentSpec) => AcpTransport;

export interface AcpRunnerOptions {
  launch?: AcpLauncher;
  /** How long `initialize` may take (an adapter's first start can be slow). */
  initTimeoutMs?: number;
  /** How long a cancelled turn waits for the agent to stop before Docuzen gives up on it. */
  cancelGraceMs?: number;
}

const DEFAULT_INIT_TIMEOUT_MS = 60_000;
const DEFAULT_CANCEL_GRACE_MS = 5_000;
const STDERR_TAIL = 4_000;
const KILL_GRACE_MS = 5_000;
/** Tool kinds that only look: allowed when every path they name is inside the session's folder. */
const READ_KINDS = new Set(["read", "search", "think", "fetch"]);

/** Spawns the agent and speaks newline-delimited JSON-RPC over its stdio. */
export function spawnAcpAgent(spec: AcpAgentSpec): AcpTransport {
  const child = spawn(spec.command, spec.args ?? [], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...spec.env },
  });
  let stderr = "";
  const keep = (text: string): void => {
    stderr = (stderr + text).slice(-STDERR_TAIL);
  };
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", keep);
  // The agent can exit before reading everything sent to it; its exit is reported below.
  child.stdin.on("error", () => {});
  const exited = new Promise<void>((done) => {
    child.on("error", (e) => {
      keep(`\n${e.message}`);
      done();
    });
    child.on("exit", (code, signal) => {
      if (code) keep(`\n(exited with code ${code})`);
      else if (signal) keep(`\n(stopped by ${signal})`);
      done();
    });
  });
  return {
    target: ndJsonStream(
      Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    ),
    stderr: () => stderr.trim(),
    exited,
    dispose: () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }, KILL_GRACE_MS).unref();
    },
  };
}

interface Live {
  connection: ClientConnection;
  transport: AcpTransport;
  init: InitializeResponse;
  closed: boolean;
}

interface Turn {
  sink?: TokenSink;
  reply: string;
  thinking: string;
  /** Tool calls so far; text after a tool call starts a new paragraph. */
  tools: number;
  replyAt: number;
  thinkingAt: number;
  cancelled: boolean;
  /** Ends the turn with `err` whatever the agent does next. */
  abort: (err: Error) => void;
  cancelTimer?: NodeJS.Timeout;
  permissions: Set<string>;
}

interface Session {
  acpId: string;
  live: Live;
  /** The context the session started with: its mode decides the reply contract of every turn. */
  ctx: AgentContext;
  cwd: string;
  inScope: ScopeCheck;
  cancelKey?: string;
  turn: Turn | null;
  /** False while the session is closed between turns (see park/unpark). */
  open: boolean;
  mode?: string;
  /** The session/close of the last park, which a resume waits for. */
  parking?: Promise<void>;
}

export class AcpRunner implements AgentRunner {
  private pendingPermissions = new Map<string, (allow: boolean) => void>();
  private live: Promise<Live> | null = null;
  private sessions = new Map<string, Session>();
  private byAcpId = new Map<string, Session>();
  /** Sessions still being created, by cancel key: a Stop pressed then is honoured before the first prompt. */
  private starting = new Map<string, { cancelled: boolean }>();

  constructor(
    private spec: AcpAgentSpec,
    private opts: AcpRunnerOptions = {},
  ) {}

  async start(ctx: AgentContext, onToken?: TokenSink): Promise<{ sessionId: string; turn: AgentTurn }> {
    const key = ctx.cancelKey;
    const starting = { cancelled: false };
    if (key) this.starting.set(key, starting);
    let session: Session;
    try {
      session = await this.openSession(ctx, starting);
    } finally {
      if (key && this.starting.get(key) === starting) this.starting.delete(key);
    }
    const sessionId = this.spec.id + "-" + randomUUID();
    this.sessions.set(sessionId, session);
    try {
      return { sessionId, turn: await this.converse(session, buildHarnessPrompt(ctx, this.spec.label), onToken) };
    } catch (e) {
      // The orchestrator never learns this session's id, so nothing would release it.
      this.release(sessionId);
      throw e;
    }
  }

  async send(sessionId: string, message: string, onToken?: TokenSink): Promise<AgentTurn> {
    const session = this.sessions.get(sessionId);
    if (!session || session.live.closed) throw new Error(`${this.spec.label} session ${sessionId} is no longer running`);
    // A Stop pressed while the session is being resumed is honoured before the prompt.
    const key = session.cancelKey;
    const starting = { cancelled: false };
    if (key) this.starting.set(key, starting);
    try {
      await this.unpark(session);
    } finally {
      if (key && this.starting.get(key) === starting) this.starting.delete(key);
    }
    if (starting.cancelled) {
      this.park(session);
      throw new Error(`${this.spec.label} run cancelled`);
    }
    return this.converse(session, message, onToken);
  }

  async cancel(cancelKey: string): Promise<void> {
    const starting = this.starting.get(cancelKey);
    if (starting) starting.cancelled = true;
    for (const session of this.sessions.values()) {
      if (session.cancelKey === cancelKey && session.turn) this.stopTurn(session, session.turn);
    }
  }

  hasSession(sessionId: string, owner?: string): boolean {
    const session = this.sessions.get(sessionId);
    return !!session && !session.live.closed && (owner === undefined || session.cancelKey === owner);
  }

  private optionsProbe?: { cwd: string; result: Promise<SessionOptionsResponse> };

  private sessionOptions(cwd: string): Promise<SessionOptionsResponse> {
    if (this.optionsProbe?.cwd === cwd) return this.optionsProbe.result;
    const result = this.connect().then(live => withTimeout(live.connection.agent.request(previewMethods.agent.session.options, {
      cwd, _meta: this.spec.sessionMeta,
    }) as Promise<SessionOptionsResponse>, 20_000, this.spec.label + " did not return session options"));
    this.optionsProbe = { cwd, result };
    const clear = () => { if (this.optionsProbe?.result === result) this.optionsProbe = undefined; };
    void result.then(clear, clear);
    return result;
  }

  async listModels(cwd: string) {
    const res = await this.sessionOptions(cwd);
    const option = modelOption(res);
    return option ? selectChoices(option).map(o => ({ key: this.spec.id + ":" + o.value, name: o.name })) : [];
  }

  async permissionModes(cwd: string) {
    if (!this.spec.selectedMode) throw new Error("This harness has no selectable permission mode.");
    const res = await this.sessionOptions(cwd);
    return { selected: this.spec.selectedMode(), modes: res.modes?.availableModes.map(({ id, name }) => ({ id, name })) ?? [] };
  }

  answerPermission(id: string, allow: boolean): boolean {
    const settle = this.pendingPermissions.get(id);
    if (!settle) return false;
    settle(allow);
    return true;
  }

  private endPermissions(turn: Turn): void {
    for (const id of turn.permissions) this.answerPermission(id, false);
  }

  release(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.delete(sessionId);
    this.forget(session);
    if (session.open && session.live.init.agentCapabilities?.sessionCapabilities?.close && !session.live.closed) {
      session.live.connection.agent
        .request(methods.agent.session.close, { sessionId: session.acpId })
        .catch(() => {});
    }
  }

  /** Stop the agent process (sidecar shutdown, tests). Its sessions are gone afterwards. */
  dispose(): void {
    void this.live?.then((live) => this.close(live, new Error(`${this.spec.label} was stopped`))).catch(() => {});
  }

  // ---- sessions and turns ----------------------------------------------------------

  private async openSession(ctx: AgentContext, starting: { cancelled: boolean }): Promise<Session> {
    const live = await this.connect();
    this.throwIfCancelled(starting);
    const cwd = resolve(ctx.scopeDir ?? (ctx.docPath ? dirname(ctx.docPath) : process.cwd()));
    let res: NewSessionResponse;
    try {
      res = await live.connection.agent.request(methods.agent.session.new, { cwd, mcpServers: [], ...(this.spec.sessionMeta && { _meta: this.spec.sessionMeta }) });
    } catch (e) {
      throw this.agentError(e, live);
    }
    const session: Session = {
      acpId: res.sessionId,
      live,
      ctx,
      cwd,
      inScope: scopeCheck(cwd),
      cancelKey: ctx.cancelKey,
      turn: null,
      open: true,
    };
    this.byAcpId.set(res.sessionId, session);
    try {
      await this.applySessionModel(session, res);
      await this.applySessionMode(session, res);
      this.throwIfCancelled(starting);
    } catch (e) {
      this.forget(session);
      if (live.init.agentCapabilities?.sessionCapabilities?.close) {
        void live.connection.agent.request(methods.agent.session.close, { sessionId: session.acpId }).catch(() => {});
      }
      throw e instanceof RequestError ? this.agentError(e, live) : e;
    }
    return session;
  }

  private throwIfCancelled(starting: { cancelled: boolean }): void {
    if (starting.cancelled) throw new Error(`${this.spec.label} run cancelled`);
  }

  private async applySessionModel(session: Session, res: Pick<NewSessionResponse, "configOptions">): Promise<void> {
    const key = session.ctx.modelId;
    const prefix = this.spec.id + ":";
    if (!key?.startsWith(prefix)) return;
    const model = key.slice(prefix.length);
    const option = modelOption(res);
    if (!option || !selectValues(option).includes(model)) {
      throw new Error(`${this.spec.label} does not offer model "${model}". Choose another model in Settings.`);
    }
    if (option.currentValue !== model) {
      const result = await session.live.connection.agent.request(methods.agent.session.setConfigOption, {
        sessionId: session.acpId, configId: option.id, value: model,
      });
      if (modelOption(result)?.currentValue !== model) throw new Error(`${this.spec.label} did not select "${model}".`);
    }
  }

  /** Switch the session into the read-only mode the spec names; refuse an agent that cannot. */
  private async applySessionMode(
    session: Session,
    res: Pick<NewSessionResponse, "modes" | "configOptions">,
  ): Promise<void> {
    const want = this.spec.selectedMode?.() ?? this.spec.readOnlyMode;
    session.mode = want;
    // Newer agents describe modes as a "mode" config option, older ones as `modes`.
    const option = res.configOptions?.find(
      (o): o is SessionConfigOption & { type: "select" } => o.type === "select" && o.category === "mode",
    );
    const optionValues = option ? selectValues(option) : [];
    const modeIds = res.modes?.availableModes.map((m) => m.id) ?? [];
    const offered = [...new Set([...optionValues, ...modeIds])];
    if (!want) {
      if (!offered.length) return;
      throw new Error(
        `${this.spec.label} offers modes (${offered.join(", ")}) but Docuzen has not been told which one is read-only.` +
          ` Set read_only_mode for it in ~/.docuzen/config.toml.`,
      );
    }
    const agent = session.live.connection.agent;
    if (option && optionValues.includes(want)) {
      if (option.currentValue !== want) {
        await agent.request(methods.agent.session.setConfigOption, {
          sessionId: session.acpId,
          configId: option.id,
          value: want,
        });
      }
      return;
    }
    if (modeIds.includes(want)) {
      if (res.modes?.currentModeId !== want) {
        await agent.request(methods.agent.session.setMode, { sessionId: session.acpId, modeId: want });
      }
      return;
    }
    if (this.spec.selectedMode) {
      throw new Error(`${this.spec.label} does not offer permission mode "${want}". Choose a mode in Settings.`);
    }
    throw new Error(
      `${this.spec.label} did not offer its read-only mode "${want}" (offered: ${offered.join(", ") || "none"}).` +
        ` Docuzen will not run it without one.`,
    );
  }

  /** One turn, then the session is parked until the next one. */
  private async converse(session: Session, text: string, onToken?: TokenSink): Promise<AgentTurn> {
    try {
      return await this.runTurn(session, text, onToken);
    } finally {
      this.park(session);
    }
  }

  /** Close the session between turns, when the agent can resume it later. */
  private park(session: Session): void {
    const caps = session.live.init.agentCapabilities?.sessionCapabilities;
    // Never under a turn that is still running (a second send() refused while one runs ends here too).
    if (!caps?.close || !caps.resume || !session.open || session.turn || session.live.closed) return;
    if (this.byAcpId.get(session.acpId) !== session) return;
    session.open = false;
    session.parking = session.live.connection.agent
      .request(methods.agent.session.close, { sessionId: session.acpId })
      .then(
        () => {},
        () => {},
      );
  }

  /** Resume a parked session, back in its read-only mode. A session that will not resume is dropped. */
  private async unpark(session: Session): Promise<void> {
    if (session.open) return;
    await session.parking;
    try {
      const res = await session.live.connection.agent.request(methods.agent.session.resume, {
        sessionId: session.acpId,
        cwd: session.cwd,
        mcpServers: [],
        ...(this.spec.sessionMeta && { _meta: this.spec.sessionMeta }),
      });
      session.open = true;
      await this.applySessionModel(session, res);
      await this.applySessionMode(session, res);
    } catch (e) {
      this.forget(session);
      if (session.open) {
        session.live.connection.agent.request(methods.agent.session.close, { sessionId: session.acpId }).catch(() => {});
      }
      const err = e instanceof RequestError ? this.agentError(e, session.live) : (e as Error);
      throw new Error(`${this.spec.label} could not reopen this conversation: ${err.message}`);
    }
  }

  private async runTurn(session: Session, text: string, onToken?: TokenSink): Promise<AgentTurn> {
    const label = this.spec.label;
    if (session.turn) throw new Error(`${label} is still answering in this session`);
    let abort!: (err: Error) => void;
    const aborted = new Promise<never>((_, reject) => {
      abort = reject;
    });
    const turn: Turn = { sink: onToken, reply: "", thinking: "", tools: 0, replyAt: 0, thinkingAt: 0, cancelled: false, permissions: new Set(), abort };
    session.turn = turn;
    try {
      const res = await Promise.race([
        session.live.connection.agent.request(methods.agent.session.prompt, {
          sessionId: session.acpId,
          prompt: [{ type: "text", text }],
        }),
        aborted,
      ]);
      if (turn.cancelled || res.stopReason === "cancelled") throw new Error(`${label} run cancelled`);
      const reply = turn.reply.trim();
      if (!reply) throw new Error(emptyReplyReason(label, res.stopReason));
      const out: AgentTurn = { reply };
      if (turn.thinking.trim()) out.thinking = turn.thinking.trim();
      if (canProposeEdits(session.ctx)) {
        const extracted = extractTrailingProposal(reply);
        if (extracted.proposal) {
          out.reply = extracted.reply;
          out.proposal = extracted.proposal;
        }
      }
      return out;
    } catch (e) {
      if (turn.cancelled) throw new Error(`${label} run cancelled`);
      throw e instanceof RequestError ? this.agentError(e, session.live) : e;
    } finally {
      this.endPermissions(turn);
      clearTimeout(turn.cancelTimer);
      if (session.turn === turn) session.turn = null;
    }
  }

  /** Ask the agent to stop the turn; if it has not within the grace period, end the turn anyway. */
  private stopTurn(session: Session, turn: Turn, reason?: Error): void {
    if (turn.cancelled) return;
    this.endPermissions(turn);
    turn.cancelled = !reason;
    session.live.connection.agent
      .notify(methods.agent.session.cancel, { sessionId: session.acpId })
      .catch(() => {});
    if (reason) {
      turn.abort(reason);
      return;
    }
    turn.cancelTimer = setTimeout(
      () => turn.abort(new Error(`${this.spec.label} run cancelled`)),
      this.opts.cancelGraceMs ?? DEFAULT_CANCEL_GRACE_MS,
    );
    turn.cancelTimer.unref?.();
  }

  private forget(session: Session): void {
    if (this.byAcpId.get(session.acpId) === session) this.byAcpId.delete(session.acpId);
    for (const [id, s] of this.sessions) if (s === session) this.sessions.delete(id);
  }

  // ---- the connection ----------------------------------------------------------------

  private connect(): Promise<Live> {
    if (this.live) return this.live;
    const opening = this.open();
    this.live = opening;
    opening.catch(() => {
      if (this.live === opening) this.live = null;
    });
    return opening;
  }

  private async open(): Promise<Live> {
    const transport = (this.opts.launch ?? spawnAcpAgent)(this.spec);
    const app = client({ name: "docuzen" })
      .onNotification(methods.client.session.update, ({ params }) => this.onUpdate(params))
      .onRequest(methods.client.session.requestPermission, ({ params }) => this.onPermission(params))
      .onRequest(methods.client.fs.readTextFile, ({ params }) => this.onReadTextFile(params))
      .onRequest(methods.client.fs.writeTextFile, ({ params }) => {
        this.byAcpId.get(params.sessionId)?.turn?.sink?.({ type: "tool", text: `refused: write ${params.path}` });
        throw RequestError.invalidRequest(
          undefined,
          "Docuzen does not let agents write files. Propose the edit in your reply instead.",
        );
      });
    const connection =
      transport.target instanceof AgentApp ? app.connect(transport.target) : app.connect(transport.target);
    const live: Live = { connection, transport, init: { protocolVersion: PROTOCOL_VERSION }, closed: false };
    void connection.closed.then(() => this.onClosed(live));
    void transport.exited.then(() => {
      const stderr = transport.stderr();
      this.close(live, new Error(`${this.spec.label} exited${stderr ? `\n${stderr}` : ""}`));
    });
    try {
      live.init = await withTimeout(
        connection.agent.request(methods.agent.initialize, {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: { fs: { readTextFile: true, writeTextFile: false }, terminal: false },
          clientInfo: { name: "docuzen", version: "1" },
        }),
        this.opts.initTimeoutMs ?? DEFAULT_INIT_TIMEOUT_MS,
        `${this.spec.label} did not answer initialize`,
      );
    } catch (e) {
      const err = this.agentError(e, live, "could not start");
      this.close(live, err);
      throw err;
    }
    if (live.init.protocolVersion !== PROTOCOL_VERSION) {
      const err = new Error(
        `${this.spec.label} speaks ACP version ${live.init.protocolVersion}; Docuzen supports version ${PROTOCOL_VERSION}`,
      );
      this.close(live, err);
      throw err;
    }
    return live;
  }

  private close(live: Live, err: Error): void {
    live.connection.close(err);
    live.transport.dispose();
    this.onClosed(live, err);
  }

  /** The agent is gone: end its turns and forget its sessions, so the next start() relaunches it. */
  private onClosed(live: Live, err?: Error): void {
    if (live.closed) return;
    live.closed = true;
    void this.live?.then((current) => {
      if (current === live) this.live = null;
    }).catch(() => {});
    const reason = err ?? this.agentError(new Error(`${this.spec.label} stopped`), live);
    for (const session of [...this.byAcpId.values()]) {
      if (session.live !== live) continue;
      session.turn?.abort(reason);
      this.forget(session);
    }
  }

  // ---- requests and notifications from the agent --------------------------------------

  private onUpdate(n: SessionNotification): void {
    const session = this.byAcpId.get(n.sessionId);
    const turn = session?.turn;
    if (!session || !turn) return;
    const u = n.update;
    switch (u.sessionUpdate) {
      case "agent_message_chunk":
        if (u.content.type === "text") this.appendText(turn, "reply", u.content.text);
        break;
      case "agent_thought_chunk":
        if (u.content.type === "text") this.appendText(turn, "thinking", u.content.text);
        break;
      case "tool_call":
        turn.tools++;
        turn.sink?.({ type: "tool", text: u.title || u.kind || "tool" });
        break;
      case "current_mode_update":
        this.checkMode(session, turn, u.currentModeId);
        break;
      case "config_option_update": {
        const mode = u.configOptions.find((o) => o.type === "select" && o.category === "mode");
        if (mode && mode.type === "select") this.checkMode(session, turn, mode.currentValue);
        break;
      }
      default:
        break;
    }
  }

  /** Docuzen refuses mode-switch permission prompts, so a new mode here is the agent switching on its own. */
  private checkMode(session: Session, turn: Turn, modeId: string): void {
    const want = session.mode;
    if (!want || modeId === want) return;
    this.stopTurn(
      session,
      turn,
      new Error(`${this.spec.label} left its ${this.spec.selectedMode ? "selected permission" : "read-only"} mode (now "${modeId}"). Docuzen stopped the turn.`),
    );
    this.forget(session);
    if (session.live.init.agentCapabilities?.sessionCapabilities?.close) {
      void session.live.connection.agent.request(methods.agent.session.close, { sessionId: session.acpId }).catch(() => {});
    }
  }

  private appendText(turn: Turn, field: "reply" | "thinking", text: string): void {
    const at = field === "reply" ? "replyAt" : "thinkingAt";
    // Text the agent writes after a tool call is a new paragraph, not a continuation.
    const gap = turn[field] && turn[at] !== turn.tools && !turn[field].endsWith("\n") ? "\n\n" : "";
    turn[at] = turn.tools;
    turn[field] += gap + text;
    turn.sink?.({ type: field === "reply" ? "token" : "thinking", text: gap + text });
  }

  private async onPermission(p: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    const session = this.byAcpId.get(p.sessionId);
    const kind = p.toolCall.kind ?? "other";
    const startedTurn = session?.turn;
    const allowed = !!session && !!startedTurn && READ_KINDS.has(kind) && (await this.allInScope(session, p.toolCall.locations))
      && session.turn === startedTurn && !startedTurn.cancelled;
    // Only ever the "once" options: an "always" answer would be written into the agent's own settings.
    const allowOnce = allowed ? p.options.find((o) => o.kind === "allow_once") : undefined;
    const turn = session?.turn;
    const sink = turn?.sink;
    if (this.spec.selectedMode && allowOnce && turn && !turn.cancelled && sink) {
      const id = randomUUID();
      const granted = await new Promise<boolean>((resolve) => {
        const expiry = setTimeout(() => this.answerPermission(id, false), 120_000);
        expiry.unref();
        this.pendingPermissions.set(id, (allow) => {
          clearTimeout(expiry);
          this.pendingPermissions.delete(id);
          turn.permissions.delete(id);
          resolve(allow);
          turn.sink?.({ type: "permissionClosed", text: id });
        });
        turn.permissions.add(id);
        sink({ type: "permission", text: JSON.stringify({
          id, harness: this.spec.id, label: this.spec.label, document: session.ctx.docPath,
          title: p.toolCall.title ?? kind, locations: p.toolCall.locations?.map((loc) => loc.path) ?? [],
        }) });
      });
      if (granted) return { outcome: { outcome: "selected", optionId: allowOnce.optionId } };
    }
    const option = (this.spec.selectedMode ? undefined : allowOnce) ?? p.options.find((o) => o.kind === "reject_once");
    if (!allowOnce) {
      session?.turn?.sink?.({ type: "tool", text: `refused: ${p.toolCall.title ?? kind}` });
    }
    return option
      ? { outcome: { outcome: "selected", optionId: option.optionId } }
      : { outcome: { outcome: "cancelled" } };
  }

  private async allInScope(session: Session, locations: { path: string }[] | null | undefined): Promise<boolean> {
    for (const loc of locations ?? []) {
      try {
        await session.inScope(isAbsolute(loc.path) ? loc.path : join(session.cwd, loc.path), loc.path);
      } catch {
        return false;
      }
    }
    return true;
  }

  private async onReadTextFile(p: ReadTextFileRequest): Promise<ReadTextFileResponse> {
    const session = this.byAcpId.get(p.sessionId);
    if (!session) throw RequestError.sessionNotFound(p.sessionId);
    let real: string;
    try {
      real = await session.inScope(isAbsolute(p.path) ? p.path : join(session.cwd, p.path), p.path);
    } catch (e) {
      throw RequestError.invalidParams(undefined, e instanceof Error ? e.message : String(e));
    }
    const text = await readFile(real, "utf8");
    if (p.line == null && p.limit == null) return { content: text };
    const lines = text.split("\n");
    const from = Math.max(0, (p.line ?? 1) - 1);
    return { content: lines.slice(from, p.limit == null ? undefined : from + p.limit).join("\n") };
  }

  // ---- errors --------------------------------------------------------------------------

  private agentError(e: unknown, live: Live, doing?: string): Error {
    let message = e instanceof Error ? e.message : String(e);
    // The SDK reports an agent's own failure as "Internal error", with the cause in data.details.
    const data = e instanceof RequestError ? (e.data as { details?: unknown; message?: unknown } | string | undefined) : undefined;
    const detail = typeof data === "string" ? data : typeof data?.details === "string" ? data.details : typeof data?.message === "string" ? data.message : "";
    if (detail && !message.includes(detail)) message = `${message}: ${detail}`;
    const prefix = doing ? `${this.spec.label} ${doing}: ` : message.includes(this.spec.label) ? "" : `${this.spec.label}: `;
    if (e instanceof RequestError && e.code === -32000) {
      return new Error(`${prefix}${message}. Sign in with ${this.spec.label}'s own CLI, then try again.`);
    }
    const stderr = live.closed || doing ? live.transport.stderr() : "";
    return new Error(`${prefix}${message}${stderr ? `\n${stderr}` : ""}`);
  }
}

function modelOption(res: Pick<NewSessionResponse, "configOptions">) {
  return res.configOptions?.find((o): o is SessionConfigOption & { type: "select" } => o.type === "select" && o.category === "model");
}
function selectChoices(option: SessionConfigOption & { type: "select" }) {
  return option.options.flatMap(o => "options" in o ? [...o.options] : [o]);
}

function selectValues(option: SessionConfigOption & { type: "select" }): string[] {
  return selectChoices(option).map(o => o.value);
}

function emptyReplyReason(label: string, stop: StopReason): string {
  switch (stop) {
    case "max_tokens":
      return `${label} hit its output limit before replying`;
    case "max_turn_requests":
      return `${label} hit its limit on steps for one turn before replying`;
    case "refusal":
      return `${label} refused to answer`;
    default:
      return `${label} returned no reply`;
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${message} within ${Math.round(ms / 1000)}s`)), ms);
    timer.unref?.();
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

/** The absolute path `command` runs, or null when it is not an executable on PATH. */
export function findOnPath(command: string, path = process.env.PATH ?? ""): string | null {
  const candidates = command.includes("/") ? [resolve(command)] : path.split(delimiter).filter(Boolean).map((d) => join(d, command));
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // not here
    }
  }
  return null;
}

class UnavailableRunner implements AgentRunner {
  constructor(private reason: string) {}

  async start(): Promise<{ sessionId: string; turn: AgentTurn }> {
    throw new Error(this.reason);
  }

  async send(): Promise<AgentTurn> {
    throw new Error(this.reason);
  }
}

/** A registry entry for `spec`: live when its command is installed, otherwise listed as unavailable with the reason. */
export function createAcpHarness(spec: AcpAgentSpec, options: AcpRunnerOptions & { find?: typeof findOnPath } = {}): AgentHarness {
  const found = (options.find ?? findOnPath)(spec.command);
  if (!found) {
    const reason = `${spec.command} not found on PATH${spec.installHint ? ` (${spec.installHint})` : ""}`;
    return {
      id: spec.id,
      label: spec.label,
      runner: new UnavailableRunner(`${spec.label} harness unavailable: ${reason}`),
      capabilities: ACP_CAPABILITIES,
      ...(spec.selectedMode && { permissionModes: true }),
      available: false,
      unavailableReason: reason,
    };
  }
  return {
    id: spec.id,
    label: spec.label,
    runner: new AcpRunner({ ...spec, command: found }, options),
    capabilities: ACP_CAPABILITIES,
      ...(spec.selectedMode && { permissionModes: true }),
    available: true,
    status: `${spec.command} (ACP)`,
  };
}
