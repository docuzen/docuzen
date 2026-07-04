import { describe, expect, it, vi } from "vitest";
import { SendQueue, driveSend, type QueuedTurn, type SendOutcome } from "./send-queue.js";

function item(overrides: Partial<QueuedTurn> = {}): QueuedTurn {
  return { id: "q1", threadId: "t1", text: "hello", stance: "none", ...overrides };
}

describe("SendQueue", () => {
  it("starts idle: no thread is in flight and every queue is empty", () => {
    const q = new SendQueue();
    expect(q.isInFlight("t1")).toBe(false);
    expect(q.list("t1")).toEqual([]);
  });

  it("enqueue appends to the tail, FIFO order, per thread", () => {
    const q = new SendQueue();
    q.enqueue(item({ id: "a", text: "first" }));
    q.enqueue(item({ id: "b", text: "second" }));
    expect(q.list("t1").map((i) => i.id)).toEqual(["a", "b"]);
  });

  it("dequeueNext pops the head and leaves the rest in order", () => {
    const q = new SendQueue();
    q.enqueue(item({ id: "a" }));
    q.enqueue(item({ id: "b" }));
    expect(q.dequeueNext("t1")?.id).toBe("a");
    expect(q.list("t1").map((i) => i.id)).toEqual(["b"]);
  });

  it("dequeueNext on an empty/unknown thread returns undefined", () => {
    const q = new SendQueue();
    expect(q.dequeueNext("nope")).toBeUndefined();
  });

  it("remove (the ✕ affordance) removes a queued item by id and returns it", () => {
    const q = new SendQueue();
    q.enqueue(item({ id: "a" }));
    q.enqueue(item({ id: "b" }));
    q.enqueue(item({ id: "c" }));
    const removed = q.remove("t1", "b");
    expect(removed?.id).toBe("b");
    expect(q.list("t1").map((i) => i.id)).toEqual(["a", "c"]);
  });

  it("remove is a no-op (returns undefined) for an id that isn't queued", () => {
    const q = new SendQueue();
    q.enqueue(item({ id: "a" }));
    expect(q.remove("t1", "not-there")).toBeUndefined();
    expect(q.remove("other-thread", "a")).toBeUndefined();
    expect(q.list("t1").map((i) => i.id)).toEqual(["a"]);
  });

  it("in-flight bit is tracked independently per thread", () => {
    const q = new SendQueue();
    q.markInFlight("t1");
    expect(q.isInFlight("t1")).toBe(true);
    expect(q.isInFlight("t2")).toBe(false);
    q.clearInFlight("t1");
    expect(q.isInFlight("t1")).toBe(false);
  });

  it("wrong-thread isolation: enqueue/remove/dequeue on one thread never touch another's queue", () => {
    const q = new SendQueue();
    q.enqueue(item({ id: "a", threadId: "A" }));
    q.enqueue(item({ id: "b", threadId: "B" }));
    q.markInFlight("A");
    expect(q.isInFlight("B")).toBe(false);
    expect(q.list("B").map((i) => i.id)).toEqual(["b"]);
    q.dequeueNext("A");
    expect(q.list("A")).toEqual([]);
    expect(q.list("B").map((i) => i.id)).toEqual(["b"]); // untouched
    q.remove("A", "a"); // already dequeued — no-op, must not affect B
    expect(q.list("B").map((i) => i.id)).toEqual(["b"]);
  });

  it("clearThread drops one thread's queue + in-flight bit without touching others", () => {
    const q = new SendQueue();
    q.enqueue(item({ id: "a", threadId: "A" }));
    q.enqueue(item({ id: "b", threadId: "B" }));
    q.markInFlight("A");
    q.clearThread("A");
    expect(q.list("A")).toEqual([]);
    expect(q.isInFlight("A")).toBe(false);
    expect(q.list("B").map((i) => i.id)).toEqual(["b"]);
  });

  it("resetAll drops every thread's queue + in-flight state", () => {
    const q = new SendQueue();
    q.enqueue(item({ id: "a", threadId: "A" }));
    q.enqueue(item({ id: "b", threadId: "B" }));
    q.markInFlight("A");
    q.resetAll();
    expect(q.list("A")).toEqual([]);
    expect(q.list("B")).toEqual([]);
    expect(q.isInFlight("A")).toBe(false);
  });
});

