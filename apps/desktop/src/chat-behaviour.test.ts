// @vitest-environment happy-dom
//
// Behavioural tests for the chat region, against index.html's real markup and a scripted
// sidecar API. The older chat tests assert on chat.ts's source TEXT; these drive the
// actual UI (click the card's Ask-agent button, type in the footer, press Stop) and check
// what the user would see and which RPCs go out. They are the safety net for moving code
// between modules: a text test breaks when a function moves, these only break when
// behaviour changes.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { initChat, type ChatApi, type ChatDeps } from "./chat.js";

const here = dirname(fileURLToPath(import.meta.url));
const bodyHtml = /<body[^>]*>([\s\S]*)<\/body>/.exec(readFileSync(resolve(here, "..", "index.html"), "utf8"))![1];

type Emit = (e: { event: string; data: unknown; model?: string }) => void;
interface Call {
  params: Record<string, unknown>;
  emit: Emit;
  resolve: (v?: unknown) => void;
  reject: (e: Error) => void;
}

/** A sidecar stand-in: streaming methods park until the test settles them; reads are instant. */
function fakeApi() {
  const calls: Record<string, Call[]> = {};
  const threads: Record<string, { frontmatter: Record<string, unknown>; turns: { role: string; body: string; meta?: string }[] }> = {};
  const parked = (method: string, dflt: unknown = { ok: true }) =>
    vi.fn((params: Record<string, unknown>, emit?: Emit) =>
      new Promise((res, rej) => {
        (calls[method] ??= []).push({ params, emit: emit ?? (() => {}), resolve: (v) => res(v ?? dflt), reject: rej });
      }),
    );
  const api = {
    discuss: parked("discuss"),
    reply: parked("reply"),
    panel: parked("panel"),
    improve: parked("improve"),
    reviewDocument: parked("reviewDocument"),
    resolveDirectives: parked("resolveDirectives"),
    cancelTurn: vi.fn(async () => ({ ok: true })),
    approveProposal: vi.fn(async () => ({ ok: true })),
    saveComment: vi.fn(async () => ({ ok: true })),
    resolveComment: vi.fn(async () => ({ ok: true })),
    listThreads: vi.fn(async () => []),
    listTasks: vi.fn(async () => [] as unknown[]),
    listModels: vi.fn(async () => [{ key: "p/m1", name: "Model One", provider: "p", modelId: "m1", hasKey: true }]),
    getThread: vi.fn(async ({ threadId }: { threadId: string }) => {
      const t = threads[threadId];
      if (!t) throw new Error("ENOENT: no such file");
      return t;
    }),
  };
  return { api, calls, threads };
}

function setup() {
  const sidecar = fakeApi();
  const log: string[] = [];
  const explicit: Record<string, unknown> = {
    api: sidecar.api,
    log: (l: string) => void log.push(l),
    getDocPath: () => "/d/plan.md",
    getFormat: () => "markdown",
    getHtmlSurface: () => null,
    renderPreviewText: (into: HTMLElement, text: string) => {
      into.dataset.rawText = text;
      into.textContent = text;
    },
    rawPreviewText: (from: HTMLElement) => from.dataset.rawText ?? from.textContent ?? "",
    routeProposal: vi.fn((e: { event: string }) => e.event === "proposal" || e.event === "applied"),
    reloadActiveDoc: vi.fn(async () => {}),
    syncDocToDisk: vi.fn(async () => {}),
    truncTitle: (s: string) => s,
  };
  const deps = new Proxy(explicit, {
    get: (target, prop: string) => (prop in target ? target[prop] : (target[prop] = vi.fn())),
  }) as unknown as ChatDeps;
  const chat: ChatApi = initChat(deps);
  return { chat, deps: explicit, log, ...sidecar };
}

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const $$ = <T extends HTMLElement = HTMLElement>(sel: string) => [...document.querySelectorAll<T>(sel)];
/** Let queued microtasks and already-resolved promises run. */
const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
};
const turnsText = () => $$("#chatTurns .turn").map((t) => `${[...t.classList].find((c) => c.startsWith("turn-"))}:${t.querySelector(".tbody")?.textContent ?? ""}`);

