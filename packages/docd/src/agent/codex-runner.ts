import { listCodexModels } from "./codex-models.js";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { AgentContext, AgentRunner, AgentTurn, ProposedEdit, TokenSink } from "./types.js";
import type { AgentHarness, HarnessCapabilities } from "./harness-registry.js";
import { SessionCounter } from "./runner-base.js";
import { buildHarnessPrompt, canProposeEdits, extractTrailingProposal } from "./harness-prompt.js";
import { readModelWithKey } from "./model-registry.js";

export const CODEX_CAPABILITIES: HarnessCapabilities = {
  proposeEdits: true,
  directEdit: false,
  reviewFindings: false,
  webSearch: "harness-managed",
  documentTools: "none",
  thinking: false,
  cancel: true,
  multiModelPanel: false,
};

export interface CodexDetection {
  available: boolean;
  command?: string;
  version?: string;
  reason?: string;
}

export interface CodexRunnerConfig {
  command?: string;
  model?: string;
  modelsPath?: string;
  timeoutMs?: number;
  /** How long a cancelled or timed-out codex gets after SIGTERM before it is SIGKILLed. */
  killGraceMs?: number;
}

const DEFAULT_KILL_GRACE_MS = 5_000;

interface LiveProcess {
  child: ChildProcessWithoutNullStreams;
  /** Stop the child and reject its run with `err`. */
  cancel: (err: Error) => void;
}

interface CodexLaunchConfig {
  env?: NodeJS.ProcessEnv;
  configOverrides?: Record<string, string | undefined>;
  model?: string;
}

/**
 * The human-readable reason a failed `codex exec --json` run gave. Its stdout is a JSONL
 * event stream; the reason is in the `error` / `turn.failed` events, so report those
 * messages rather than dumping the raw stream at the user. Falls back to stderr, then to
 * the raw stdout when nothing parses.
 */
