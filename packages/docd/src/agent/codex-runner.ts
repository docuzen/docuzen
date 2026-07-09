import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { AgentContext, AgentRunner, AgentTurn, EditHunk, ProposedEdit, TokenSink } from "./types.js";
import type { AgentHarness, HarnessCapabilities } from "./harness-registry.js";
import { SessionCounter } from "./runner-base.js";
import { historySection, standingInstructionsSection } from "./prompt-sections.js";
import { readModelWithKey } from "./model-registry.js";

/** codex's history/standing-instructions phrasing (see prompt-sections.ts for the pi divergence). */
const CODEX_HISTORY_LABELS = { agent: "Agent", reviewer: "Reviewer" };
const CODEX_HISTORY_HEADING = "## Conversation so far";
const CODEX_STANDING_INSTRUCTIONS_HEADING = "## Standing instructions";

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
}

interface LiveProcess {
  child: ChildProcessWithoutNullStreams;
  reject: (err: Error) => void;
}

interface CodexLaunchConfig {
  env?: NodeJS.ProcessEnv;
  configOverrides?: Record<string, string | undefined>;
  model?: string;
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
    if (!live) return;
    live.child.kill("SIGTERM");
    live.reject(new Error("Codex run cancelled"));
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
    const tempDir = await mkdtemp(join(tmpdir(), "docuzen-codex-"));
    const outputPath = join(tempDir, "last-message.txt");
    const launch = await this.codexLaunchConfig(ctx);
    const args = codexExecArgs({
      workDir,
      outputPath,
      model: launch.model,
      configOverrides: launch.configOverrides,
    });

    try {
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
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
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
      const settle = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        parser.stop();
        fn();
      };
      const timer =
        this.cfg.timeoutMs && this.cfg.timeoutMs > 0
          ? setTimeout(() => {
              child.kill("SIGTERM");
              settle(() => reject(new Error(`Codex timed out after ${this.cfg.timeoutMs}ms`)));
            }, this.cfg.timeoutMs)
          : null;
      if (cancelKey) {
        this.live.set(cancelKey, {
          child,
          reject: (err) => settle(() => reject(err)),
        });
      }

