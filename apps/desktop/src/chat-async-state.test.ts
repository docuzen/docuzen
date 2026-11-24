// @vitest-environment happy-dom
//
// Behavioural tests for what the chat region does when an agent turn, a thread fetch or a
// document-wide pass settles AFTER the user has moved on: to another thread, another
// document, or back again. Same harness idea as chat-behaviour.test.ts (index.html's real
// markup, a scripted sidecar whose replies the test holds and releases), plus a document
// switch: the fake api injects the active docPath into every call the way session.ts's
// facade does, so an RPC that forgot to name its document shows up with the wrong one.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { initChat, type ChatApi, type ChatDeps } from "./chat.js";
import { initSelectionAgentActions, type SelectionAgentActionsDeps } from "./selection-agent-actions.js";

const here = dirname(fileURLToPath(import.meta.url));
const bodyHtml = /<body[^>]*>([\s\S]*)<\/body>/.exec(readFileSync(resolve(here, "..", "index.html"), "utf8"))![1];

type Emit = (e: { event: string; data: unknown; model?: string }) => void;
interface Call {
  params: Record<string, unknown>;
  emit: Emit;
  resolve: (v?: unknown) => void;
  reject: (e: Error) => void;
}
type Turn = { role: string; body: string; meta?: string };

function setup(firstDoc = "/d/a.md") {
  const doc = { path: firstDoc as string | undefined };
  const calls: Record<string, Call[]> = {};
  /** Persisted threads, per document. */
  const threads: Record<string, Record<string, { frontmatter: Record<string, unknown>; turns: Turn[] }>> = {};
  const parked = (method: string, dflt: unknown = { ok: true }) =>
    vi.fn((params: Record<string, unknown>, emit?: Emit) =>
      new Promise((res, rej) => {
        (calls[method] ??= []).push({ params, emit: emit ?? (() => {}), resolve: (v) => res(v ?? dflt), reject: rej });
      }),
    );
  const impl = {
    discuss: parked("discuss"),
    reply: parked("reply"),
    panel: parked("panel"),
    improve: parked("improve"),
    visualize: parked("visualize"),
    branchThread: parked("branchThread"),
    reviewDocument: parked("reviewDocument"),
    resolveDirectives: parked("resolveDirectives"),
    cancelTurn: vi.fn(async (_p: Record<string, unknown>) => ({ ok: true })),
    approveProposal: vi.fn(async (_p: Record<string, unknown>) => ({ ok: true })),
    saveComment: vi.fn(async (_p: Record<string, unknown>) => ({ ok: true })),
    saveDoc: vi.fn(async (_p: Record<string, unknown>) => ({ saved: true })),
    resolveComment: vi.fn(async (_p: Record<string, unknown>) => ({ ok: true })),
    listThreads: vi.fn(async (_p: Record<string, unknown>) => [] as unknown[]),
    listTasks: vi.fn(async (_p: Record<string, unknown>) => [] as unknown[]),
    listModels: vi.fn(async (_p: Record<string, unknown>) => [{ key: "p/m1", name: "Model One", provider: "p", modelId: "m1", hasKey: true }]),
    getThread: vi.fn(async ({ docPath, threadId }: Record<string, unknown>) => {
      const t = threads[docPath as string]?.[threadId as string];
      if (!t) throw new Error("ENOENT: no such file");
      return t;
    }),
  };
  // session.ts's makeApi: the active document's path unless the caller names one.
  const api = Object.fromEntries(
    Object.entries(impl).map(([m, fn]) => [
      m,
      (params: Record<string, unknown>, emit?: Emit) => (fn as (p: unknown, e?: Emit) => unknown)({ docPath: doc.path, ...params }, emit),
    ]),
  );
  const log: string[] = [];
  const explicit: Record<string, unknown> = {
    api,
    log: (l: string) => void log.push(l),
    getDocPath: () => doc.path,
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
    setDirectivesWorking: vi.fn(),
    truncTitle: (s: string) => s,
  };
  const deps = new Proxy(explicit, {
    get: (target, prop: string) => (prop in target ? target[prop] : (target[prop] = vi.fn())),
  }) as unknown as ChatDeps;
  const chat: ChatApi = initChat(deps);
  /** shell.ts's activateTab: the active doc changes, then the chat region is reset. */
  const switchDoc = (path: string | undefined) => {
    doc.path = path;
    chat.resetChat();
  };
  const persist = (docPath: string, threadId: string, turns: Turn[], frontmatter: Record<string, unknown> = {}) => {
    (threads[docPath] ??= {})[threadId] = { frontmatter, turns };
  };
  return { chat, api: impl, calls, threads, persist, deps: explicit, log, doc, switchDoc };
}

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const $$ = <T extends HTMLElement = HTMLElement>(sel: string) => [...document.querySelectorAll<T>(sel)];
const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
};
const turnsText = () =>
  $$("#chatTurns .turn").map((t) => `${[...t.classList].find((c) => c.startsWith("turn-") && c !== "turn-editable" && c !== "turn-locked")}:${t.querySelector(".tbody")?.textContent ?? ""}`);