function addCard(chat: ChatApi, id: string, quoted = `quote ${id}`) {
  chat.addCommentCard(id, quoted, "", 1, "reviewer");
  // Cards are prepended to the rail, so look the new one up by id rather than by position.
  const card = document.querySelector<HTMLElement>(`#comments .comment-card[data-anno="${id}"]`)!;
  return {
    card,
    input: card.querySelector<HTMLTextAreaElement>(".cinput")!,
    ask: card.querySelector<HTMLButtonElement>(".discuss")!,
    chip: card.querySelector<HTMLSpanElement>(".chip")!,
  };
}
function footerSend(text: string) {
  $<HTMLTextAreaElement>("#chatInput").value = text;
  $<HTMLButtonElement>("#chatSend").click();
}

beforeEach(() => {
  document.body.innerHTML = bodyHtml;
});

describe("document load", () => {
  it("fetches the thread tree once for a burst of comment cards, not once per card", async () => {
    const { chat, api } = setup();
    for (let i = 1; i <= 8; i++) addCard(chat, `c000${i}`);
    await settle();
    expect(api.listThreads).toHaveBeenCalledTimes(1);
    expect($$("#comments .comment-card")).toHaveLength(8);
  });
});

describe("review rail cards", () => {
  const node = (id: string, extra: Record<string, unknown> = {}) => ({
    id, anchorExact: "q", title: "t", turnCount: 2, hasAgentTurn: false, status: "open", createdAt: "2026-01-01", ...extra,
  });

  it("restores every card's persisted state from ONE thread listing — no per-card thread fetch", async () => {
    const { chat, api } = setup();
    api.listThreads.mockResolvedValue([
      node("c0001", { hasAgentTurn: true, status: "responded", lastYouBody: "first ask" }),
      node("c0002", { status: "error", lastYouBody: "the message that failed" }),
    ] as never);
    const discussed = addCard(chat, "c0001");
    const failed = addCard(chat, "c0002");
    const fresh = addCard(chat, "c0003");
    await settle();

    expect(api.listThreads).toHaveBeenCalledTimes(1);
    expect(api.getThread).not.toHaveBeenCalled();
    // Already discussed: nothing more to "Ask" from the card.
    expect(discussed.chip.textContent).toBe("responded");
    expect(discussed.ask.disabled).toBe(true);
    // A failed turn stays actionable, with the failed message put back for resending.
    expect(failed.chip.textContent).toBe("error");
    expect(failed.ask.textContent).toBe("Retry");
    expect(failed.ask.disabled).toBe(false);
    expect(failed.input.value).toBe("the message that failed");
    // Never discussed: untouched.
    expect(fresh.ask.textContent).toBe("Ask agent");
    expect(fresh.chip.classList.contains("idle")).toBe(true);
  });

  it("a later listing never overrides the state of a turn running in this session", async () => {
    const { chat, api } = setup();
    const c = addCard(chat, "c0001");
    await settle();
    c.input.value = "q";
    c.ask.click();
    await settle();
    expect(c.chip.textContent).toBe("running");

    api.listThreads.mockResolvedValue([node("c0001", { status: "error", lastYouBody: "stale" })] as never);
    await chat.refreshThreadTree();
    expect(c.chip.textContent).toBe("running");
  });

  it("clicking a card (not its controls) opens its thread in the chat pane", async () => {
    const { chat, threads } = setup();
    const c = addCard(chat, "c0001", "the quote");
    threads.c0001 = { frontmatter: {}, turns: [{ role: "you", body: "q" }, { role: "agent", body: "a" }] };
    c.input.click(); // a control: must not hijack focus into the pane
    await settle();
    expect($("#chatFoot").hidden).toBe(true);

    c.card.querySelector<HTMLElement>(".quoted")!.click();
    await settle();
    expect($("#chatQuote").textContent).toContain("the quote");
    expect(turnsText()).toEqual(["turn-you:q", "turn-agent:a"]);
    expect(c.card.classList.contains("active")).toBe(true);
  });

  it("Retry on an already-discussed thread opens it and puts the last message back in the footer", async () => {
    const { chat, api, threads } = setup();
    api.listThreads.mockResolvedValue([node("c0001", { hasAgentTurn: true, status: "error", lastYouBody: "ask again" })] as never);
    const c = addCard(chat, "c0001");
    threads.c0001 = { frontmatter: { status: "error" }, turns: [{ role: "you", body: "first" }, { role: "agent", body: "a" }, { role: "you", body: "ask again" }] };
    await settle();
    expect(c.ask.textContent).toBe("Retry");

    c.ask.click();
    await settle();
    expect(api.discuss).not.toHaveBeenCalled(); // not a first message — never re-creates the thread
    expect($<HTMLTextAreaElement>("#chatInput").value).toBe("ask again");
  });

  it("the card's own stance and model picker go out with its first message", async () => {
    const { chat, calls } = setup();
    await chat.refreshThreadModels();
    const c = addCard(chat, "c0001");
    c.card.querySelector<HTMLSelectElement>(".stance")!.value = "critiquer";
    c.card.querySelector<HTMLSelectElement>(".cmodel")!.value = "p/m1";
    c.input.value = "q";
    c.ask.click();
    await settle();
    expect(calls.discuss[0].params).toMatchObject({ stance: "critiquer", modelId: "p/m1" });
    expect($("#chatTurns .turn-agent .rolename").textContent).toBe("Agent · critiquer");
  });

  it("deleting a comment removes its card and closes its open thread", async () => {
    const { chat, threads } = setup();
    addCard(chat, "c0001");
    threads.c0001 = { frontmatter: {}, turns: [{ role: "you", body: "q" }] };
    await chat.promoteToChat("c0001");
    chat.removeCommentEntry("c0001");
    expect($$("#comments .comment-card")).toHaveLength(0);
    expect(chat.hasComment("c0001")).toBe(false);
    expect($("#chatFoot").hidden).toBe(true);
    expect($$("#chatTurns .turn")).toHaveLength(0);
  });
});

