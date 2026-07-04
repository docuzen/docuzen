/**
 * Shared session-id bookkeeping for the three AgentRunners (pi, codex, fake). All three
 * assigned each session a monotonically increasing, runner-prefixed id — `pi-1`,
 * `codex-1`, `fake-1`, ... — via their own private `counter` field and an inline
 * `` `${prefix}-${++this.counter}` `` template. This factors that one duplicated idiom
 * into a single place.
 *
 * Deliberately NOT unified further: PiRunner's `sessions`/`byKey` maps, CodexRunner's
 * `live` map (keyed by `cancelKey`, not the generated session id, and not always set),
 * and FakePiRunner's session store all have different key domains or value shapes.
 * Forcing them into one generic map-of-everything would be dedup for its own sake and
 * risks behavior drift for no readability gain.
 */
export class SessionCounter {
  private n = 0;

  constructor(private readonly prefix: string) {}

  /** Returns the next id in the sequence: `${prefix}-1`, `${prefix}-2`, ... */
  next(): string {
    return `${this.prefix}-${++this.n}`;
  }
}

/**
 * A session store keyed by ids from a SessionCounter: `start()` allocates the next id,
 * stores `value` under it, and returns the id in one call. Matches the shape shared by
 * PiRunner's `sessions` map (id `pi-N`) and FakePiRunner's session store (id `fake-N`),
 * both of which key their bookkeeping by the generated session id.
 */
export class SessionStore<V> {
  private readonly counter: SessionCounter;
  private readonly map = new Map<string, V>();

  constructor(prefix: string) {
    this.counter = new SessionCounter(prefix);
  }

  /** Allocates the next id, stores `value` under it, and returns the id. */
  start(value: V): string {
    const id = this.counter.next();
    this.map.set(id, value);
    return id;
  }

  get(id: string): V | undefined {
    return this.map.get(id);
  }

  has(id: string): boolean {
    return this.map.has(id);
  }
}