function addCard(chat: ChatApi, id: string, quoted = `quote ${id}`) {
  chat.addCommentCard(id, quoted, "", 1, "reviewer");
  const card = document.querySelector<HTMLElement>(`#comments .comment-card[data-anno="${id}"]`)!;
  return {
    card,
    input: card.querySelector<HTMLTextAreaElement>(".cinput")!,
    ask: card.querySelector<HTMLButtonElement>(".discuss")!,
    chip: card.querySelector<HTMLSpanElement>(".chip")!,
  };
}
function askFromCard(chat: ChatApi, id: string, text: string) {
  const c = addCard(chat, id);
  c.input.value = text;
  c.ask.click();
  return c;
}
function footerSend(text: string) {
  $<HTMLTextAreaElement>("#chatInput").value = text;
  $<HTMLButtonElement>("#chatSend").click();
}
const stopShown = () => !$<HTMLButtonElement>("#chatStop").hidden;

beforeEach(() => {
  document.body.innerHTML = bodyHtml;
  vi.stubGlobal("confirm", () => true);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("H26: Ask all models", () => {
  it("a follow-up queued during the run goes out as a reply — never a second discuss that re-creates the thread", async () => {
    const { chat, api, calls, persist } = setup();
    await chat.refreshThreadModels();
    const c = addCard(chat, "c0001");
    await chat.promoteToChat("c0001");
    $<HTMLTextAreaElement>("#chatInput").value = "compare these";
    $<HTMLButtonElement>("#chatPanel").click();
    await settle();
    expect(api.panel).toHaveBeenCalledTimes(1);
    expect($<HTMLTextAreaElement>("#chatInput").value).toBe(""); // cleared when committed

    footerSend("follow-up");
    $<HTMLTextAreaElement>("#chatInput").value = "a new draft";
    persist("/d/a.md", "c0001", [
      { role: "you", body: "compare these" },
      { role: "agent", body: "one take", meta: "p/m1" },
    ]);
    calls.panel[0].emit({ event: "token", data: "one", model: "p/m1" });
    calls.panel[0].resolve();
    await settle();

    expect(api.discuss).not.toHaveBeenCalled();
    expect(api.reply).toHaveBeenCalledTimes(1);
    expect(calls.reply[0].params).toMatchObject({ threadId: "c0001", message: "follow-up" });
    expect(c.chip.textContent).toBe("running"); // the queued reply is what's running now
    expect($<HTMLTextAreaElement>("#chatInput").value).toBe("a new draft");
    expect($$("#chatTurns .turn-agent .tbody")[0].textContent).toBe("one take"); // the persisted reply
  });
});

describe("H27: a turn that settles after a tab switch", () => {
  it("leaves the new document's queue, Stop and cards alone, and names its own document", async () => {
    const { chat, api, calls, deps, switchDoc } = setup();
    askFromCard(chat, "c0001", "asked on A");
    await settle();
    expect(calls.discuss[0].params.docPath).toBe("/d/a.md");

    switchDoc("/d/b.md");
    const b = askFromCard(chat, "c0001", "asked on B");
    await settle();
    footerSend("queued on B");
    await settle();
    expect(stopShown()).toBe(true);
    (deps.routeProposal as ReturnType<typeof vi.fn>).mockClear();

    calls.discuss[0].emit({ event: "applied", data: "" });
    calls.discuss[0].emit({ event: "token", data: "A's reply" });
    calls.discuss[0].resolve();
    await settle();

    expect(deps.routeProposal).not.toHaveBeenCalled(); // A's edit events never reach B's document
    expect(stopShown()).toBe(true); // B's turn is still running
    expect(b.chip.textContent).toBe("running");
    expect(api.reply).not.toHaveBeenCalled(); // B's queue waits for B's turn
    expect(turnsText().join("\n")).not.toContain("A's reply");
    // The settled turn read its reply from ITS document, not the active one.
    expect(api.getThread.mock.calls.filter(([p]) => p.docPath === "/d/b.md")).toHaveLength(0);

    calls.discuss[1].resolve();
    await settle();
    expect(api.reply).toHaveBeenCalledTimes(1);
    expect(calls.reply[0].params).toMatchObject({ docPath: "/d/b.md", message: "queued on B" });
  });

  it("a direct send that fails after a tab switch does not put its text into the new document's footer", async () => {
    const { chat, calls, switchDoc, persist } = setup();
    addCard(chat, "c0001");
    chat.markDiscussed("c0001");
    persist("/d/a.md", "c0001", [{ role: "you", body: "q" }]);
    await chat.promoteToChat("c0001");
    footerSend("will fail");
    await settle();

    switchDoc("/d/b.md");
    addCard(chat, "c0001");
    persist("/d/b.md", "c0001", [{ role: "you", body: "b" }]);
    await chat.promoteToChat("c0001");
    calls.reply[0].reject(new Error("boom"));
    await settle();

    expect($<HTMLTextAreaElement>("#chatInput").value).toBe("");
    expect(stopShown()).toBe(false);
  });

  it("Brainstorm settling after a switch does not mark the new document's same-numbered comment discussed", async () => {
    const ctx = setup();
    const { chat, calls, switchDoc } = ctx;
    addCard(chat, "c0001");
    const actions = initSelectionAgentActions({
      ...(ctx.deps as object),
      ...chat,
      nextMermaidSeq: () => 1,
      getCurrentMarkdown: () => "",
    } as unknown as SelectionAgentActionsDeps);
    const done = actions.runBrainstorm("c0001", "quote c0001");
    await settle();
    expect(calls.discuss[0].params).toMatchObject({ docPath: "/d/a.md", threadId: "c0001" });

    switchDoc("/d/b.md");
    const b = addCard(chat, "c0001");
    calls.discuss[0].resolve();
    await done;
    await settle();

    expect(b.card.classList.contains("discussed")).toBe(false);
    expect(b.ask.textContent).toBe("Ask agent");
    expect(b.ask.disabled).toBe(false);
    expect(b.chip.textContent).toBe("");
  });

  it("Improve settling after a switch leaves the new document's Improve button usable", async () => {
    const { chat, calls, switchDoc, persist } = setup();
    addCard(chat, "c0001");
    persist("/d/a.md", "c0001", []);
    await chat.promoteToChat("c0001");
    const improving = chat.runImprove("c0001");
    await settle();
    expect(calls.improve[0].params.docPath).toBe("/d/a.md");

    switchDoc("/d/b.md");
    addCard(chat, "c0002");
    persist("/d/b.md", "c0002", []);
    await chat.promoteToChat("c0002");
    const improveBtn = $<HTMLButtonElement>("#chatImprove");
    expect(improveBtn.disabled).toBe(false);
    expect(improveBtn.textContent).toBe("Improve passage");

    calls.improve[0].resolve({ newText: "x", proposalId: "c0001#p1" });
    await improving;
    expect($$("#chatTurns .proposal")).toHaveLength(0); // nothing of A's lands in B's pane
    expect(improveBtn.disabled).toBe(false);
  });

  it("Ask all models settling after a switch leaves the new document's footer draft alone", async () => {
    const { chat, calls, switchDoc, persist } = setup();
    await chat.refreshThreadModels();
    addCard(chat, "c0001");
    await chat.promoteToChat("c0001");
    $<HTMLButtonElement>("#chatPanel").click();
    await settle();

    switchDoc("/d/b.md");
    addCard(chat, "c0002");
    persist("/d/b.md", "c0002", []);
    await chat.promoteToChat("c0002");
    $<HTMLTextAreaElement>("#chatInput").value = "drafting on B";
    calls.panel[0].resolve();
    await settle();
    expect($<HTMLTextAreaElement>("#chatInput").value).toBe("drafting on B");
  });
});

describe("H29: the chat pane's subject changes while a thread is loading", () => {
  function slowThread(api: ReturnType<typeof setup>["api"], turns: Turn[]) {
    let release!: () => void;
    api.getThread.mockImplementationOnce(
      () => new Promise((res) => (release = () => res({ frontmatter: { stance: "supporter" }, turns }))) as never,
    );
    return () => release();
  }

  it("a card's Ask agent", async () => {
    const { chat, api } = setup();
    addCard(chat, "c0001", "quote A");
    const release = slowThread(api, [{ role: "you", body: "A question" }]);
    const opening = chat.promoteToChat("c0001");
    askFromCard(chat, "c0002", "B question");
    await settle();
    release();
    await opening;
    expect($("#chatQuote").textContent).toContain("quote c0002");
    expect(turnsText()).toEqual(["turn-you:B question", "turn-agent:"]);
    expect($<HTMLSelectElement>("#chatStance").value).not.toBe("supporter");
  });

  it("deleting the comment", async () => {
    const { chat, api } = setup();
    addCard(chat, "c0001");
    const release = slowThread(api, [{ role: "you", body: "A question" }]);
    const opening = chat.promoteToChat("c0001");
    chat.removeCommentEntry("c0001");
    release();
    await opening;
    expect($$("#chatTurns .turn")).toHaveLength(0);
    expect($("#chatEmpty").hidden).toBe(false);
  });

  it("a directive result banner", async () => {
    const { chat, api, calls } = setup();
    addCard(chat, "c0001");
    const release = slowThread(api, [{ role: "you", body: "A question" }]);
    const opening = chat.promoteToChat("c0001");
    const pass = chat.runResolveDirectives();
    await settle();
    calls.resolveDirectives[0].resolve({ count: 0, proposed: false, applied: 0, reply: "" });
    await pass;
    release();
    await opening;
    expect(turnsText()).toEqual(["turn-system:No [[ … ]] directives found in the document."]);
  });

  it("a document switch", async () => {
    const { chat, api, switchDoc } = setup();
    addCard(chat, "c0001");
    const release = slowThread(api, [{ role: "you", body: "A question" }]);
    const opening = chat.promoteToChat("c0001");
    switchDoc("/d/b.md");
    release();
    await opening;
    expect($$("#chatTurns .turn")).toHaveLength(0);
    expect($("#chatFoot").hidden).toBe(true);
  });

  it("a message sent while the transcript loads lands after the history, once", async () => {
    const { chat, api, calls } = setup();
    askFromCard(chat, "c0001", "first");
    await settle(); // discuss in flight: footer sends queue
    const release = slowThread(api, [{ role: "you", body: "first" }]);
    const opening = chat.promoteToChat("c0001");
    footerSend("typed while loading");
    release();
    await opening;
    await settle();
    expect(turnsText()).toEqual(["turn-you:first", "turn-agent:", "turn-you:typed while loading"]);
    expect($$("#chatTurns .chip.queued")).toHaveLength(1);
    calls.discuss[0].resolve();
    await settle();
    expect(calls.reply).toHaveLength(1);
  });
});

describe("H30: document-wide passes", () => {
  it("a review that finishes after a tab switch neither reloads nor reports into the new document", async () => {
    const { calls, deps, switchDoc } = setup();
    $<HTMLButtonElement>("#reviewDocBtn").click();
    $<HTMLButtonElement>("#reviewRun").click();
    await settle();
    expect(calls.reviewDocument[0].params.docPath).toBe("/d/a.md");

    switchDoc("/d/b.md");
    expect($<HTMLButtonElement>("#reviewRun").disabled).toBe(false); // nothing is reviewing B
    calls.reviewDocument[0].resolve({ batchId: "b", findings: [{ annotationId: "c0001", status: "open" }] });
    await settle();
    expect(deps.reloadActiveDoc).not.toHaveBeenCalled();
    expect($("#reviewStatus").hidden).toBe(true);
  });

  it("a review on a harness that can't file findings shows its written review instead of an empty rail", async () => {
    const { chat, calls, threads } = setup();
    chat.setHarnessContext("codex", [
      { id: "codex", label: "Codex", available: true, capabilities: { reviewFindings: false, multiModelPanel: false } },
    ] as Parameters<typeof chat.setHarnessContext>[1]);
    $<HTMLButtonElement>("#reviewDocBtn").click();
    expect($("#reviewStatus").textContent).toMatch(/Codex can't add findings to the rail yet/);
    $<HTMLButtonElement>("#reviewRun").click();
    await settle();
    (threads["/d/a.md"] ??= {}).review = { frontmatter: {}, turns: [{ role: "you", body: "Review" }, { role: "agent", body: "The rollout lacks a rollback step." }] };
    calls.reviewDocument[0].resolve({ batchId: "b", findings: [] });
    await settle();
    expect($("#reviewStatus").textContent).toMatch(/its review is in the discussion pane/);
    expect(turnsText()).toEqual(["turn-system:Codex reviewed the document.", "turn-agent:The rollout lacks a rollback step."]);
  });

  it("names its document even when the tab changes while the editor is being saved", async () => {
    const { calls, deps, doc } = setup();
    let saved!: () => void;
    (deps.syncDocToDisk as ReturnType<typeof vi.fn>).mockImplementationOnce(() => new Promise<void>((r) => (saved = r)));
    $<HTMLButtonElement>("#reviewRun").click();
    await settle();
    doc.path = "/d/b.md"; // the switch lands during the autosave
    saved();
    await settle();
    expect(calls.reviewDocument[0].params.docPath).toBe("/d/a.md");
  });

  it("the status clock stops on a switch instead of ticking on a hidden line", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    const { switchDoc } = setup();
    $<HTMLButtonElement>("#reviewRun").click();
    await settle();
    switchDoc("/d/b.md");
    const status = $("#reviewStatus");
    status.textContent = "";
    vi.advanceTimersByTime(3000);
    expect(status.textContent).toBe("");
  });

  it("coming back to the document while its review runs shows it running, and the result lands there", async () => {
    const { calls, deps, switchDoc } = setup();
    $<HTMLButtonElement>("#reviewRun").click();
    await settle();
    switchDoc("/d/b.md");
    switchDoc("/d/a.md");
    expect($<HTMLButtonElement>("#reviewRun").disabled).toBe(true); // one review per document at a time
    expect($("#reviewStatus").hidden).toBe(false);
    $<HTMLButtonElement>("#reviewRun").click();
    await settle();
    expect(calls.reviewDocument).toHaveLength(1);

    calls.reviewDocument[0].resolve({ batchId: "b", findings: [] });
    await settle();
    expect(deps.reloadActiveDoc).toHaveBeenCalledTimes(1);
    expect($("#reviewStatus").textContent).toContain("Review complete");
    expect($<HTMLButtonElement>("#reviewRun").disabled).toBe(false);
  });

  it("⌘⇧D while the directive pass runs does not start a second one", async () => {
    const { calls, log } = setup();
    const press = () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "D", metaKey: true, shiftKey: true }));
    press();
    await settle();
    press();
    await settle();
    expect(calls.resolveDirectives).toHaveLength(1);
    expect(log.join("\n")).toContain("already");
  });

  it("a directive pass that finishes after a switch leaves the new document's pane and chips alone", async () => {
    const { chat, calls, deps, switchDoc, persist } = setup();
    void chat.runResolveDirectives();
    await settle();
    expect(calls.resolveDirectives[0].params.docPath).toBe("/d/a.md");
    switchDoc("/d/b.md");
    expect(deps.setDirectivesWorking).toHaveBeenLastCalledWith(false);
    expect($<HTMLButtonElement>("#resolveDirectivesBtn").disabled).toBe(false);

    addCard(chat, "c0001");
    persist("/d/b.md", "c0001", [{ role: "you", body: "B's thread" }]);
    await chat.promoteToChat("c0001");
    (deps.routeProposal as ReturnType<typeof vi.fn>).mockClear();
    calls.resolveDirectives[0].emit({ event: "proposal", data: "{}" });
    calls.resolveDirectives[0].resolve({ count: 1, proposed: false, applied: 0, reply: "could not" });
    await settle();
    expect(deps.routeProposal).not.toHaveBeenCalled();
    expect(turnsText()).toEqual(["turn-you:B's thread"]);
    expect(deps.setDirectivesWorking).toHaveBeenLastCalledWith(false);
  });
});