describe("card → Ask agent", () => {
  it("sends discuss, streams tokens and tool activity, then shows the persisted reply", async () => {
    const { chat, api, calls, threads } = setup();
    const c = addCard(chat, "c0001", "Redis");
    c.input.value = "Why Redis?";
    c.ask.click();
    await settle();

    expect(api.discuss).toHaveBeenCalledTimes(1);
    expect(calls.discuss[0].params).toMatchObject({ threadId: "c0001", annotationId: "c0001", comment: "Why Redis?" });
    expect(c.chip.textContent).toBe("running");
    expect($<HTMLButtonElement>("#chatStop").hidden).toBe(false);

    // The bubble says what the turn is doing, moving on as the stream does.
    const phase = () => $("#chatTurns .turn-agent .spin").textContent;
    expect(phase()).toBe("waiting for the model…");
    calls.discuss[0].emit({ event: "thinking", data: "hmm" });
    expect(phase()).toBe("thinking…");
    calls.discuss[0].emit({ event: "tool", data: "read" });
    expect(phase()).toBe("using a tool…");
    calls.discuss[0].emit({ event: "token", data: "Because " });
    expect(phase()).toBe("writing…");
    calls.discuss[0].emit({ event: "token", data: "counters." });
    expect(turnsText()).toEqual(["turn-you:Why Redis?", "turn-agent:Because counters."]);
    expect($$("#chatTurns .toolline").map((l) => l.textContent)).toEqual(["Tool · read"]);

    // The persisted turn differs from the raw stream (e.g. a stripped trailing block).
    threads.c0001 = { frontmatter: {}, turns: [{ role: "you", body: "Why Redis?" }, { role: "agent", body: "Because counters. (final)" }] };
    calls.discuss[0].resolve();
    await settle();

    expect(turnsText().at(-1)).toBe("turn-agent:Because counters. (final)");
    expect(c.chip.textContent).toBe("responded");
    expect(document.querySelector("#chatTurns .turn-agent .spin")).toBeNull();
    expect($<HTMLButtonElement>("#chatStop").hidden).toBe(true);
  });

  it("a failed discuss shows the error in the bubble and offers Retry", async () => {
    const { chat, calls } = setup();
    const c = addCard(chat, "c0001");
    c.input.value = "q";
    c.ask.click();
    await settle();
    calls.discuss[0].reject(new Error("agent harness unavailable: pi"));
    await settle();

    expect($("#chatTurns .turn-agent .tbody").textContent).toContain("agent harness unavailable: pi");
    expect(c.chip.textContent).toBe("error");
    expect(c.ask.textContent).toBe("Retry");
    expect(c.ask.disabled).toBe(false);
  });
});

