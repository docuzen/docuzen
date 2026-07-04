import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { connect, LOST_CONNECTION_MESSAGE, type MinimalWebSocket } from "./rpc.js";

// This desktop package's vitest setup has no DOM environment (no jsdom/happy-dom
// dependency — see ui.test.ts's file header), so `location` (which rpc.ts's
// docdPort() reads via `location.search`) isn't a global here the way it is in a
// browser or in `tauri dev`. Stub the minimum for the duration of this file only.
class FakeWebSocket implements MinimalWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  sent: string[] = [];
  private openListeners: Array<() => void> = [];
  private closeListeners: Array<() => void> = [];
  private errorListeners: Array<() => void> = [];
  private messageListeners: Array<(ev: { data: unknown }) => void> = [];

  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: "open", listener: () => void): void;
  addEventListener(type: "close", listener: () => void): void;
  addEventListener(type: "error", listener: () => void): void;
  addEventListener(type: "message", listener: (ev: { data: unknown }) => void): void;
  addEventListener(type: string, listener: (...args: never[]) => void): void {
    if (type === "open") this.openListeners.push(listener as () => void);
    else if (type === "close") this.closeListeners.push(listener as () => void);
    else if (type === "error") this.errorListeners.push(listener as () => void);
    else if (type === "message") this.messageListeners.push(listener as (ev: { data: unknown }) => void);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
    for (const l of this.closeListeners) l();
  }

  // --- test-only triggers, standing in for the real socket's network events ---

  triggerOpen(): void {
    this.readyState = FakeWebSocket.OPEN;
    for (const l of this.openListeners) l();
  }

  triggerClose(): void {
    this.readyState = FakeWebSocket.CLOSED;
    for (const l of this.closeListeners) l();
  }

  triggerError(): void {
    for (const l of this.errorListeners) l();
  }

  triggerMessage(msg: unknown): void {
    for (const l of this.messageListeners) l({ data: JSON.stringify(msg) });
  }
}

function makeClient(onStatus?: (s: string) => void) {
  FakeWebSocket.instances = [];
  return connect(onStatus, (url) => new FakeWebSocket(url));
}

function latest(): FakeWebSocket {
  return FakeWebSocket.instances[FakeWebSocket.instances.length - 1]!;
}

beforeEach(() => {
  (globalThis as unknown as { location: { search: string } }).location = { search: "" };
  vi.useFakeTimers();
});

afterEach(() => {
  delete (globalThis as unknown as { location?: unknown }).location;
  vi.useRealTimers();
});