describe("M30: the Agents panel", () => {
  it.each([0, 1, 2])("counts %i directive workers without counting the Resolve command", async (count) => {
    const { api, chat, calls } = setup();
    const names = Array.from({ length: count }, (_, i) => "Inline directive " + (i + 1));
    const rows = names.map((_, i) => ({
      threadId: "directive-" + (i + 1), status: "running", piSessionId: null, updatedAt: "t",
    }));
    api.listTasks.mockResolvedValue(rows);
    const pass = chat.runResolveDirectives();
    await settle();
    $<HTMLButtonElement>("#agentsBtn").click();
    await settle();
    expect($("#agentsBtn").textContent).toBe(count ? `Agents (${count})` : "Agents");
    expect($$("#agentsPanel .agentshead").map(e => e.textContent)).toEqual(count ? ["Active"] : []);
    expect($$("#agentsPanel .agenttitle").map(e => e.textContent)).toEqual(names);
    expect($$("#agentsPanel .agentrow.clickable")).toHaveLength(count);

    api.listTasks.mockResolvedValue(rows.map(r => ({ ...r, status: "responded" })));
    calls.resolveDirectives[0].resolve({ count, proposed: count > 0, applied: 0, reply: "" });
    await pass;
    await settle();
    expect($("#agentsBtn").textContent).toBe("Agents");
    expect($$("#agentsPanel .agentshead").map(e => e.textContent)).toEqual(count ? ["Recent"] : []);
    expect($$("#agentsPanel .agenttitle").map(e => e.textContent)).toEqual(names);
    $<HTMLButtonElement>("#agentsBtn").click();
  });

  it("a running pass on one document is not listed for another", async () => {
    const { switchDoc } = setup();
    $<HTMLButtonElement>("#reviewRun").click();
    await settle();
    switchDoc("/d/b.md");
    $<HTMLButtonElement>("#agentsBtn").click();
    await settle();
    expect($("#agentsPanel").textContent).not.toContain("Review pass");
    expect($("#agentsPanel").textContent).toContain("No agent tasks yet");
  });

  it("a slow task listing for the previous document is not shown for the new one", async () => {
    const { api, switchDoc } = setup();
    let release!: (rows: unknown[]) => void;
    api.listTasks.mockImplementationOnce(() => new Promise((r) => (release = r)) as never);
    $<HTMLButtonElement>("#agentsBtn").click();
    await settle();
    switchDoc("/d/b.md");
    await settle();
    release([{ threadId: "c0009", status: "running", piSessionId: null, updatedAt: "t" }]);
    await settle();
    expect($("#agentsPanel").textContent).not.toContain("c0009");
    expect($("#agentsBtn").textContent).toBe("Agents");
  });
});