describe("one agent turn per thread", () => {
  it("a footer message typed while the card's Ask-agent turn is running is queued, then sent as a reply", async () => {
    const { chat, api, calls, threads } = setup();
    const c = addCard(chat, "c0001");
    c.input.value = "first";
    c.ask.click();
    await settle();

    footerSend("second");
    await settle();
    // Not dispatched: neither a second discuss (which would re-create the thread under
    // the running one) nor a reply.
    expect(api.discuss).toHaveBeenCalledTimes(1);
    expect(api.reply).not.toHaveBeenCalled();
    expect($$("#chatTurns .turn-you").at(-1)!.textContent).toContain("queued");
    expect($<HTMLTextAreaElement>("#chatInput").value).toBe("");

    threads.c0001 = { frontmatter: {}, turns: [{ role: "you", body: "first" }, { role: "agent", body: "a1" }] };
    calls.discuss[0].resolve();
    await settle();

    expect(api.reply).toHaveBeenCalledTimes(1);
    expect(calls.reply[0].params).toMatchObject({ threadId: "c0001", message: "second" });
    expect($$("#chatTurns .turn-you").at(-1)!.textContent).not.toContain("queued");
  });

  it("queued messages are sent one at a time, in order", async () => {
    const { chat, api, calls } = setup();
    const c = addCard(chat, "c0001");
    c.input.value = "first";
    c.ask.click();
    await settle();
    footerSend("two");
    footerSend("three");
    calls.discuss[0].resolve();
    await settle();
    expect(api.reply).toHaveBeenCalledTimes(1);
    expect(calls.reply[0].params.message).toBe("two");
    calls.reply[0].resolve();
    await settle();
    expect(api.reply).toHaveBeenCalledTimes(2);
    expect(calls.reply[1].params.message).toBe("three");
  });

  it("a failed turn leaves the queue alone instead of firing the next message into the failure", async () => {
    const { chat, api, calls } = setup();
    const c = addCard(chat, "c0001");
    c.input.value = "first";
    c.ask.click();
    await settle();
    footerSend("second");
    calls.discuss[0].reject(new Error("boom"));
    await settle();
    expect(api.reply).not.toHaveBeenCalled();
    expect(api.discuss).toHaveBeenCalledTimes(1);
    expect($$("#chatTurns .turn-you").at(-1)!.textContent).toContain("queued");
  });

  it("Improve is refused while a turn is running on the thread", async () => {
    const { chat, api, log } = setup();
    const c = addCard(chat, "c0001");
    c.input.value = "first";
    c.ask.click();
    await settle();
    await chat.runImprove("c0001");
    expect(api.improve).not.toHaveBeenCalled();
    expect(log.join("\n")).toContain("already has an agent turn running");
  });

  it("Stop cancels the turn and does not drain the queue behind it", async () => {
    const { chat, api, calls } = setup();
    const c = addCard(chat, "c0001");
    c.input.value = "first";
    c.ask.click();
    await settle();
    footerSend("second");

    $<HTMLButtonElement>("#chatStop").click();
    await settle();
    expect(api.cancelTurn).toHaveBeenCalledWith({ threadId: "c0001" });
    calls.discuss[0].resolve(); // a cancelled turn's RPC resolves normally
    await settle();

    expect(api.reply).not.toHaveBeenCalled();
    // ...and the stop does not poison the thread: the next send goes straight out.
    footerSend("third");
    await settle();
    expect(api.reply).toHaveBeenCalledTimes(1);
  });
});

