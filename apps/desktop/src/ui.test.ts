import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  el,
  wireModal,
  reportError,
  runStreamingTurn,
  escapeHtml,
  proposalActions,
  alreadyResolvedStatus,
  type ProposalActionDeps,
} from "./ui.js";

// This desktop package's vitest setup has no DOM environment (no jsdom/happy-dom
// dependency — see the other *.test.ts files, which test main.ts by reading its
// source as text rather than executing it against a real DOM). el()/wireModal()
// genuinely need to create + inspect elements at runtime, so this file installs a
// minimal hand-rolled `document` stub for the duration of its own tests and tears
// it down afterward so it can't leak into other test files.

class FakeTextNode {
  constructor(public textContent: string) {}
}

class FakeElement {
  tagName: string;
  className = "";
  textContent = "";
  title = "";
  hidden = false;
  children: (FakeElement | FakeTextNode)[] = [];
  private listeners = new Map<string, ((e: unknown) => void)[]>();
  [key: string]: unknown;

  constructor(tag: string) {
    this.tagName = tag.toUpperCase();
  }

  appendChild<T extends FakeElement | FakeTextNode>(node: T): T {
    this.children.push(node);
    return node;
  }

  addEventListener(type: string, handler: (e: unknown) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(handler);
    this.listeners.set(type, list);
  }

  dispatch(type: string, event: unknown): void {
    for (const handler of this.listeners.get(type) ?? []) handler(event);
  }
}

function installFakeDocument(): void {
  (globalThis as unknown as { document: unknown }).document = {
    createElement: (tag: string) => new FakeElement(tag),
    createTextNode: (text: string) => new FakeTextNode(text),
  };
}

function removeFakeDocument(): void {
  delete (globalThis as unknown as { document?: unknown }).document;
}

describe("el", () => {
  beforeEach(installFakeDocument);
  afterEach(removeFakeDocument);

  it("creates the tag and assigns className/textContent/title", () => {
    const node = el("div", { className: "foo", textContent: "hi", title: "t" });
    const fake = node as unknown as FakeElement;
    expect(fake.tagName).toBe("DIV");
    expect(fake.className).toBe("foo");
    expect(fake.textContent).toBe("hi");
    expect(fake.title).toBe("t");
  });

  it("assigns arbitrary extra props as plain properties, skipping undefined ones", () => {
    const node = el("button", { type: "button", disabled: true, style: undefined });
    const fake = node as unknown as FakeElement;
    expect(fake.type).toBe("button");
    expect(fake.disabled).toBe(true);
    expect("style" in fake).toBe(false);
  });

  it("appends string children as text nodes and element children as-is, in order", () => {
    const child = el("span");
    const node = el("div", undefined, ["hello", child]);
    const fake = node as unknown as FakeElement;
    expect(fake.children).toHaveLength(2);
    expect((fake.children[0] as FakeTextNode).textContent).toBe("hello");
    expect(fake.children[1]).toBe(child as unknown as FakeElement);
  });

  it("works with no props and no children", () => {
    const node = el("div");
    const fake = node as unknown as FakeElement;
    expect(fake.tagName).toBe("DIV");
    expect(fake.children).toHaveLength(0);
  });
});

describe("wireModal", () => {
  it("hides the modal on a backdrop click (click target is the modal itself)", () => {
    const modal = new FakeElement("div") as unknown as HTMLElement;
    wireModal(modal);
    (modal as unknown as FakeElement).dispatch("click", { target: modal });
    expect(modal.hidden).toBe(true);
  });

  it("leaves the modal open when the click target is a descendant", () => {
    const modal = new FakeElement("div") as unknown as HTMLElement;
    const inner = new FakeElement("div");
    wireModal(modal);
    (modal as unknown as FakeElement).dispatch("click", { target: inner });
    expect(modal.hidden).toBe(false);
  });
});