export function codexFailureDetail(stdout: string, stderr: string): string {
  const messages: string[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim().startsWith("{")) continue;
    try {
      const ev = JSON.parse(line) as { type?: string; message?: unknown; error?: { message?: unknown } };
      const msg = ev.type === "error" ? ev.message : ev.type === "turn.failed" ? ev.error?.message : undefined;
      if (typeof msg === "string" && msg && !messages.includes(msg)) messages.push(msg);
    } catch {
      /* not an event line */
    }
  }
  let detail = messages.join("; ") || stderr.trim() || stdout.trim();
  const missing = /Missing environment variable: `?([A-Za-z_][A-Za-z0-9_]*)/.exec(detail);
  if (missing) {
    detail += ` Your Codex config reads its API key from ${missing[1]}, which is not set for docuzen. Export it in your shell profile (e.g. ~/.zshrc) and restart docuzen.`;
  }
  return detail;
}

export function detectCodexCli(command = process.env.CODEX_BIN ?? "codex"): CodexDetection {
  const result = spawnSync(command, ["--version"], {
    encoding: "utf8",
    timeout: 2_000,
  });
  if (result.error) {
    return {
      available: false,
      command,
      reason:
        result.error.message.includes("ENOENT") || result.error.message.includes("not found")
          ? `${command} not found on PATH`
          : result.error.message,
    };
  }
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || `exit ${result.status}`).trim();
    return { available: false, command, reason: detail };
  }
  return {
    available: true,
    command,
    version: (result.stdout || result.stderr || command).trim(),
  };
}

export function createCodexHarness(options: {
  detect?: () => CodexDetection;
  runner?: AgentRunner;
  config?: CodexRunnerConfig;
} = {}): AgentHarness {
  const detection = options.detect?.() ?? detectCodexCli(options.config?.command);
  return {
    id: "codex",
    label: "Codex",
    runner:
      options.runner ??
      (detection.available
        ? new CodexRunner({ ...options.config, command: detection.command })
        : new UnavailableCodexRunner(detection.reason ?? "Codex CLI is unavailable")),
    capabilities: CODEX_CAPABILITIES,
    available: detection.available,
    ...(detection.available
      ? { status: detection.version ?? "Codex CLI detected" }
      : { unavailableReason: detection.reason ?? "Codex CLI is unavailable" }),
  };
}

class UnavailableCodexRunner implements AgentRunner {
  constructor(private reason: string) {}

  async start(): Promise<{ sessionId: string; turn: AgentTurn }> {
    throw new Error(`Codex harness unavailable: ${this.reason}`);
  }

  async send(): Promise<AgentTurn> {
    throw new Error(`Codex harness unavailable: ${this.reason}`);
  }

  async cancel(): Promise<void> {}

  hasSession(): boolean {
    return false;
  }
}

export class CodexRunner implements AgentRunner {
  private sessionIds = new SessionCounter("codex");
  private live = new Map<string, LiveProcess>();
  /** Runs still resolving their launch config (no child yet), by cancel key: a Stop
   * pressed then is remembered here and honoured before the child is spawned. */
  private starting = new Map<string, { cancelled: boolean }>();

  constructor(private cfg: CodexRunnerConfig = {}) {}

  async start(
    ctx: AgentContext,
    onToken?: TokenSink,
  ): Promise<{ sessionId: string; turn: AgentTurn }> {
    const sessionId = this.sessionIds.next();
    const { reply, proposal } = await this.runCodex(ctx, onToken);
    return { sessionId, turn: { reply, ...(proposal ? { proposal } : {}) } };
  }

  async send(): Promise<AgentTurn> {
    throw new Error("Codex harness does not keep live Docuzen sessions; replay the thread with start()");
  }

  async cancel(cancelKey: string): Promise<void> {
    const live = this.live.get(cancelKey);
    if (live) live.cancel(new Error("Codex run cancelled"));
    else {
      const starting = this.starting.get(cancelKey);
      if (starting) starting.cancelled = true;
    }
  }

  hasSession(): boolean {
    return false;
  }

  private async runCodex(
    ctx: AgentContext,
    onToken?: TokenSink,
  ): Promise<{ reply: string; proposal?: ProposedEdit }> {
    const command = this.cfg.command ?? process.env.CODEX_BIN ?? "codex";
    const workDir = ctx.scopeDir ?? process.cwd();
    const key = ctx.cancelKey;
    const starting = { cancelled: false };
    if (key) this.starting.set(key, starting);
    try {
      // Resolve the launch config first: it can throw, and nothing needs cleaning up yet.
      const launch = await this.codexLaunchConfig(ctx);
      const tempDir = await mkdtemp(join(tmpdir(), "docuzen-codex-"));
      try {
        // A Stop that arrived while the config was resolving: never spawn the child.
        if (starting.cancelled) throw new Error("Codex run cancelled");
        return await this.runCodexIn(tempDir, command, workDir, launch, ctx, onToken);
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    } finally {
      if (key && this.starting.get(key) === starting) this.starting.delete(key);
    }
  }

  private async runCodexIn(
    tempDir: string,
    command: string,
    workDir: string,
    launch: CodexLaunchConfig,
    ctx: AgentContext,
    onToken?: TokenSink,
  ): Promise<{ reply: string; proposal?: ProposedEdit }> {
    const outputPath = join(tempDir, "last-message.txt");
    const args = codexExecArgs({
      workDir,
      outputPath,
      model: launch.model,
      configOverrides: launch.configOverrides,
    });
    const { stdout, streamedToken } = await this.spawnCodex(
      command,
      args,
      buildCodexPrompt(ctx),
      ctx.cancelKey,
      onToken,
      launch.env,
    );
    let reply = "";
    try {
      reply = (await readFile(outputPath, "utf8")).trim();
    } catch {
      reply = extractCodexText(stdout).trim();
    }
    if (!reply) reply = extractCodexText(stdout).trim();
    if (!reply) throw new Error("Codex returned no final message");
    // Only emit the one-shot final reply when nothing streamed live — otherwise the
    // reviewer would see the whole reply a second time after already watching it stream.
    // Emitted BEFORE the trailing-json-proposal strip below: the live stream (and this
    // one-shot fallback) intentionally still shows the raw fenced block. Suppressing it
    // from the stream is a follow-up (see buildCodexPrompt); the strip below only
    // affects what gets persisted as the turn's reply.
    if (!streamedToken) onToken?.({ type: "token", text: reply });

    // Only the modes where buildCodexPrompt hands out the structured-edit contract
    // (canProposeEdits) ever ask Codex for a trailing ```json block, so only those
    // modes look for one here — reviewMode findings and replacementOnly raw text
    // must never be reinterpreted as an edit proposal.
    if (canProposeEdits(ctx)) {
      const extracted = extractCodexProposal(reply);
      if (extracted.proposal) return extracted;
    }
    return { reply };
  }

  private spawnCodex(
    command: string,
    args: string[],
    prompt: string,
    cancelKey?: string,
    onToken?: TokenSink,
    env?: NodeJS.ProcessEnv,
  ): Promise<{ stdout: string; streamedToken: boolean }> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        stdio: ["pipe", "pipe", "pipe"],
        ...(env ? { env } : {}),
      });
      const chunks: Buffer[] = [];
      const errors: Buffer[] = [];
      const parser = new CodexEventParser(onToken);
      // Guards the cancel/timeout/error race described at CodexEventParser.stop():
      // once the outer promise has settled (cancelled, timed out, errored, or
      // closed), stdout data that keeps arriving from the still-dying child must
      // never reach onToken. `settled` short-circuits the `data` listener itself;
      // `parser.stop()` is a second, independent guard inside the parser so a stray
      // in-flight `push()` call can't emit either.
      let settled = false;
      let timer: NodeJS.Timeout | null = null;
      let killTimer: NodeJS.Timeout | null = null;
      const settle = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        parser.stop();
        if (timer) clearTimeout(timer);
        // A retry may already have registered a new child under the same key.
        if (cancelKey && this.live.get(cancelKey)?.child === child) this.live.delete(cancelKey);
        fn();
      };
      // SIGTERM first; a child that ignores it is SIGKILLed after the grace period.
      const terminate = (): void => {
        child.kill("SIGTERM");
        if (killTimer) return;
        killTimer = setTimeout(() => child.kill("SIGKILL"), this.cfg.killGraceMs ?? DEFAULT_KILL_GRACE_MS);
        killTimer.unref();
      };
      if (this.cfg.timeoutMs && this.cfg.timeoutMs > 0) {
        timer = setTimeout(() => {
          terminate();
          settle(() => reject(new Error(`Codex timed out after ${this.cfg.timeoutMs}ms`)));
        }, this.cfg.timeoutMs);
      }
      if (cancelKey) {
        this.live.set(cancelKey, {
          child,
          cancel: (err) => {
            terminate();
            settle(() => reject(err));
          },
        });
      }

      child.stdout.on("data", (chunk: Buffer) => {
        if (settled) return;
        chunks.push(chunk);
        parser.push(chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        if (!settled) errors.push(chunk);
      });
      child.on("error", (err) => settle(() => reject(err)));
      child.on("exit", () => {
        if (killTimer) clearTimeout(killTimer);
      });
      child.on("close", (code, signal) => {
        if (settled) return; // already cancelled/timed-out/errored — resolving now would race a rejected caller
        parser.end();
        const stdout = Buffer.concat(chunks).toString("utf8");
        const stderr = Buffer.concat(errors).toString("utf8");
        settle(() => {
          if (code === 0) resolve({ stdout, streamedToken: parser.streamedToken });
          else reject(new Error(`Codex failed${signal ? ` (${signal})` : ""}: ${codexFailureDetail(stdout, stderr) || code}`));
        });
      });

      // codex can exit before reading the whole prompt (bad config, auth error, a
      // cancel), and the rest of the write then fails with EPIPE. Its exit status, reported
      // on close, says what went wrong; unhandled, the write error would crash docd.
      child.stdin.on("error", () => {});
      child.stdin.end(prompt);
    });
  }

  listModels(cwd: string) {
    return listCodexModels(this.cfg.command ?? process.env.CODEX_BIN ?? "codex", cwd);
  }

  private async codexLaunchConfig(ctx: AgentContext): Promise<CodexLaunchConfig> {
    if (ctx.modelId?.startsWith("codex:")) {
      const model = ctx.modelId.slice("codex:".length);
      if (!model) throw new Error("Empty Codex model selection.");
      return { model };
    }
    // Existing documents and threads can retain an explicitly configured provider route.
    if (ctx.modelId) {
      if (!this.cfg.modelsPath) {
        throw new Error("Codex model selected, but Docuzen has no model registry path configured");
      }
      const model = await readModelWithKey(this.cfg.modelsPath, ctx.modelId);
      if (!model) {
        throw new Error(`Codex model ${ctx.modelId} not found in Settings > Models`);
      }
      if (!model.baseUrl) {
        throw new Error(`Codex model ${ctx.modelId} is missing a base URL`);
      }
      if (!model.apiKey) {
        throw new Error(`Codex model ${ctx.modelId} is missing an API key`);
      }
      const configOverrides: Record<string, string | undefined> = {
        model: model.modelId,
        model_provider: "docuzen",
        "model_providers.docuzen.name": "Docuzen model",
        "model_providers.docuzen.base_url": model.baseUrl,
        "model_providers.docuzen.env_key": "LLM_API_KEY",
      };
      if (model.reasoningEffort && model.reasoningEffort !== "none") {
        configOverrides.model_reasoning_effort = model.reasoningEffort;
      }
      return {
        configOverrides,
        env: { ...process.env, LLM_API_KEY: model.apiKey },
      };
    }
    return { model: this.cfg.model ?? process.env.CODEX_MODEL };
  }
}

