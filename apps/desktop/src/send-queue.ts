// Per-thread FIFO send queue for the chat pane (user-mandated UX fix: messages
// typed while a thread's turn is already in flight get QUEUED and delivered when
// it frees up, instead of being hard-blocked).
//
// Kept in its own pure, DOM-free module (same rationale as click-jump.ts/
// anchor-map.ts: chat.ts's own DOM wiring isn't unit-testable in this
// package's vitest setup — no jsdom, see ui.test.ts's header) so the FIFO/
// drain/halt semantics below are directly unit-testable; chat.ts owns turning
// a `QueuedTurn` into an actual RPC call + transcript DOM.
//
// In-memory only: a `SendQueue` instance lives in the renderer's JS heap for
// the lifetime of the window/tab. A reload (or app restart) loses every
// not-yet-dispatched queued turn — there is no persistence layer for them.
// This is a deliberate scope limit (see task-1-brief.md), not an oversight.
//
// NOTE: this "queued" has nothing to do with the backend TaskRow status also
// spelled "queued" in chat.ts's Agents panel (a server-side task-scheduling
// concept). A `QueuedTurn` here is purely a client-side "not sent yet"
// message; it never becomes a TaskRow until it's actually dispatched.

/** One not-yet-dispatched (or currently-dispatching) chat message. */
export interface QueuedTurn {
  /** Unique id for this item's lifetime — used for ✕ removal and DOM bookkeeping. */
  id: string;
  threadId: string;
  text: string;
  /** Captured at commit time so a later footer picker change can't retroactively alter an already-committed message. */
  stance: string;
  modelId?: string;
}

/** What a dispatch attempt resolved to — decides whether `driveSend` keeps draining. */
export type SendOutcome = "sent" | "failed" | "stopped";

/**
 * Per-thread FIFO of not-yet-dispatched turns, plus the "is a turn currently
 * in flight for this thread" bit that governs whether a new commit dispatches
 * immediately or queues. One in-flight turn per thread, ever — enforced by
 * `driveSend` below being the only code path that dispatches, and by it being
 * the only caller of `markInFlight`/`clearInFlight`.
 */
export class SendQueue {
  private readonly queues = new Map<string, QueuedTurn[]>();
  private readonly inFlight = new Set<string>();

  /** True while `threadId` has a turn actually dispatched (awaiting/streaming its RPC). */
  isInFlight(threadId: string): boolean {
    return this.inFlight.has(threadId);
  }

  markInFlight(threadId: string): void {
    this.inFlight.add(threadId);
  }

  /** Call once the in-flight turn's RPC has settled (success, error, or stop). */
  clearInFlight(threadId: string): void {
    this.inFlight.delete(threadId);
  }

  /** Append to the tail of `item.threadId`'s queue. Does not touch in-flight state. */
  enqueue(item: QueuedTurn): void {
    const q = this.queues.get(item.threadId);
    if (q) q.push(item);
    else this.queues.set(item.threadId, [item]);
  }

  /** Snapshot of `threadId`'s not-yet-dispatched queue, oldest first. */
  list(threadId: string): readonly QueuedTurn[] {
    return this.queues.get(threadId) ?? [];
  }

  /**
   * Remove a queued (not-yet-dispatched) item by id — the ✕ affordance on a
   * queued chip. Returns the removed item, or undefined if it wasn't found
   * (already dispatched, already removed, or an unknown thread/id).
   */
  remove(threadId: string, itemId: string): QueuedTurn | undefined {
    const q = this.queues.get(threadId);
    if (!q) return undefined;
    const idx = q.findIndex((i) => i.id === itemId);
    if (idx === -1) return undefined;
    return q.splice(idx, 1)[0];
  }

  /** Pop the head of `threadId`'s queue, or undefined when it's empty. */
  dequeueNext(threadId: string): QueuedTurn | undefined {
    return this.queues.get(threadId)?.shift();
  }

  /** Drop one thread's queue + in-flight bit entirely (e.g. the thread/comment was deleted). */
  clearThread(threadId: string): void {
    this.queues.delete(threadId);
    this.inFlight.delete(threadId);
  }

  /** Drop every thread's queue + in-flight state (e.g. switching to a different document). */
  resetAll(): void {
    this.queues.clear();
    this.inFlight.clear();
  }
}

/**
 * Dispatch `item` via `send`, then keep draining `threadId`'s queue as long as
 * each dispatch resolves "sent" — one at a time, sequentially, never
 * concurrently (the in-flight bit is held for the whole `send` call).
 *
 * BIND (task-1-brief.md): a "failed" or "stopped" outcome HALTS the chain —
 * whatever is left in the queue (if anything) is left completely untouched,
 * still queued, for the user to manually clear (✕) and re-send. This function
 * never inspects *why* the outcome wasn't "sent"; `send` owns rendering the
 * failure/stop and any input-restore side effects.
 */
export async function driveSend(
  queue: SendQueue,
  threadId: string,
  item: QueuedTurn,
  send: (item: QueuedTurn) => Promise<SendOutcome>,
): Promise<void> {
  queue.markInFlight(threadId);
  let outcome: SendOutcome;
  try {
    outcome = await send(item);
  } finally {
    queue.clearInFlight(threadId);
  }
  if (outcome !== "sent") return; // halted — remaining queue (if any) stays queued
  const next = queue.dequeueNext(threadId);
  if (next) await driveSend(queue, threadId, next, send);
}