describe("runStreamingTurn", () => {
  it("awaits onSuccess before onSettled fires (chatSend's busy-window fix)", async () => {
    const order: string[] = [];
    const outcome = await runStreamingTurn({
      run: async () => "result",
      onSuccess: async (result) => {
        order.push(`onSuccess-start:${result}`);
        await Promise.resolve();
        order.push("onSuccess-end");
      },
      onError: () => order.push("onError"),
      onSettled: () => order.push("onSettled"),
    });
    expect(order).toEqual(["onSuccess-start:result", "onSuccess-end", "onSettled"]);
    expect(outcome).toEqual({ ok: true, result: "result" });
  });

  it("routes an onSuccess failure to onError (matching the pre-refactor single try block), and still settles", async () => {
    const order: string[] = [];
    const boom = new Error("reload failed");
    const outcome = await runStreamingTurn({
      run: async () => "result",
      onSuccess: async () => {
        throw boom;
      },
      onError: (e) => order.push(`onError:${String(e === boom ? "boom" : e)}`),
      onSettled: () => order.push("onSettled"),
    });
    expect(order).toEqual(["onError:boom", "onSettled"]);
    expect(outcome).toEqual({ ok: false });
  });

  it("without onSuccess, behaves exactly as before: settles after run(), returns {ok:true,result}", async () => {
    const order: string[] = [];
    const outcome = await runStreamingTurn({
      run: async () => 42,
      onError: () => order.push("onError"),
      onSettled: () => order.push("onSettled"),
    });
    expect(order).toEqual(["onSettled"]);
    expect(outcome).toEqual({ ok: true, result: 42 });
  });

  it("calls onError (not onSuccess) and returns {ok:false} when run() rejects", async () => {
    const order: string[] = [];
    const outcome = await runStreamingTurn({
      run: async () => {
        throw new Error("rpc failed");
      },
      onSuccess: () => {
        order.push("onSuccess");
      },
      onError: (e) => order.push(`onError:${String(e)}`),
      onSettled: () => order.push("onSettled"),
    });
    expect(order).toEqual(["onError:Error: rpc failed", "onSettled"]);
    expect(outcome).toEqual({ ok: false });
  });
});

describe("reportError", () => {
  it("formats exactly `${scope} failed: ${String(e)}` so #log output is unchanged", () => {
    const lines: string[] = [];
    reportError("save", new Error("disk full"), (line) => lines.push(line));
    expect(lines).toEqual([`save failed: ${String(new Error("disk full"))}`]);
  });

  it("stringifies non-Error values the same way String() would", () => {
    const lines: string[] = [];
    reportError("open", "boom", (line) => lines.push(line));
    expect(lines).toEqual(["open failed: boom"]);
  });
});

describe("escapeHtml", () => {
  it("escapes the five HTML-significant characters", () => {
    expect(escapeHtml(`<b>"a" & 'b'</b>`)).toBe("&lt;b&gt;&quot;a&quot; &amp; &#39;b&#39;&lt;/b&gt;");
  });

  it("leaves ordinary text untouched", () => {
    expect(escapeHtml("plain text v1.2")).toBe("plain text v1.2");
  });
});

// Root-cause chain for the "stuck approved proposal card" bug:
// orchestrator.approveProposal/rejectProposal now
// throw a distinguishable `proposal already approved`/`proposal already rejected`
// error when called on a non-pending proposal — the retry a user makes after a lost
// approve RESPONSE (connection drop/sidecar restart AFTER the server durably applied
// it) lands here instead of a confusing baseHash-staleness error. alreadyResolvedStatus
// recognizes that message; proposalActions uses it to clean up (remove the card, reload
// if approved) instead of re-enabling the buttons for another doomed retry.
describe("alreadyResolvedStatus", () => {
  it("recognizes the orchestrator's already-approved guard message", () => {
    expect(alreadyResolvedStatus(new Error("proposal already approved"))).toBe("approved");
  });

  it("recognizes the orchestrator's already-rejected guard message", () => {
    expect(alreadyResolvedStatus(new Error("proposal already rejected"))).toBe("rejected");
  });

  it("returns null for an unrelated failure (e.g. the baseHash staleness error)", () => {
    expect(
      alreadyResolvedStatus(
        new Error("the document changed since this edit was proposed — discard it and ask the agent again"),
      ),
    ).toBeNull();
  });

  it("returns null for a lost-connection error (a transient failure, not an already-resolved one)", () => {
    expect(alreadyResolvedStatus(new Error("docd connection lost — retrying in background"))).toBeNull();
  });

  it("handles non-Error thrown values the same way String() would", () => {
    expect(alreadyResolvedStatus("proposal already rejected")).toBe("rejected");
  });
});