describe("opening threads", () => {
  it("renders the persisted transcript of the opened thread", async () => {
    const { chat, threads } = setup();
    addCard(chat, "c0001");
    threads.c0001 = { frontmatter: { stance: "critiquer" }, turns: [{ role: "you", body: "q" }, { role: "agent", body: "a", meta: "critiquer" }] };
    await chat.promoteToChat("c0001");
    expect(turnsText()).toEqual(["turn-you:q", "turn-agent:a"]);
    expect($<HTMLSelectElement>("#chatStance").value).toBe("critiquer");
    expect($("#chatFoot").hidden).toBe(false);
  });

  it("a slow fetch for thread A never renders into thread B's pane", async () => {
    const { chat, api, threads } = setup();
    addCard(chat, "c0001", "quote A");
    addCard(chat, "c0002", "quote B");
    threads.c0002 = { frontmatter: {}, turns: [{ role: "you", body: "B question" }, { role: "agent", body: "B answer" }] };
    let releaseA!: () => void;
    api.getThread.mockImplementationOnce(
      () => new Promise((res) => (releaseA = () => res({ frontmatter: { stance: "supporter" }, turns: [{ role: "you", body: "A question" }, { role: "agent", body: "A answer" }] }))),
    );

    const openA = chat.promoteToChat("c0001");
    await chat.promoteToChat("c0002"); // user clicks B before A's fetch lands
    releaseA();
    await openA;
    await settle();

    expect($("#chatQuote").textContent).toContain("quote B");
    expect(turnsText()).toEqual(["turn-you:B question", "turn-agent:B answer"]);
    expect($<HTMLSelectElement>("#chatStance").value).not.toBe("supporter");
  });
});

describe("Improve", () => {
  async function improveWith(result: Record<string, unknown>) {
    const ctx = setup();
    addCard(ctx.chat, "c0001", "wordy sentence");
    ctx.threads.c0001 = { frontmatter: {}, turns: [] };
    await ctx.chat.promoteToChat("c0001");
    const done = ctx.chat.runImprove("c0001");
    await settle();
    ctx.calls.improve[0].emit({ event: "token", data: "tight " });
    ctx.calls.improve[0].emit({ event: "token", data: "sentence" });
    ctx.calls.improve[0].resolve(result);
    await done;
    return ctx;
  }

  it("Suggesting mode: shows the rewrite with an Apply button that approves the proposal", async () => {
    const { api, deps } = await improveWith({ newText: "tight sentence", proposalId: "c0001#p1" });
    const box = $("#chatTurns .proposal");
    expect(box.querySelector(".pold")!.textContent).toBe("wordy sentence");
    expect(box.querySelector(".pnew")!.textContent).toBe("tight sentence");
    const apply = box.querySelector<HTMLButtonElement>(".papply")!;
    expect(apply.disabled).toBe(false);

    apply.click();
    await settle();
    expect(api.approveProposal).toHaveBeenCalledWith({ threadId: "c0001", proposalId: "c0001#p1" });
    expect(deps.reloadActiveDoc).toHaveBeenCalled();
    expect(document.querySelector("#chatTurns .proposal")).toBeNull();
    expect($<HTMLButtonElement>("#chatImprove").disabled).toBe(false);
  });

  it("Editing mode: the rewrite is already applied — no Apply button, nothing to approve", async () => {
    const { api } = await improveWith({ newText: "tight sentence", proposalId: "c0001#p1", applied: true });
    const box = $("#chatTurns .proposal");
    expect(box.querySelector(".ptitle")!.textContent).toBe("Applied rewrite");
    expect(box.querySelector(".pnew")!.textContent).toBe("tight sentence");
    expect(box.querySelector(".papply")).toBeNull();
    expect(api.approveProposal).not.toHaveBeenCalled();
    // The footer's Improve button is usable again (it used to stay stuck on "Improving...").
    const improveBtn = $<HTMLButtonElement>("#chatImprove");
    expect(improveBtn.disabled).toBe(false);
    expect(improveBtn.textContent).toBe("Improve passage");
  });
});

describe("review pass", () => {
  it("runs the review with the chosen rubric, reports progress and the result, and reloads the doc", async () => {
    const { calls, deps } = setup();
    $<HTMLButtonElement>("#reviewDocBtn").click();
    $<HTMLTextAreaElement>("#reviewRubric").value = "find risks";
    $<HTMLButtonElement>("#reviewRun").click();
    await settle();

    expect(calls.reviewDocument[0].params).toMatchObject({ rubric: "find risks" });
    expect(deps.syncDocToDisk).toHaveBeenCalled(); // the agent must review what is on screen
    calls.reviewDocument[0].emit({ event: "finding", data: "x" });
    calls.reviewDocument[0].emit({ event: "finding", data: "y" });
    expect($("#reviewStatus").textContent).toContain("2 findings so far");

    calls.reviewDocument[0].resolve({ batchId: "b", findings: [{ annotationId: "c0001", status: "open", applied: true }, { annotationId: "c0002", status: "open" }] });
    await settle();
    expect($("#reviewStatus").textContent).toContain("2 findings added");
    expect($("#reviewStatus").textContent).toContain("1 edit applied");
    expect(deps.reloadActiveDoc).toHaveBeenCalled();
  });
});

