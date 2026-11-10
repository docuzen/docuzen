import type { AgentContext, AgentRunner, AgentTurn, TokenSink } from "./types.js";
import { SessionStore } from "./runner-base.js";

/** Scripted AgentRunner for tests and offline dev. Deterministic. */
export class FakePiRunner implements AgentRunner {
  private queue: AgentTurn[];
  /** Session ids this runner has actually started, with the ctx each was started with. */
  private sessions = new SessionStore<AgentContext>("fake");
  /** Messages passed to send(), recorded for assertions. */
  readonly sentMessages: string[] = [];
  /** Id of the most recently started session, for assertions that can't go through the TaskDB. */
  private lastStarted: string | undefined;
  /** cancelKeys passed to cancel(), recorded for assertions. */
  readonly cancelled: string[] = [];

  constructor(scriptedTurns: AgentTurn[]) {
    this.queue = [...scriptedTurns];
  }

  async start(
    ctx: AgentContext,
    onToken?: TokenSink,
  ): Promise<{ sessionId: string; turn: AgentTurn }> {
    const sessionId = this.sessions.start(ctx);
    this.lastStarted = sessionId;
    const turn = this.next();
    onToken?.({ type: "token", text: turn.reply });
    return { sessionId, turn };
  }

  async send(
    _sessionId: string,
    message: string,
    onToken?: TokenSink,
  ): Promise<AgentTurn> {
    this.sentMessages.push(message);
    const turn = this.next();
    onToken?.({ type: "token", text: turn.reply });
    return turn;
  }

  async cancel(cancelKey: string): Promise<void> {
    this.cancelled.push(cancelKey);
  }

  /** True only for ids this fake actually started — lets tests simulate a stale id. */
  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  /** The most recently started session's id (undefined before the first start()). */
  lastSessionId(): string | undefined {
    return this.lastStarted;
  }

  contextFor(sessionId: string): AgentContext | undefined {
    return this.sessions.get(sessionId);
  }

  private next(): AgentTurn {
    const turn = this.queue.shift();
    if (!turn) throw new Error("FakePiRunner: scripted turns exhausted");
    return turn;
  }
}