/**
 * Shape of one `codex exec --json` NDJSON line, restricted to the fields this parser
 * reads. Captured empirically from codex-cli 0.142.5 (see
 * test/agent/fixtures/codex-json-lines.ndjson): lifecycle events are
 * `thread.started` / `turn.started` / `turn.completed` / `turn.failed` and
 * `item.started` / `item.updated` / `item.completed`, each `item` carrying a `type`
 * of `agent_message`, `reasoning`, `command_execution`, `file_change`,
 * `mcp_tool_call`, `web_search`, or `todo_list` (the last four confirmed present in
 * the installed CLI binary's string table but not observed in a captured run — this
 * parser treats any item type other than agent_message/reasoning as a tool-ish event
 * generically, so it degrades safely for those too).
 */
interface CodexJsonLine {
  type: string;
  item?: {
    id?: string;
    type?: string;
    text?: string;
    command?: string;
    tool?: string;
    query?: string;
    path?: string;
    server?: string;
    [key: string]: unknown;
  };
}

/**
 * Incrementally parses `codex exec --json` stdout into streamed AgentEvents.
 *
 * Feed it raw stdout chunks as they arrive via `push()` (partial lines split across
 * chunk boundaries — including mid-multibyte-character splits — are buffered via
 * StringDecoder and re-joined); call `end()` once the process closes to flush a
 * trailing line that never got a terminating newline.
 *
 * codex-cli 0.142.5 only ever emits a single `item.completed` per agent_message /
 * reasoning item (no delta events observed in captures) — see the fixture. But
 * `item.updated` is a real event type (present in the CLI binary's string table), so
 * this parser accumulates per-item-id text and emits only the NEW suffix on each
 * event for that id. That makes it correct today (one `item.completed` == one full
 * delta) and safe if a future/streaming config starts sending growing `item.updated`
 * text for the same id followed by a `item.completed` with the same final text
 * (no double-emit).
 */