describe("proposalActions — already-resolved click cleanup", () => {
  function fakeButton(): HTMLButtonElement {
    return { disabled: false } as unknown as HTMLButtonElement;
  }

  function setup(overrides: Partial<ProposalActionDeps> = {}) {
    const approveBtn = fakeButton();
    const rejectBtn = fakeButton();
    const log: string[] = [];
    const calls: string[] = [];
    const deps: ProposalActionDeps = {
      approveBtn,
      rejectBtn,
      approveProposal: async () => ({}),
      rejectProposal: async () => ({}),
      log: (line) => log.push(line),
      onApproved: () => {
        calls.push("onApproved");
      },
      onRejected: () => {
        calls.push("onRejected");
      },
      ...overrides,
    };
    proposalActions(deps, { threadId: "review", proposalId: "review#p1" });
    return { approveBtn, rejectBtn, log, calls };
  }

  it("on approve success, calls onApproved and leaves the (already-disabled) buttons as-is", async () => {
    const { approveBtn, calls } = setup();
    await approveBtn.onclick!({} as MouseEvent);
    expect(calls).toEqual(["onApproved"]);
    expect(approveBtn.disabled).toBe(true);
  });

  it("on an ordinary approve failure, re-enables both buttons and reports the error — no cleanup call", async () => {
    const { approveBtn, rejectBtn, log, calls } = setup({
      approveProposal: async () => {
        throw new Error("docd connection lost — retrying in background");
      },
    });
    await approveBtn.onclick!({} as MouseEvent);
    expect(calls).toEqual([]);
    expect(approveBtn.disabled).toBe(false);
    expect(rejectBtn.disabled).toBe(false);
    expect(log.some((l) => l.startsWith("approve failed:"))).toBe(true);
  });

  it("a retry approve click that hits 'proposal already approved' runs onApproved cleanup instead of re-enabling for another retry", async () => {
    const { approveBtn, log, calls } = setup({
      approveProposal: async () => {
        throw new Error("proposal already approved");
      },
    });
    await approveBtn.onclick!({} as MouseEvent);
    expect(calls).toEqual(["onApproved"]);
    expect(approveBtn.disabled).toBe(true); // NOT re-enabled: the card is being torn down, not retried
    expect(log.some((l) => l.includes("already approved"))).toBe(true);
  });

  it("an approve click that hits 'proposal already rejected' runs onRejected cleanup — the server's real status wins over which button was clicked", async () => {
    const { approveBtn, calls } = setup({
      approveProposal: async () => {
        throw new Error("proposal already rejected");
      },
    });
    await approveBtn.onclick!({} as MouseEvent);
    expect(calls).toEqual(["onRejected"]);
  });

  it("a retry reject click that hits 'proposal already rejected' runs onRejected cleanup instead of re-enabling for another retry", async () => {
    const { rejectBtn, log, calls } = setup({
      rejectProposal: async () => {
        throw new Error("proposal already rejected");
      },
    });
    await rejectBtn.onclick!({} as MouseEvent);
    expect(calls).toEqual(["onRejected"]);
    expect(rejectBtn.disabled).toBe(true);
    expect(log.some((l) => l.includes("already rejected"))).toBe(true);
  });

  it("a reject click that hits 'proposal already approved' runs onApproved cleanup — the server's real status wins over which button was clicked", async () => {
    const { rejectBtn, calls } = setup({
      rejectProposal: async () => {
        throw new Error("proposal already approved");
      },
    });
    await rejectBtn.onclick!({} as MouseEvent);
    expect(calls).toEqual(["onApproved"]);
  });
});
