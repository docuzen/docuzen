import { describe, expect, it } from "vitest";
import { SessionCounter, SessionStore } from "../../src/agent/runner-base.js";

describe("SessionCounter", () => {
  it("produces prefixed, monotonically increasing ids starting at 1", () => {
    const c = new SessionCounter("pi");
    expect(c.next()).toBe("pi-1");
    expect(c.next()).toBe("pi-2");
    expect(c.next()).toBe("pi-3");
  });

  it("keeps a separate counter per instance", () => {
    const a = new SessionCounter("codex");
    const b = new SessionCounter("codex");
    expect(a.next()).toBe("codex-1");
    expect(b.next()).toBe("codex-1");
    expect(a.next()).toBe("codex-2");
  });
});

describe("SessionStore", () => {
  it("start() allocates the next id, stores the value, and returns the id", () => {
    const store = new SessionStore<{ n: number }>("fake");
    const id1 = store.start({ n: 1 });
    const id2 = store.start({ n: 2 });
    expect(id1).toBe("fake-1");
    expect(id2).toBe("fake-2");
    expect(store.get(id1)).toEqual({ n: 1 });
    expect(store.get(id2)).toEqual({ n: 2 });
  });

  it("has() reflects whether an id was started", () => {
    const store = new SessionStore<string>("pi");
    const id = store.start("entry");
    expect(store.has(id)).toBe(true);
    expect(store.has("pi-999")).toBe(false);
  });

  it("get() returns undefined for an unknown id", () => {
    const store = new SessionStore<string>("pi");
    expect(store.get("pi-1")).toBeUndefined();
  });
});