describe("M31: re-opening a thread whose turn is still running", () => {
  it("brings back Stop and the live reply, and the reply finishes there", async () => {
    const { chat, calls, persist } = setup();
    addCard(chat, "c0001");
    addCard(chat, "c0002");
    chat.markDiscussed("c0001");
    persist("/d/a.md", "c0001", [{ role: "you", body: "q1" }]);
    persist("/d/a.md", "c0002", [{ role: "you", body: "other" }]);
    await chat.promoteToChat("c0001");
    footerSend("q2");
    await settle();
    expect(stopShown()).toBe(true);

    await chat.promoteToChat("c0002");
    expect(stopShown()).toBe(false); // c0002 has nothing running
    calls.reply[0].emit({ event: "token", data: "partial " });

    persist("/d/a.md", "c0001", [{ role: "you", body: "q1" }, { role: "you", body: "q2" }]);
    await chat.promoteToChat("c0001");
    expect(stopShown()).toBe(true);
    expect(turnsText()).toEqual(["turn-you:q1", "turn-you:q2", "turn-agent:partial "]);
    calls.reply[0].emit({ event: "token", data: "answer" });
    persist("/d/a.md", "c0001", [{ role: "you", body: "q1" }, { role: "you", body: "q2" }, { role: "agent", body: "partial answer" }]);
    calls.reply[0].resolve();
    await settle();
    expect(turnsText().at(-1)).toBe("turn-agent:partial answer");
    expect(stopShown()).toBe(false);
  });
});