describe("agents panel", () => {
  it("lists tasks by state and shows why a task failed", async () => {
    const { api } = setup();
    api.listTasks.mockResolvedValue([
      { threadId: "review", status: "running", piSessionId: null, updatedAt: "t3" },
      { threadId: "c0001", status: "error", piSessionId: null, updatedAt: "t2", errorText: "Error: gateway down" },
      { threadId: "c0002", status: "responded", piSessionId: "s", updatedAt: "t1" },
    ]);
    $<HTMLButtonElement>("#agentsBtn").click();
    await settle();

    const panel = $("#agentsPanel");
    expect(panel.hidden).toBe(false);
    expect($$("#agentsPanel .agentshead").map((h) => h.textContent)).toEqual(["Active", "Attention", "Recent"]);
    expect(panel.textContent).toContain("gateway down");
    expect($("#agentsBtn").textContent).toBe("Agents (1)");
    $<HTMLButtonElement>("#agentsBtn").click(); // close: stops the panel poll
    expect(panel.hidden).toBe(true);
  });
});

describe("transcript", () => {
  it("an agent turn that produced nothing names the MODEL, never the stance label", async () => {
    const { chat, calls } = setup();
    const c = addCard(chat, "c0001");
    c.input.value = "q";
    c.ask.click();
    await settle();
    calls.discuss[0].resolve(); // resolved with no tokens streamed (e.g. stopped at once)
    await settle();
    const body = $("#chatTurns .turn-agent .tbody").textContent ?? "";
    expect(body).toContain("No response from");
    expect(body).not.toContain("No response from none");
  });

  it("✎ and double-click on a persisted 'you' turn both open the edit-and-branch editor", async () => {
    const { chat, threads } = setup();
    addCard(chat, "c0001");
    threads.c0001 = { frontmatter: {}, turns: [{ role: "you", body: "original ask" }, { role: "agent", body: "a" }] };
    await chat.promoteToChat("c0001");
    const you = $("#chatTurns .turn-you");
    expect(you.classList.contains("turn-editable")).toBe(true);
    expect($$("#chatTurns .turn-agent .turnedit")).toHaveLength(0); // agent turns are not editable

    you.querySelector<HTMLButtonElement>(".turnedit")!.click();
    expect(you.querySelector<HTMLTextAreaElement>(".turnedit-box textarea")!.value).toBe("original ask");
    you.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(you.querySelectorAll(".turnedit-box")).toHaveLength(1); // re-entry does not stack a second editor
  });

  it("persisted reasoning is shown collapsed under its turn", async () => {
    const { chat } = setup();
    chat.chatTurn("agent", "the reply", "critiquer", "step one, step two");
    const turn = $("#chatTurns .turn-agent");
    expect(turn.querySelector(".trole")!.textContent).toBe("Agent · critiquer");
    expect(turn.querySelector<HTMLDetailsElement>("details.think")!.open).toBe(false);
    expect(turn.querySelector(".thinkbody")!.textContent).toBe("step one, step two");
  });
});

