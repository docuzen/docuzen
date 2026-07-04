import { describe, it, expect, vi } from "vitest";
import { makeApi, createSessionStore, type SessionStoreDelegate } from "./session.js";

describe("makeApi", () => {
  it("injects the active docPath and forwards method/params/onEvent", async () => {
    const call = vi.fn().mockResolvedValue({ versions: [] });
    const api = makeApi({ call }, () => "/tmp/doc.md");
    const onEvent = () => {};
    await api.listVersions({}, onEvent);
    expect(call).toHaveBeenCalledWith("listVersions", { docPath: "/tmp/doc.md" }, onEvent);
  });

  it("lets explicit docPath win (openDoc before a doc is active)", async () => {
    const call = vi.fn().mockResolvedValue({});
    const api = makeApi({ call }, () => undefined);
    await api.openDoc({ docPath: "/tmp/other.md" });
    expect(call).toHaveBeenCalledWith("openDoc", { docPath: "/tmp/other.md" }, undefined);
  });
});

describe("createSessionStore", () => {
  // A fake main.ts: DOC_PATH/currentFormat as plain mutable bindings, exposed to
  // the store only through get/set closures — exactly the wave-1 delegation shape
  // (globals stay owned by main.ts; the store never copies their value).
  function fakeMainModule(initial?: { docPath?: string; format?: "markdown" | "html" }) {
    let DOC_PATH = initial?.docPath;
    let currentFormat: "markdown" | "html" = initial?.format ?? "markdown";
    const delegate: SessionStoreDelegate = {
      getDocPath: () => DOC_PATH,
      getFormat: () => currentFormat,
      setDocPath: (p) => {
        DOC_PATH = p;
      },
      setFormat: (f) => {
        currentFormat = f;
      },
    };
    return {
      delegate,
      setDocPathDirectly: (p: string) => {
        DOC_PATH = p;
      },
      setFormatDirectly: (f: "markdown" | "html") => {
        currentFormat = f;
      },
    };
  }

  it("active() is undefined when no doc path is set (delegate reports undefined)", () => {
    const { delegate } = fakeMainModule();
    const store = createSessionStore({ call: vi.fn() }, delegate);
    expect(store.active()).toBeUndefined();
  });

  it("active() delegates docPath/format to the injected getters — no copied state", () => {
    const { delegate, setDocPathDirectly, setFormatDirectly } = fakeMainModule({
      docPath: "/tmp/a.md",
      format: "markdown",
    });
    const store = createSessionStore({ call: vi.fn() }, delegate);
    const session = store.active();
    expect(session?.docPath).toBe("/tmp/a.md");
    expect(session?.format).toBe("markdown");

    // Mutate the underlying "global" directly (not through setActive). The SAME
    // DocSession object must reflect the new value — proof it reads live through
    // the delegate rather than snapshotting at active()-call time.
    setDocPathDirectly("/tmp/b.md");
    setFormatDirectly("html");
    expect(session?.docPath).toBe("/tmp/b.md");
    expect(session?.format).toBe("html");
  });

  it("api is getter-bound to the delegate's live docPath, same as makeApi", async () => {
    const call = vi.fn().mockResolvedValue({});
    const { delegate, setDocPathDirectly } = fakeMainModule({ docPath: "/tmp/a.md" });
    const store = createSessionStore({ call }, delegate);
    await store.api.saveDoc({ text: "x" });
    expect(call).toHaveBeenCalledWith("saveDoc", { docPath: "/tmp/a.md", text: "x" }, undefined);

    setDocPathDirectly("/tmp/b.md");
    await store.api.saveDoc({ text: "y" });
    expect(call).toHaveBeenCalledWith("saveDoc", { docPath: "/tmp/b.md", text: "y" }, undefined);
  });

  it("setActive writes through the injected setters and fires onChange listeners", () => {
    const { delegate } = fakeMainModule();
    const store = createSessionStore({ call: vi.fn() }, delegate);
    const listener = vi.fn();
    store.onChange(listener);

    store.setActive("/tmp/c.md", "html");

    expect(delegate.getDocPath()).toBe("/tmp/c.md");
    expect(delegate.getFormat()).toBe("html");
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.active()?.docPath).toBe("/tmp/c.md");
    expect(store.active()?.format).toBe("html");
  });

  it("onChange returns an unsubscribe function that stops further notifications", () => {
    const { delegate } = fakeMainModule();
    const store = createSessionStore({ call: vi.fn() }, delegate);
    const listener = vi.fn();
    const unsubscribe = store.onChange(listener);
    unsubscribe();

    store.setActive("/tmp/d.md", "markdown");

    expect(listener).not.toHaveBeenCalled();
  });

  it("a DocSession's own onChange fires on setActive too (same event stream as the store)", () => {
    const { delegate } = fakeMainModule({ docPath: "/tmp/a.md" });
    const store = createSessionStore({ call: vi.fn() }, delegate);
    const session = store.active()!;
    const listener = vi.fn();
    session.onChange(listener);

    store.setActive("/tmp/a.md", "html");

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("multiple listeners are all notified, independently unsubscribable", () => {
    const { delegate } = fakeMainModule();
    const store = createSessionStore({ call: vi.fn() }, delegate);
    const a = vi.fn();
    const b = vi.fn();
    store.onChange(a);
    const unsubscribeB = store.onChange(b);

    store.setActive("/tmp/e.md", "markdown");
    unsubscribeB();
    store.setActive("/tmp/f.md", "html");

    expect(a).toHaveBeenCalledTimes(2);
    expect(b).toHaveBeenCalledTimes(1);
  });
});