describe("M32: messages left behind by a failed turn", () => {
  it("are held: a later message goes out alone and does not drag them after it", async () => {
    const { chat, api, calls, persist } = setup();
    addCard(chat, "c0001");
    chat.markDiscussed("c0001");
    persist("/d/a.md", "c0001", [{ role: "you", body: "q" }, { role: "agent", body: "a" }]);
    await chat.promoteToChat("c0001");
    footerSend("first");
    await settle();
    footerSend("two");
    footerSend("three");
    calls.reply[0].reject(new Error("boom"));
    await settle();
    expect($$("#chatTurns .chip.held")).toHaveLength(2);
    expect($$("#chatTurns .chip.queued")).toHaveLength(0);

    footerSend("four");
    await settle();
    expect(api.reply).toHaveBeenCalledTimes(2);
    expect(calls.reply[1].params.message).toBe("four");
    calls.reply[1].resolve();
    await settle();
    expect(api.reply).toHaveBeenCalledTimes(2); // "two"/"three" stay held

    // Each held message can be sent on its own…
    $$<HTMLButtonElement>("#chatTurns .held-send")[0].click();
    await settle();
    expect(api.reply).toHaveBeenCalledTimes(3);
    expect(calls.reply[2].params.message).toBe("two");
    // …or removed.
    $$<HTMLButtonElement>("#chatTurns .chip.held .queued-remove")[0].click();
    expect(turnsText().join("\n")).not.toContain("three");
  });
});

