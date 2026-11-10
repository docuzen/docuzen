// @vitest-environment happy-dom
//
// Behavioural tests for the two agent-driven selection quick actions, Brainstorm and
// Visualize, against scripted deps (the chat pane and sidecar they reach through).
import { describe, expect, it, vi } from "vitest";

vi.mock("mermaid", () => ({
  default: { render: vi.fn(async (_id: string, src: string) => ({ svg: `<svg data-src="${src.length}"></svg>` })) },
}));

import { initSelectionAgentActions, type SelectionAgentActionsDeps } from "./selection-agent-actions.js";

type Emit = (e: { event: string; data: unknown }) => void;

function setup(format: "markdown" | "html" = "markdown") {
  const turns = document.createElement("div");
  document.body.replaceChildren(turns);
  const bubble = { onEvent: vi.fn(), done: vi.fn(), fail: vi.fn() };
  let discuss!: { params: Record<string, unknown>; emit: Emit; resolve: () => void; reject: (e: Error) => void };
  let visualize!: { emit: Emit; resolve: (r: { diagram: string }) => void; reject: (e: Error) => void };
  const api = {
    discuss: vi.fn((params: Record<string, unknown>, emit: Emit) => new Promise((res, rej) => {
      discuss = { params, emit, resolve: () => res({ ok: true }), reject: rej };
    })),
    visualize: vi.fn((_p: unknown, emit: Emit) => new Promise((res, rej) => {
      visualize = { emit, resolve: res, reject: rej };
    })),
    getThread: vi.fn(async () => ({ turns: [{ role: "you", body: "q" }, { role: "agent", body: "persisted list" }] })),
    saveDoc: vi.fn(async () => ({ saved: true, version: "v1" })),
  };
  let claimed = false;
  const deps = {
    api,
    log: vi.fn(),
    getDocPath: () => "/d/a.md",
    getFormat: () => format,
    getCurrentMarkdown: () => "# Title\n\nFirst passage here.\n\nSecond paragraph.\n",
    getStance: () => "critiquer",
    getModelId: () => "p/m1",
    modelName: (k: string) => k,
    nextMermaidSeq: () => 1,
    activateChatPane: vi.fn(),
    chatTurn: vi.fn(),
    streamingAgentTurn: vi.fn(() => bubble),
    setChip: vi.fn(),
    setChatBusy: vi.fn(),
    markDiscussed: vi.fn(),
    routeProposal: vi.fn(() => false),
    reloadActiveDoc: vi.fn(async () => {}),
    appendCustomTurn: (box: HTMLElement) => void turns.appendChild(box),
    scrollTurnsToBottom: vi.fn(),
    beginExclusiveTurn: vi.fn(() => (claimed ? false : (claimed = true))),
    endExclusiveTurn: vi.fn(() => void (claimed = false)),
  };
  const actions = initSelectionAgentActions(deps as unknown as SelectionAgentActionsDeps);
  return { actions, deps, api, bubble, turns, discussCall: () => discuss, visualizeCall: () => visualize };
}
const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
};
const anchor = { exact: "First passage here.", prefix: "", suffix: "" };

describe("Brainstorm", () => {
  it("runs a discuss turn with the footer stance + model and settles the bubble on the persisted reply", async () => {
    const { actions, deps, bubble, discussCall } = setup();
    const done = actions.runBrainstorm("c0001", "First passage here.");
    await settle();

    expect(deps.activateChatPane).toHaveBeenCalledWith("c0001", "First passage here.");
    expect(discussCall().params).toMatchObject({ threadId: "c0001", annotationId: "c0001", stance: "critiquer", modelId: "p/m1" });
    expect(deps.setChip).toHaveBeenLastCalledWith("c0001", "running");
    discussCall().emit({ event: "token", data: "- idea" });
    expect(bubble.onEvent).toHaveBeenCalledWith({ event: "token", data: "- idea" });

    discussCall().resolve();
    await done;
    expect(bubble.done).toHaveBeenCalledWith("persisted list");
    expect(deps.markDiscussed).toHaveBeenCalledWith("c0001"); // the next message is a reply
    expect(deps.setChip).toHaveBeenLastCalledWith("c0001", "responded");
    expect(deps.endExclusiveTurn).toHaveBeenCalledWith("c0001", true);
    expect(deps.setChatBusy).toHaveBeenLastCalledWith(null);
  });

  it("a failure is shown in the bubble and does not drain messages queued behind it", async () => {
    const { actions, deps, bubble, discussCall } = setup();
    const done = actions.runBrainstorm("c0001", "q");
    await settle();
    discussCall().reject(new Error("gateway down"));
    await done;
    expect(bubble.fail).toHaveBeenCalledWith("Error: gateway down");
    expect(deps.setChip).toHaveBeenLastCalledWith("c0001", "error");
    expect(deps.markDiscussed).not.toHaveBeenCalled();
    expect(deps.endExclusiveTurn).toHaveBeenCalledWith("c0001", false);
  });

  it("does nothing while another turn is running on the thread", async () => {
    const { actions, api } = setup();
    void actions.runBrainstorm("c0001", "q");
    await settle();
    await actions.runBrainstorm("c0001", "q");
    expect(api.discuss).toHaveBeenCalledTimes(1);
  });
});