describe("driveSend", () => {
  it("dispatches the given item directly when nothing is queued behind it", async () => {
    const q = new SendQueue();
    const send = vi.fn(async (): Promise<SendOutcome> => "sent");
    await driveSend(q, "t1", item({ id: "a" }), send);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(item({ id: "a" }));
    expect(q.isInFlight("t1")).toBe(false); // settled, no longer in flight
  });

  it("marks the thread in-flight for the duration of send()", async () => {
    const q = new SendQueue();
    let sawInFlightDuringSend = false;
    const send = vi.fn(async (): Promise<SendOutcome> => {
      sawInFlightDuringSend = q.isInFlight("t1");
      return "sent";
    });
    await driveSend(q, "t1", item(), send);
    expect(sawInFlightDuringSend).toBe(true);
    expect(q.isInFlight("t1")).toBe(false);
  });

  it("sequential drain: on success, keeps popping and dispatching one at a time until the queue is empty", async () => {
    const q = new SendQueue();
    q.enqueue(item({ id: "b", text: "second" }));
    q.enqueue(item({ id: "c", text: "third" }));
    const seen: string[] = [];
    const concurrentAtPeak: boolean[] = [];
    const send = vi.fn(async (i: QueuedTurn): Promise<SendOutcome> => {
      seen.push(i.id);
      concurrentAtPeak.push(q.isInFlight(i.threadId));
      return "sent";
    });
    await driveSend(q, "t1", item({ id: "a", text: "first" }), send);
    expect(seen).toEqual(["a", "b", "c"]); // FIFO order, one after another
    expect(send).toHaveBeenCalledTimes(3);
    expect(q.list("t1")).toEqual([]); // fully drained
    expect(q.isInFlight("t1")).toBe(false);
  });

  it("never dispatches two items concurrently — each send() call sees an otherwise-empty in-flight slot", async () => {
    const q = new SendQueue();
    q.enqueue(item({ id: "b" }));
    let concurrentCalls = 0;
    let maxConcurrent = 0;
    const send = vi.fn(async (): Promise<SendOutcome> => {
      concurrentCalls++;
      maxConcurrent = Math.max(maxConcurrent, concurrentCalls);
      await Promise.resolve(); // yield, so a real race would show up here
      concurrentCalls--;
      return "sent";
    });
    await driveSend(q, "t1", item({ id: "a" }), send);
    expect(maxConcurrent).toBe(1);
  });

  it("failure HALTS the remaining queue: no further sends, remaining items stay queued untouched", async () => {
    const q = new SendQueue();
    q.enqueue(item({ id: "b", text: "second" }));
    q.enqueue(item({ id: "c", text: "third" }));
    const send = vi.fn(async (i: QueuedTurn): Promise<SendOutcome> => (i.id === "a" ? "failed" : "sent"));
    await driveSend(q, "t1", item({ id: "a", text: "first" }), send);
    expect(send).toHaveBeenCalledTimes(1); // b and c were never attempted
    expect(q.list("t1").map((i) => i.id)).toEqual(["b", "c"]); // left exactly as they were
    expect(q.isInFlight("t1")).toBe(false); // not stuck "busy" — a fresh send can go out
  });

  it("a stopped (cancelled) turn also halts draining, same as a failure", async () => {
    const q = new SendQueue();
    q.enqueue(item({ id: "b" }));
    const send = vi.fn(async (): Promise<SendOutcome> => "stopped");
    await driveSend(q, "t1", item({ id: "a" }), send);
    expect(send).toHaveBeenCalledTimes(1);
    expect(q.list("t1").map((i) => i.id)).toEqual(["b"]);
  });

  it("✕ removal during the halted tail: removing a still-queued item after a failure works normally", async () => {
    const q = new SendQueue();
    q.enqueue(item({ id: "b" }));
    q.enqueue(item({ id: "c" }));
    const send = vi.fn(async (): Promise<SendOutcome> => "failed");
    await driveSend(q, "t1", item({ id: "a" }), send);
    expect(q.remove("t1", "b")?.id).toBe("b");
    expect(q.list("t1").map((i) => i.id)).toEqual(["c"]);
  });

  it("clears the in-flight bit even when send() throws, so the thread isn't stuck busy forever", async () => {
    const q = new SendQueue();
    const send = vi.fn(async (): Promise<SendOutcome> => {
      throw new Error("boom");
    });
    await expect(driveSend(q, "t1", item(), send)).rejects.toThrow("boom");
    expect(q.isInFlight("t1")).toBe(false);
  });

  it("wrong-thread isolation: draining thread A never dispatches or drains thread B's queue", async () => {
    const q = new SendQueue();
    q.enqueue(item({ id: "b-1", threadId: "B", text: "b queued" }));
    const sentIds: string[] = [];
    const send = vi.fn(async (i: QueuedTurn): Promise<SendOutcome> => {
      sentIds.push(i.id);
      return "sent";
    });
    await driveSend(q, "A", item({ id: "a-1", threadId: "A" }), send);
    expect(sentIds).toEqual(["a-1"]); // B's queued item was never touched
    expect(q.list("B").map((i) => i.id)).toEqual(["b-1"]);
    expect(q.isInFlight("B")).toBe(false);
  });

  it("enqueue-while-busy: a caller can enqueue behind an item currently mid-send, and it drains once that settles", async () => {
    const q = new SendQueue();
    let resolveFirst!: (o: SendOutcome) => void;
    const firstSendPromise = new Promise<SendOutcome>((resolve) => (resolveFirst = resolve));
    const send = vi.fn((i: QueuedTurn): Promise<SendOutcome> => (i.id === "a" ? firstSendPromise : Promise.resolve("sent")));
    const drivePromise = driveSend(q, "t1", item({ id: "a" }), send);
    // While "a" is still in flight, a new message arrives and — per the caller's
    // busy check (isInFlight) — gets enqueued rather than dispatched directly.
    expect(q.isInFlight("t1")).toBe(true);
    q.enqueue(item({ id: "b", text: "typed while busy" }));
    resolveFirst("sent");
    await drivePromise;
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1][0].id).toBe("b");
    expect(q.list("t1")).toEqual([]);
  });
});