describe("M33: opening a pseudo-thread or a banner, or deleting the open comment", () => {
  it("clears the previous thread's Stop, tree and footer labels", async () => {
    const { chat, api, persist } = setup();
    chat.addCommentCard("c0001", "quote c0001", "first", 1, "reviewer", true); // a resolved comment
    document.querySelector<HTMLButtonElement>('#comments .comment-card[data-anno="c0001"] .discuss')!.click();
    await settle();
    expect(stopShown()).toBe(true);
    expect($("#chatResolve").textContent).toBe("Reopen thread");
    chat.registerBranchEntry("c0002", "quote c0001", "c0001");
    api.listThreads.mockResolvedValue([
      { id: "c0001", anchorExact: "q", title: "t1", turnCount: 1, status: "running", createdAt: "1" },
      { id: "c0002", anchorExact: "q", title: "t2", turnCount: 1, status: "open", createdAt: "2", parent: "c0001", branchFromTurn: 0 },
    ]);
    await chat.refreshThreadTree();
    expect($$("#threadTree .tnode")).toHaveLength(2);

    persist("/d/a.md", "directive-1", [{ role: "agent", body: "done" }]);
    await chat.jumpToAnnotation("directive-1");
    expect(stopShown()).toBe(false);
    expect($$("#threadTree .tnode")).toHaveLength(0);
    expect($("#chatResolve").textContent).toBe("Resolve thread");
  });

  it("deleting the open comment while its turn runs hides Stop", async () => {
    const { chat } = setup();
    askFromCard(chat, "c0001", "first");
    await settle();
    chat.removeCommentEntry("c0001");
    expect(stopShown()).toBe(false);
  });
});