describe("thread tree", () => {
  const node = (id: string, extra: Record<string, unknown> = {}) => ({
    id, anchorExact: "q", title: `title ${id}`, turnCount: 2, status: "responded", createdAt: `2026-01-0${id.slice(-1)}`, ...extra,
  });

  it("shows the active thread's branch family, and a pager under the forked turn that switches branch", async () => {
    const { chat, api, threads } = setup();
    addCard(chat, "c0001", "the quote");
    chat.registerBranchEntry("c0002", "the quote", "c0001");
    api.listThreads.mockResolvedValue([node("c0001"), node("c0002", { parent: "c0001", branchFromTurn: 0, baseVersion: "v0003" })] as never);
    threads.c0001 = { frontmatter: {}, turns: [{ role: "you", body: "original ask" }, { role: "agent", body: "a" }] };
    threads.c0002 = { frontmatter: {}, turns: [{ role: "you", body: "edited ask" }, { role: "agent", body: "b" }] };
    await chat.refreshThreadTree();

    await chat.promoteToChat("c0001");
    expect($$("#threadTree .tnode").map((n) => n.dataset.thread)).toEqual(["c0001", "c0002"]);
    expect($("#threadTree .tnode.active").dataset.thread).toBe("c0001");
    expect($("#chatTurns .vp-label").textContent).toContain("1 / 2");

    $$<HTMLButtonElement>("#chatTurns .vp-arrow")[1].click(); // › next branch
    await settle();
    expect(turnsText()).toEqual(["turn-you:edited ask", "turn-agent:b"]);
    expect($("#threadTree .tnode.active").dataset.thread).toBe("c0002");
    expect($("#chatTurns .vp-label").textContent).toContain("2 / 2");
  });

  it("a lone thread shows no tree", async () => {
    const { chat, api, threads } = setup();
    addCard(chat, "c0001");
    api.listThreads.mockResolvedValue([node("c0001")] as never);
    threads.c0001 = { frontmatter: {}, turns: [{ role: "you", body: "q" }] };
    await chat.refreshThreadTree();
    await chat.promoteToChat("c0001");
    expect($$("#threadTree .tnode")).toHaveLength(0);
  });

  it("a slow tree fetch for the previous document never lands in the next one", async () => {
    const { chat, api } = setup();
    addCard(chat, "c0001");
    await settle();
    let releaseOld!: (v: unknown) => void;
    api.listThreads.mockImplementationOnce(() => new Promise((res) => (releaseOld = res)) as never);
    const oldFetch = chat.refreshThreadTree();

    chat.resetChat(); // switch documents while the old fetch is still out
    await settle();
    releaseOld([node("c0001"), node("c0002", { parent: "c0001", branchFromTurn: 0 })]);
    await oldFetch;

    expect(chat.getThreadNodes()).toEqual([]);
    expect($$("#threadTree .tnode")).toHaveLength(0);
  });
});

describe("document switch", () => {
  it("a previous document's review form and result do not persist", async () => {
    const { chat, calls } = setup();
    $<HTMLButtonElement>("#reviewDocBtn").click();
    $<HTMLButtonElement>("#reviewRun").click();
    await settle();
    calls.reviewDocument[0].resolve({ batchId: "b", findings: [] });
    await settle();
    expect($("#reviewForm").hidden).toBe(false);
    expect($("#reviewStatus").textContent).toContain("Review complete");

    chat.resetChat();
    expect($("#reviewForm").hidden).toBe(true);
    expect($("#reviewStatus").hidden).toBe(true);
    expect($("#reviewStatus").textContent).toBe("");
  });

  it("⌘⇧D runs the inline-directive pass and reports when there is nothing to resolve", async () => {
    const { calls, deps, log } = setup();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "D", metaKey: true, shiftKey: true }));
    await settle();
    expect(deps.syncDocToDisk).toHaveBeenCalled();
    expect(calls.resolveDirectives).toHaveLength(1);
    expect($<HTMLButtonElement>("#resolveDirectivesBtn").disabled).toBe(true);
    calls.resolveDirectives[0].resolve({ count: 0, proposed: false, applied: 0, reply: "" });
    await settle();
    expect(log.join("\n")).toContain("no [[ … ]] directives found");
    expect(turnsText()).toEqual(["turn-system:No [[ … ]] directives found in the document."]);
    expect($<HTMLButtonElement>("#resolveDirectivesBtn").disabled).toBe(false);
  });

  it("resetChat clears cards, transcript, and any queued messages", async () => {
    const { chat, api, calls } = setup();
    const c = addCard(chat, "c0001");
    c.input.value = "first";
    c.ask.click();
    await settle();
    footerSend("queued for the old document");

    chat.resetChat();
    expect($$("#comments .comment-card")).toHaveLength(0);
    expect($$("#chatTurns .turn")).toHaveLength(0);
    expect($("#chatFoot").hidden).toBe(true);

    calls.discuss[0].resolve();
    await settle();
    expect(api.reply).not.toHaveBeenCalled(); // the old doc's queue did not leak into the new one
  });
});