describe("Visualize", () => {
  const DIAGRAM = "Here you go:\n```mermaid\nflowchart LR\n  A --> B\n```\nHope that helps.";

  it("renders the diagram, shows only the fenced block, and Insert writes it after the passage", async () => {
    const { actions, api, deps, turns, visualizeCall } = setup("markdown");
    const done = actions.runVisualize("c0001", "First passage here.", anchor);
    await settle();
    const box = turns.querySelector(".proposal")!;
    const insert = box.querySelector<HTMLButtonElement>(".papply")!;
    expect(insert.disabled).toBe(true); // nothing to insert until the agent answers

    visualizeCall().resolve({ diagram: DIAGRAM });
    await done;
    await settle();
    expect(box.querySelector(".pnew")!.textContent).toBe("```mermaid\nflowchart LR\n  A --> B\n```");
    expect(box.querySelector(".dpreview svg, .mermaid-rendered svg")).not.toBeNull();
    expect(insert.disabled).toBe(false);

    insert.click();
    await settle();
    expect(api.saveDoc).toHaveBeenCalledWith({
      text: "# Title\n\nFirst passage here.\n\n```mermaid\nflowchart LR\n  A --> B\n```\n\n\nSecond paragraph.\n",
    });
    expect(deps.reloadActiveDoc).toHaveBeenCalled();
    expect(turns.querySelector(".proposal")).toBeNull();
    expect(deps.endExclusiveTurn).toHaveBeenCalledWith("c0001", true);
  });

  it("HTML document: Insert puts the rendered diagram in a figure after the selected block and saves the HTML", async () => {
    const { actions, api, deps, turns, visualizeCall } = setup("html");
    const frameDoc = document.implementation.createHTMLDocument("t");
    frameDoc.body.innerHTML = "<h1>Title</h1><table><tr><td>First passage here.</td></tr></table>\n<p>Second paragraph.</p>";
    (deps as Record<string, unknown>).getHtmlSurface = () => ({
      doc: frameDoc,
      getHtml: () => `<!doctype html>\n${frameDoc.documentElement.outerHTML}`,
    });
    // A triple-click selection: it runs past the cell's text into the whitespace after it.
    const done = actions.runVisualize("c0001", "q", { ...anchor, exact: anchor.exact + "\n" });
    await settle();
    visualizeCall().resolve({ diagram: DIAGRAM });
    await done;
    const insert = turns.querySelector<HTMLButtonElement>(".papply")!;
    expect(insert.disabled).toBe(false);
    insert.click();
    await settle();
    await settle();

    const fig = frameDoc.querySelector("figure.docuzen-diagram")!;
    expect(fig).not.toBeNull();
    // After the whole table, not inside the cell the selection was in.
    expect(fig.previousElementSibling?.tagName).toBe("TABLE");
    expect(fig.nextElementSibling?.tagName).toBe("P");
    expect(fig.getAttribute("data-mermaid-source")).toContain("flowchart");
    const saved = (api.saveDoc.mock.calls as unknown as [{ text: string }][])[0][0].text;
    expect(saved).toContain("docuzen-diagram");
    expect(saved).not.toContain("```mermaid");
    expect(deps.reloadActiveDoc).toHaveBeenCalled();
    expect(turns.querySelector(".proposal")).toBeNull();
  });

  it("an empty answer is explained instead of offering an empty diagram", async () => {
    const { actions, turns, visualizeCall } = setup();
    const done = actions.runVisualize("c0001", "q", anchor);
    await settle();
    visualizeCall().resolve({ diagram: "   " });
    await done;
    expect(turns.querySelector(".pnew")!.textContent).toContain("No diagram from");
    expect(turns.querySelector<HTMLButtonElement>(".papply")!.disabled).toBe(true);
  });

  it("a failed call releases the thread and shows the error", async () => {
    const { actions, deps, turns, visualizeCall } = setup();
    const done = actions.runVisualize("c0001", "q", anchor);
    await settle();
    visualizeCall().reject(new Error("no model"));
    await done;
    expect(turns.querySelector(".pnew")!.textContent).toContain("no model");
    expect(deps.setChatBusy).toHaveBeenLastCalledWith(null);
    expect(deps.endExclusiveTurn).toHaveBeenCalled();
  });
});