export class CodexEventParser {
  private decoder = new StringDecoder("utf8");
  private buffer = "";
  /** item id -> text already emitted for it (agent_message / reasoning). */
  private textSeen = new Map<string, string>();
  /** item ids already announced as a `[tool] ...` marker (command_execution etc.). */
  private toolsAnnounced = new Set<string>();
  /** True once at least one agent-message token has streamed; gates the final one-shot emit. */
  streamedToken = false;
  /**
   * Set once the caller has stopped caring about further output (cancel, timeout-kill,
   * or an error/close reject). A child process that's been sent SIGTERM doesn't stop
   * emitting stdout instantly — data already in the pipe (or written before the signal
   * lands) still arrives at `push()`. Without this guard that data would keep flowing
   * through to `onToken` after the caller has already treated the run as over/rejected.
   * Idempotent and permanent: once stopped, `push()`/`end()` are no-ops.
   */
  private stopped = false;

  constructor(private onToken?: TokenSink) {}

  /** Stop emitting. Any `push()`/`end()` call after this is a no-op. Irreversible. */
  stop(): void {
    this.stopped = true;
  }

  /** Feed one stdout chunk. Safe to call with chunks that split a line or a multibyte char. */
  push(chunk: Buffer): void {
    if (this.stopped) return;
    this.buffer += this.decoder.write(chunk);
    this.drain();
  }

  /** Flush any trailing buffered line once the process has closed. */
  end(): void {
    if (this.stopped) return;
    this.buffer += this.decoder.end();
    if (this.buffer.trim()) this.handleLine(this.buffer);
    this.buffer = "";
  }