describe("M34: edit-to-fork", () => {
  async function openForkEditor(ctx: ReturnType<typeof setup>) {
    addCard(ctx.chat, "c0001");
    ctx.chat.markDiscussed("c0001");
    ctx.persist("/d/a.md", "c0001", [{ role: "you", body: "original" }, { role: "agent", body: "a" }]);
    await ctx.chat.promoteToChat("c0001");
    $<HTMLButtonElement>("#chatTurns .turn-you .turnedit").click();
    $<HTMLTextAreaElement>("#chatTurns .turnedit-ta").value = "edited";
  }

  it("refuses to branch when a turn started on the thread after the editor opened", async () => {
    const ctx = setup();
    await openForkEditor(ctx);
    footerSend("a reply");
    await settle();
    $<HTMLButtonElement>("#chatTurns .tb-latest").click();
    await settle();
    expect(ctx.api.branchThread).not.toHaveBeenCalled();
  });

  it("holds the thread while the branch is created, then shows the branch with its pager", async () => {
    const ctx = setup();
    await openForkEditor(ctx);
    $<HTMLButtonElement>("#chatTurns .tb-latest").click();
    await settle();
    expect(ctx.calls.branchThread[0].params).toMatchObject({ docPath: "/d/a.md", threadId: "c0001", message: "edited" });
    footerSend("meanwhile");
    await settle();
    expect(ctx.api.reply).not.toHaveBeenCalled(); // queued behind the branch

    ctx.api.listThreads.mockResolvedValue([
      { id: "c0001", anchorExact: "q", title: "t1", turnCount: 2, status: "open", createdAt: "1" },
      { id: "c0002", anchorExact: "q", title: "t2", turnCount: 2, status: "open", createdAt: "2", parent: "c0001", branchFromTurn: 0 },
    ]);
    ctx.persist("/d/a.md", "c0002", [{ role: "you", body: "edited" }, { role: "agent", body: "b" }]);
    ctx.calls.branchThread[0].resolve({ branchThreadId: "c0002" });
    await settle();
    expect(turnsText()).toEqual(["turn-you:edited", "turn-agent:b"]);
    expect($("#chatTurns .vp-label").textContent).toContain("2 / 2");
  });

  it("the branch tree opens threads that have no comment card", async () => {
    const { chat, api, persist } = setup();
    api.listThreads.mockResolvedValue([
      { id: "directive-1", anchorExact: "", title: "d1", turnCount: 1, status: "open", createdAt: "1" },
      { id: "c0007", anchorExact: "", title: "d1 branch", turnCount: 1, status: "open", createdAt: "2", parent: "directive-1", branchFromTurn: 0 },
    ]);
    await chat.refreshThreadTree();
    persist("/d/a.md", "directive-1", [{ role: "you", body: "d" }]);
    persist("/d/a.md", "c0007", [{ role: "you", body: "branch body" }]);
    await chat.jumpToAnnotation("directive-1");
    $$<HTMLElement>("#threadTree .tnode").find((n) => n.dataset.thread === "c0007")!.click();
    await settle();
    expect(turnsText()).toEqual(["turn-you:branch body"]);
  });
});