      child.stdout.on("data", (chunk: Buffer) => {
        if (settled) return;
        chunks.push(chunk);
        parser.push(chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => errors.push(chunk));
      child.on("error", (err) => settle(() => reject(err)));
      child.on("close", (code, signal) => {
        if (timer) clearTimeout(timer);
        if (cancelKey) this.live.delete(cancelKey);
        if (settled) return; // already cancelled/timed-out/errored — resolving now would race a rejected caller
        parser.end();
        const stdout = Buffer.concat(chunks).toString("utf8");
        const stderr = Buffer.concat(errors).toString("utf8");
        settle(() => {
          if (code === 0) resolve({ stdout, streamedToken: parser.streamedToken });
          else reject(new Error(`Codex failed${signal ? ` (${signal})` : ""}: ${stderr || stdout || code}`));
        });
      });

      child.stdin.end(prompt);
    });
  }

  private async codexLaunchConfig(ctx: AgentContext): Promise<CodexLaunchConfig> {
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

/** Exported for tests: byte-exact prompt-fragment characterization (see prompt-sections.ts). */
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

/**
 * True in the modes where pi would offer the propose_edit tool (see tool-policy.ts's
 * gating): the default propose mode and allowEdit ("directive") mode both want a
 * structured edit back; reviewMode wants findings, replacementOnly wants raw
 * replacement text, and conversationOnly turns (Phase 10: discuss/reply/panel/branch)
 * never edit at all — regardless of `settings.agentEdit` — so none of the three get the
 * contract. This single predicate gates BOTH the prompt clause below AND the reply
 * parser in `runCodex` (see its call site) — a volunteered trailing ```json block in a
 * conversation turn is never parsed into a proposal; it stays visible prose.
 */
function canProposeEdits(ctx: AgentContext): boolean {
  return !ctx.reviewMode && !ctx.replacementOnly && !ctx.conversationOnly;
}

/** Verbatim contract text asked of Codex in place of the "not exposed" disclaimer — see extractCodexProposal for the matching parser. */
const PROPOSAL_CONTRACT =
  "To propose a document edit, end your reply with exactly ONE fenced ```json block of shape" +
  ' {"rationale": string, "hunks": [{"oldText": string, "newText": string}, …]} or' +
  ' {"rationale": string, "fullRewrite": string}. oldText must be copied verbatim from the' +
  " document. Output no other fenced json blocks.";

export function buildCodexPrompt(ctx: AgentContext): string {
  const history = historySection(ctx.history, CODEX_HISTORY_HEADING, CODEX_HISTORY_LABELS);
  const instructions = standingInstructionsSection(
    ctx.instructions,
    CODEX_STANDING_INSTRUCTIONS_HEADING,
    true,
  );
  const mode = [
    ctx.conversationOnly
      ? "This is a conversation turn: discuss only. Docuzen will not apply or offer for" +
        " approval any edit you include here, even a fenced ```json block — it will be" +
        " shown to the reviewer as plain text, not as a proposal. If the reviewer wants a" +
        " change made, tell them to use Improve, Resolve, or Review instead."
      : "",
    ctx.replacementOnly
      ? "This turn wants only the replacement text for the highlighted passage. Reply with the replacement text only."
      : "",
    ctx.reviewMode
      ? "This turn is a document review. Return concise findings in prose. The Codex adapter cannot yet file Docuzen review annotations directly."
      : "",
    ctx.allowEdit
      ? "Docuzen direct-edit mode is not enabled for the Codex adapter yet; do not edit files. Describe the change instead."
      : "Do not edit files. Docuzen will persist only your final reply.",
  ].filter(Boolean);

  return [
    "You are running as Docuzen's Codex external harness adapter.",
    "Use Codex's native capabilities, including its managed web search when useful, but do not claim Docuzen tools are available.",
    canProposeEdits(ctx)
      ? PROPOSAL_CONTRACT
      : "Docuzen has not exposed propose_edit or add_review_finding tools to Codex yet.",
    "",
    "## Document",
    ctx.docPath ? `Path: ${ctx.docPath}` : "Path: unknown",
    ctx.htmlMode ? "Format: HTML source" : "Format: Markdown/body text",
    "",
    "## Stance",
    ctx.stancePrompt,
    ...instructions,
    ...history,
    "",
    "## Current document text",
    ctx.docText,
    "",
    "## Highlight / local context",
    `Highlighted text: ${ctx.anchorExact}`,
    ctx.surrounding,
    "",
    "## Reviewer request",
    ctx.comment,
    "",
    "## Adapter limitations",
    ...mode,
  ].join("\n");
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

/** Matches a fenced ```json block that runs all the way to the end of the (already
 * right-trimmed) string handed to it — see extractCodexProposal. */
const TRAILING_JSON_FENCE = /^```json[ \t]*\r?\n([\s\S]*?)\r?\n?```[ \t]*$/;

/**
 * Parser half of the structured-edit contract in buildCodexPrompt (PROPOSAL_CONTRACT):
 * pulls a TRAILING fenced ```json block out of a Codex reply and turns it into a
 * ProposedEdit, stripping the block from the returned reply.
 *
 * Only a block anchored at the very end of the reply (after trimming trailing
 * whitespace) is considered — an earlier ```json block (e.g. a code sample in the
 * agent's prose) is left untouched as ordinary reply text; only the LAST one is
 * ever a candidate. On any failure (no trailing block, invalid JSON, JSON that
 * matches neither the contract shape nor the legacy flat shape) this returns the
 * original reply completely unchanged and no proposal — never throws.
 *
 * On success the returned `reply` is the prose that preceded the block, trimmed; if
 * that's empty, the proposal's rationale is used instead, or "Proposed an edit." if
 * the rationale is empty too, so the persisted turn never has a blank reply.
 */
export function extractCodexProposal(reply: string): { reply: string; proposal?: ProposedEdit } {
  const trimmed = reply.trimEnd();
  const idx = trimmed.lastIndexOf("```json");
  if (idx === -1) return { reply };

  const match = trimmed.slice(idx).match(TRAILING_JSON_FENCE);
  if (!match) return { reply }; // ```json found, but more than whitespace follows its close — not trailing

  let parsed: unknown;
  try {
    parsed = JSON.parse(match[1] ?? "");
  } catch {
    return { reply };
  }

  const proposal = toProposedEdit(parsed);
  if (!proposal) return { reply };

  const prose = trimmed.slice(0, idx).trim();
  return { reply: prose || proposal.rationale || "Proposed an edit.", proposal };
}

/**
 * Validates+normalizes the parsed JSON into a ProposedEdit. Accepts the contract
 * shape ({rationale, hunks} / {rationale, fullRewrite}, rationale optional) and the
 * legacy flat shape a model might improvise instead ({oldText, newText}, mapped to a
 * single hunk with an empty rationale — mirrors pi-runner's propose_edit tool).
 * Returns undefined for anything else (wrong types, empty hunks array, neither
 * hunks nor fullRewrite present).
 */
function toProposedEdit(value: unknown): ProposedEdit | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const obj = value as Record<string, unknown>;

  if (
    obj.hunks === undefined &&
    obj.fullRewrite === undefined &&
    typeof obj.oldText === "string" &&
    typeof obj.newText === "string"
  ) {
    return { rationale: "", hunks: [{ oldText: obj.oldText, newText: obj.newText }] };
  }

  const rationale = typeof obj.rationale === "string" ? obj.rationale : "";

  if (Array.isArray(obj.hunks)) {
    if (obj.hunks.length === 0) return undefined;
    const hunks: EditHunk[] = [];
    for (const raw of obj.hunks) {
      if (!raw || typeof raw !== "object") return undefined;
      const h = raw as Record<string, unknown>;
      if (typeof h.oldText !== "string" || typeof h.newText !== "string") return undefined;
      hunks.push({ oldText: h.oldText, newText: h.newText });
    }
    return { rationale, hunks };
  }

  if (typeof obj.fullRewrite === "string") {
    return { rationale, fullRewrite: obj.fullRewrite };
  }

  return undefined;
}