  private drain(): void {
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      if (line.trim()) this.handleLine(line);
    }
  }

  private handleLine(line: string): void {
    let event: CodexJsonLine;
    try {
      event = JSON.parse(line);
    } catch {
      return; // non-JSON / not a recognized event line — the stdout fallback still has it verbatim
    }
    const item = event.item;
    if (!item?.type) return;
    if (item.type === "agent_message") this.emitTextDelta(item, "token");
    else if (item.type === "reasoning") this.emitTextDelta(item, "thinking");
    else this.announceTool(item);
  }

  private emitTextDelta(item: NonNullable<CodexJsonLine["item"]>, type: "token" | "thinking"): void {
    const text = typeof item.text === "string" ? item.text : "";
    if (!text) return;
    // Items without an id (shouldn't happen in practice) each get a fresh slot so they
    // still stream in full rather than silently colliding under a shared "" key.
    const id = item.id ?? `${type}:${this.textSeen.size}`;
    const already = this.textSeen.get(id) ?? "";
    if (text === already) return;
    const delta = text.startsWith(already) ? text.slice(already.length) : text;
    this.textSeen.set(id, text);
    if (!delta) return;
    if (type === "token") this.streamedToken = true;
    this.onToken?.({ type, text: delta });
  }

  private announceTool(item: NonNullable<CodexJsonLine["item"]>): void {
    const id = item.id;
    if (id) {
      if (this.toolsAnnounced.has(id)) return; // one marker per tool call, not one per lifecycle event
      this.toolsAnnounced.add(id);
    }
    const name =
      (typeof item.command === "string" && item.command) ||
      (typeof item.tool === "string" && item.tool) ||
      (typeof item.query === "string" && item.query) ||
      (typeof item.path === "string" && item.path) ||
      (typeof item.server === "string" && item.server) ||
      item.type;
    this.onToken?.({ type: "thinking", text: `[tool] ${name}` });
  }
}

/**
 * Argv for `codex exec`. No `--search`: codex-cli 0.142.x removed the flag
 * (search feature flags retired; the CLI manages web access natively), and
 * passing it fails argv parsing before any turn runs. Passes `--skip-git-repo-check`
 * because documents commonly live outside git repos; codex's own sandbox is already
 * read-only and docuzen scopes file tools itself.
 */
export function codexExecArgs(opts: {
  workDir: string;
  outputPath: string;
  model?: string;
  configOverrides?: Record<string, string | undefined>;
}): string[] {
  const args = [
    "exec",
    "--json",
    "--sandbox",
    "read-only",
    "--skip-git-repo-check",
    "--cd",
    opts.workDir,
    "--output-last-message",
    opts.outputPath,
    "-",
  ];
  if (opts.model) args.splice(1, 0, "--model", opts.model);
  if (opts.configOverrides) {
    const entries = Object.entries(opts.configOverrides).filter((entry): entry is [string, string] =>
      entry[1] !== undefined,
    );
    for (const [key, value] of entries.reverse()) {
      args.splice(1, 0, "-c", `${key}=${tomlString(value)}`);
    }
  }
  return args;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

/** Codex's first prompt: the shared external-harness prompt, labelled for Codex. */
export function buildCodexPrompt(ctx: AgentContext): string {
  return buildHarnessPrompt(ctx, "Codex");
}

/**
 * Fallback path when `--output-last-message` couldn't be read: recover the agent's
 * reply straight from the captured `codex exec --json` stdout (see CodexJsonLine and
 * the fixture). Real lines nest text under `item.text` for `item.completed` /
 * `item.updated` events with `item.type === "agent_message"` — this used to search
 * the top-level event object for `text`/`delta`/`message`/`content`/`output` keys and
 * never looked inside `item`, so on the real schema it always found nothing and
 * silently returned "". Keyed by item id (falling back to a positional key for
 * id-less items) and overwritten on each sighting, so a later `item.completed`'s
 * full text replaces an earlier `item.updated`'s partial text for the same id rather
 * than duplicating it — mirrors CodexEventParser's per-id accumulation.
 */
export function extractCodexText(stdout: string): string {
  const textById = new Map<string, string>();
  const plainLines: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event: CodexJsonLine;
    try {
      event = JSON.parse(line) as CodexJsonLine;
    } catch {
      if (!line.startsWith("{")) plainLines.push(line);
      continue;
    }
    const item = event.item;
    if (item?.type !== "agent_message" || typeof item.text !== "string" || !item.text) continue;
    textById.set(item.id ?? `agent_message:${textById.size}`, item.text);
  }
  if (textById.size) return [...textById.values()].join("").trim();
  return plainLines.join("").trim();
}

/** The shared trailing-```json parser (harness-prompt.ts), under its original Codex name. */
export const extractCodexProposal = extractTrailingProposal;