describe("rpc reconnect", () => {
  it("resolves a call sent once the socket is open", async () => {
    const client = makeClient();
    latest().triggerOpen();

    const promise = client.call("listVersions", {});
    latest().triggerMessage({ id: "f1", ok: true, result: { versions: [] } });

    await expect(promise).resolves.toEqual({ versions: [] });
  });

  it("rejects an in-flight call with the connection-lost message when the socket dies", async () => {
    const client = makeClient();
    latest().triggerOpen();

    const promise = client.call("listVersions", {});
    expect(latest().sent).toHaveLength(1); // sent immediately — socket was open
    latest().triggerClose();

    await expect(promise).rejects.toThrow(LOST_CONNECTION_MESSAGE);
  });

  it("queues a call issued while disconnected and resolves it once a reconnect flushes it", async () => {
    const client = makeClient();
    latest().triggerOpen();
    latest().triggerClose(); // socket #1 dies; reconnect scheduled after 500ms

    const promise = client.call("listVersions", {}); // issued while disconnected — queued, not rejected
    expect(latest().sent).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(500); // reconnect fires; socket #2 created
    expect(FakeWebSocket.instances).toHaveLength(2);
    latest().triggerOpen(); // flushes the queue onto socket #2
    expect(latest().sent).toHaveLength(1);

    latest().triggerMessage({ id: "f1", ok: true, result: "ok" });
    await expect(promise).resolves.toBe("ok");
  });

  it("rejects a queued call that waits longer than the 10s grace period with no reconnect", async () => {
    const client = makeClient();
    // Socket never opens — every call issued right now goes straight to the queue.
    const promise = client.call("listVersions", {});
    expect(latest().sent).toHaveLength(0);
    // Attach the rejection handler before advancing time past the grace deadline — the
    // timer fires mid-`advanceTimersByTimeAsync`, and an unattached handler at that point
    // trips vitest's unhandled-rejection detector even though this line awaits it moments
    // later.
    const rejection = expect(promise).rejects.toThrow(LOST_CONNECTION_MESSAGE);

    await vi.advanceTimersByTimeAsync(9_999);
    await vi.advanceTimersByTimeAsync(1); // crosses the 10s grace line

    await rejection;
  });

  it("rejects a streaming call (onEvent) mid-stream the same way as a plain call", async () => {
    const client = makeClient();
    latest().triggerOpen();

    const onEvent = vi.fn();
    const promise = client.call("improve", {}, onEvent);
    latest().triggerMessage({ id: "f1", event: "token", data: "partial " });
    expect(onEvent).toHaveBeenCalledWith({ event: "token", data: "partial ", model: undefined });

    latest().triggerClose(); // dies mid-stream, before the final response frame

    await expect(promise).rejects.toThrow(LOST_CONNECTION_MESSAGE);
  });

  it("follows the 500ms -> x2 -> 5s cap backoff schedule, forever", async () => {
    const client = makeClient();
    void client;

    const delays: number[] = [];
    async function killAndMeasureNextAttempt(expectedDelayMs: number): Promise<void> {
      const before = FakeWebSocket.instances.length;
      latest().triggerClose();
      await vi.advanceTimersByTimeAsync(expectedDelayMs - 1);
      expect(FakeWebSocket.instances.length).toBe(before); // not yet — delay hasn't elapsed
      await vi.advanceTimersByTimeAsync(1);
      expect(FakeWebSocket.instances.length).toBe(before + 1); // reconnect attempt fired
      delays.push(expectedDelayMs);
    }

    latest().triggerOpen(); // socket #1: connects, then dies repeatedly below
    await killAndMeasureNextAttempt(500); // -> socket #2
    await killAndMeasureNextAttempt(1000); // -> socket #3
    await killAndMeasureNextAttempt(2000); // -> socket #4
    await killAndMeasureNextAttempt(4000); // -> socket #5
    await killAndMeasureNextAttempt(5000); // capped at 5s -> socket #6
    await killAndMeasureNextAttempt(5000); // stays capped, forever -> socket #7

    expect(delays).toEqual([500, 1000, 2000, 4000, 5000, 5000]);
  });

  it("emits the connected / reconnecting(attempt N) / disconnected status sequence", async () => {
    const statuses: string[] = [];
    makeClient((s) => statuses.push(s));

    latest().triggerOpen();
    latest().triggerClose();
    await vi.advanceTimersByTimeAsync(500);
    latest().triggerOpen();

    expect(statuses).toEqual(["connected", "disconnected", "reconnecting (attempt 1)", "connected"]);
  });

  it("resets the attempt counter and backoff after a successful reconnect", async () => {
    const statuses: string[] = [];
    makeClient((s) => statuses.push(s));

    latest().triggerOpen();
    latest().triggerClose(); // attempt 1 scheduled (500ms), backoff now 1000ms for next time
    await vi.advanceTimersByTimeAsync(500);
    latest().triggerOpen(); // reconnect succeeds — counter/backoff reset to attempt 0 / 500ms

    latest().triggerClose(); // status fires synchronously: should be "attempt 1" again, not "attempt 2"
    expect(statuses.slice(-2)).toEqual(["disconnected", "reconnecting (attempt 1)"]);

    // Prove backoff actually reset (not stuck at the doubled 1000ms it would be without reset):
    // the next socket must appear at 500ms, not 1000ms.
    await vi.advanceTimersByTimeAsync(499);
    expect(FakeWebSocket.instances).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeWebSocket.instances).toHaveLength(3);
  });

  it("does not double-schedule when both error and close fire for the same death", async () => {
    const statuses: string[] = [];
    makeClient((s) => statuses.push(s));

    latest().triggerOpen();
    latest().triggerError();
    latest().triggerClose(); // real sockets often fire both — must not double-advance

    expect(statuses.filter((s) => s === "disconnected")).toHaveLength(1);
    expect(statuses.filter((s) => s.startsWith("reconnecting"))).toEqual(["reconnecting (attempt 1)"]);
  });

  it("close() stops reconnecting and rejects in-flight and queued calls", async () => {
    const client = makeClient();
    latest().triggerOpen();

    const inFlight = client.call("listVersions", {});
    latest().triggerClose();
    await expect(inFlight).rejects.toThrow(LOST_CONNECTION_MESSAGE);

    const queued = client.call("listVersions", {}); // issued while disconnected, before we call close()
    client.close();
    await expect(queued).rejects.toThrow(LOST_CONNECTION_MESSAGE);

    const countBeforeWait = FakeWebSocket.instances.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(FakeWebSocket.instances.length).toBe(countBeforeWait); // no further reconnect attempts
  });
});