describe("L14: smaller state defects", () => {
  it("deleting a comment also drops branches of its branches", async () => {
    const { chat } = setup();
    addCard(chat, "c0001");
    chat.registerBranchEntry("c0002", "q", "c0001");
    chat.registerBranchEntry("c0003", "q", "c0002");
    chat.removeCommentEntry("c0001");
    expect(chat.hasComment("c0002")).toBe(false);
    expect(chat.hasComment("c0003")).toBe(false);
  });

  it("Resolve answered after the pane moved on marks the card, but writes nothing into the other thread", async () => {
    const { chat, api, persist } = setup();
    const c = addCard(chat, "c0001");
    addCard(chat, "c0002");
    persist("/d/a.md", "c0002", [{ role: "you", body: "other" }]);
    await chat.promoteToChat("c0001");
    let answer!: () => void;
    api.resolveComment.mockImplementationOnce(() => new Promise((r) => (answer = () => r({ ok: true }))) as never);
    $<HTMLButtonElement>("#chatResolve").click();
    await chat.promoteToChat("c0002");
    answer();
    await settle();
    expect(api.resolveComment.mock.calls[0][0]).toMatchObject({ docPath: "/d/a.md", id: "c0001", resolved: true });
    expect(c.card.classList.contains("resolved")).toBe(true);
    expect(turnsText()).toEqual(["turn-you:other"]);
  });

  it("Retry's last-message fill does not land in a thread opened meanwhile", async () => {
    const { chat, api, persist } = setup();
    api.listThreads.mockResolvedValue([
      { id: "c0001", anchorExact: "q", title: "t", turnCount: 2, hasAgentTurn: true, status: "error", lastYouBody: "ask again", createdAt: "1" },
    ]);
    const c = addCard(chat, "c0001");
    addCard(chat, "c0002");
    persist("/d/a.md", "c0001", [{ role: "you", body: "ask again" }]);
    persist("/d/a.md", "c0002", [{ role: "you", body: "other" }]);
    await settle();
    let second!: () => void;
    api.getThread
      .mockImplementationOnce(async () => ({ frontmatter: {}, turns: [{ role: "you", body: "ask again" }] }))
      .mockImplementationOnce(() => new Promise((r) => (second = () => r({ frontmatter: {}, turns: [{ role: "you", body: "ask again" }] }))) as never);
    c.ask.click(); // Retry
    await settle();
    await chat.promoteToChat("c0002");
    second?.();
    await settle();
    expect($<HTMLTextAreaElement>("#chatInput").value).toBe("");
  });
});

describe("a turn still running when its document is opened again (tab switch, reload)", () => {
  const poll = async () => {
    $<HTMLButtonElement>("#agentsBtn").click(); // opening the panel lists the tasks
    await settle();
    $<HTMLButtonElement>("#agentsBtn").click();
    await settle();
  };

  it("shows as running with Stop, holds a new message, then shows its reply and sends the message", async () => {
    const { chat, api, calls, persist, switchDoc } = setup();
    askFromCard(chat, "c0001", "Count to 150.");
    await settle();
    expect(calls.discuss).toHaveLength(1);
    // Away and back: a new document generation. The sidecar is still answering.
    switchDoc("/d/b.md");
    switchDoc("/d/a.md");
    const c = addCard(chat, "c0001"); // the cards come back from listThreads
    persist("/d/a.md", "c0001", [{ role: "you", body: "Count to 150." }], { status: "running" });
    api.listTasks.mockResolvedValue([{ threadId: "c0001", status: "running", piSessionId: null, updatedAt: "2000-01-01T00:00:00.000Z" }]);
    await poll();
    expect(c.chip.textContent).toBe("running");
    await chat.promoteToChat("c0001");
    await settle();
    expect(stopShown()).toBe(true);
    expect(document.querySelectorAll("#chatTurns .turn-agent.working")).toHaveLength(1);
    footerSend("And to 200?");
    await settle();
    expect(calls.reply ?? []).toHaveLength(0); // waits behind the running turn
    expect(document.querySelectorAll("#chatTurns .chip.queued")).toHaveLength(1);

    persist("/d/a.md", "c0001", [{ role: "you", body: "Count to 150." }, { role: "agent", body: "1 2 3 … 150" }], { status: "responded" });
    api.listTasks.mockResolvedValue([]);
    await poll();
    expect(turnsText().slice(0, 2)).toEqual(["turn-you:Count to 150.", "turn-agent:1 2 3 … 150"]);
    expect(document.querySelectorAll("#chatTurns .turn-agent.working")).toHaveLength(1); // the reply's own bubble
    expect(calls.discuss).toHaveLength(1); // never a second discuss over the thread
    expect(calls.reply).toHaveLength(1); // the held message went out as a reply
    expect(calls.reply[0].params.message).toBe("And to 200?");
    expect(c.chip.textContent).toBe("running"); // ... which is now running
    persist("/d/a.md", "c0001", [
      { role: "you", body: "Count to 150." }, { role: "agent", body: "1 2 3 … 150" },
      { role: "you", body: "And to 200?" }, { role: "agent", body: "… 200" },
    ], { status: "responded" });
    calls.reply[0].resolve();
    await settle();
    expect(c.chip.textContent).toBe("responded");
    expect(stopShown()).toBe(false);
  });

  it("leaves alone a turn this generation started itself", async () => {
    const { chat, api } = setup();
    const c = askFromCard(chat, "c0001", "q");
    await settle();
    api.listTasks.mockResolvedValue([{ threadId: "c0001", status: "running", piSessionId: null, updatedAt: new Date(Date.now() + 1000).toISOString() }]);
    await poll();
    expect(document.querySelectorAll("#chatTurns .turn-agent.working")).toHaveLength(1); // its own bubble only
    expect(c.chip.textContent).toBe("running");
  });
});
