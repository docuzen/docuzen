// @vitest-environment happy-dom
//
// Behavioural tests for proposals.ts: which document an approve/reject or a reload acts
// on when the user has switched tabs in the meantime, how a review card behaves inside
// the HTML document, and where a proposal that cannot be placed inline is anchored.
// Drives index.html's real diff panel and a scripted sidecar.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Schema } from "@milkdown/kit/prose/model";
import { initProposals, type ProposalsDeps } from "./proposals.js";
import { projectionNeedlesForHtmlHunk } from "./proposal-locate.js";

const here = dirname(fileURLToPath(import.meta.url));
const bodyHtml = /<body[^>]*>([\s\S]*)<\/body>/.exec(readFileSync(resolve(here, "..", "index.html"), "utf8"))![1];

function findDirectiveOffsets(text: string): { start: number; end: number }[] {
  const re = /\[\[(?:(?!\]\])[\s\S])+\]\]/g;
  const out: { start: number; end: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) out.push({ start: m.index, end: m.index + m[0].length });
  return out;
}

const schema = new Schema({
  nodes: { doc: { content: "paragraph+" }, paragraph: { content: "text*" }, text: {} },
});

function setup(opts: { paragraphs?: string[]; htmlDoc?: Document } = {}) {
  const doc = { path: "/d/a.md" as string | undefined };
  const parkedOpen: { params: Record<string, unknown>; resolve: (v: unknown) => void }[] = [];
  const parkedApprove: { params: Record<string, unknown>; resolve: () => void }[] = [];
  const api = {
    openDoc: vi.fn((params: Record<string, unknown>) => new Promise((r) => parkedOpen.push({ params, resolve: r }))),
    approveProposal: vi.fn((params: Record<string, unknown>) => new Promise<void>((r) => parkedApprove.push({ params, resolve: () => r() }))),
    rejectProposal: vi.fn(async () => ({ ok: true })),
  };
  const withDocPath = Object.fromEntries(
    Object.entries(api).map(([m, fn]) => [m, (p: Record<string, unknown>) => (fn as (p: unknown) => unknown)({ docPath: doc.path, ...p })]),
  );
  // A minimal ProseMirror view: the real projection over a real document, with
  // dispatched proposal metas recorded instead of decorated.
  const metas: Record<string, unknown>[] = [];
  const pmDoc = schema.node(
    "doc",
    null,
    (opts.paragraphs ?? ["intro"]).map((t) => schema.node("paragraph", null, t ? [schema.text(t)] : [])),
  );
  const view = {
    state: { doc: pmDoc, tr: { setMeta: (_k: unknown, meta: Record<string, unknown>) => ({ meta }) } },
    dispatch: (tr: { meta: Record<string, unknown> }) => void metas.push(tr.meta),
  };
  const editor = { action: (fn: (ctx: { get: () => unknown }) => unknown) => fn({ get: () => view }) };
  const deps = {
    api: withDocPath,
    log: vi.fn(),
    getDocPath: () => doc.path,
    getFormat: () => (opts.htmlDoc ? "html" : "markdown"),
    getEditor: () => editor,
    getHtmlSurface: () => (opts.htmlDoc ? { doc: opts.htmlDoc } : null),
    renderPreviewText: (into: HTMLElement, text: string) => void (into.textContent = text),
    reloadActiveDoc: vi.fn(async () => {}),
    chatTurn: vi.fn(),
    chatTurnWithAction: vi.fn(),
    getCommentQuoted: () => undefined,
    proposalKey: {},
    findDirectiveOffsets,
  } as unknown as ProposalsDeps;
  const proposals = initProposals(deps);
  return { proposals, api, parkedOpen, parkedApprove, deps: deps as unknown as Record<string, ReturnType<typeof vi.fn>>, doc, metas };
}

const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
};

beforeEach(() => {
  document.body.innerHTML = bodyHtml;
});

describe("H28: proposals belong to the document they came from", () => {
  it("an applied edit reloads its own document only — not the one switched to before the reload fired", async () => {
    const { proposals, deps, doc } = setup();
    proposals.routeProposal({ event: "applied", data: "" } as never);
    doc.path = "/d/b.md";
    await new Promise((r) => setTimeout(r, 250));
    expect(deps.reloadActiveDoc).not.toHaveBeenCalled();
  });

  it("the full-rewrite panel does not open over another document when the switch lands while it loads", async () => {
    const { proposals, parkedOpen, doc } = setup();
    const opening = proposals.openDiffPanel({ id: "c0001#p1", threadId: "c0001", rationale: "why", edits: [], fullText: "new\n" });
    doc.path = "/d/b.md";
    expect(parkedOpen[0].params.docPath).toBe("/d/a.md");
    parkedOpen[0].resolve({ text: "old\n" });
    await opening;
    expect(proposals.diffPanel.hidden).toBe(true);
  });

  it("approving a rewrite after the user switched documents approves it on its own document and reloads nothing", async () => {
    const { proposals, parkedOpen, parkedApprove, deps, doc } = setup();
    const opening = proposals.openDiffPanel({ id: "c0001#p1", threadId: "c0001", rationale: "why", edits: [], fullText: "new\n" });
    parkedOpen[0].resolve({ text: "old\n" });
    await opening;
    expect(proposals.diffPanel.hidden).toBe(false);
    proposals.diffPanel.querySelector<HTMLButtonElement>(".diffapprove")!.click();
    doc.path = "/d/b.md";
    expect(parkedApprove[0].params).toMatchObject({ docPath: "/d/a.md", proposalId: "c0001#p1" });
    parkedApprove[0].resolve();
    await settle();
    expect(deps.reloadActiveDoc).not.toHaveBeenCalled();
  });

  it("an inline proposal approved just before a switch reloads nothing on the new document", async () => {
    const { proposals, parkedApprove, deps, doc } = setup();
    const card = proposals.buildProposalWidget({ id: "c0001#p1", threadId: "c0001", newText: "x", rationale: "" });
    card.querySelector<HTMLButtonElement>(".approve")!.click();
    doc.path = "/d/b.md";
    parkedApprove[0].resolve();
    await settle();
    expect(parkedApprove[0].params.docPath).toBe("/d/a.md");
    expect(deps.reloadActiveDoc).not.toHaveBeenCalled();
  });
});

describe("M35: proposal cards", () => {
  it("Approve and Reject on an inline card disable together", () => {
    const { proposals } = setup();
    const card = proposals.buildProposalWidget({ id: "c0001#p1", threadId: "c0001", newText: "x", rationale: "" });
    card.querySelector<HTMLButtonElement>(".approve")!.click();
    expect(card.querySelector<HTMLButtonElement>(".approve")!.disabled).toBe(true);
    expect(card.querySelector<HTMLButtonElement>(".reject")!.disabled).toBe(true);
  });

  it("an HTML card is placed outside the annotated link, and its clicks never reach the mark or the link", () => {
    const iframeDoc = document.implementation.createHTMLDocument("");
    iframeDoc.body.innerHTML =
      '<p>See <a href="https://example.com"><span class="had-mark" data-anno="c0001">the old text</span></a> here.</p>';
    const markClick = vi.fn();
    const docClick = vi.fn();
    iframeDoc.querySelector(".had-mark")!.addEventListener("click", markClick);
    iframeDoc.addEventListener("click", docClick);
    const { proposals } = setup({ htmlDoc: iframeDoc });

    proposals.renderProposalHtml({ id: "c0001#p1", threadId: "c0001", rationale: "", edits: [{ oldText: "the old text", newText: "new" }] });
    const card = iframeDoc.querySelector<HTMLElement>("[data-had-proposal]")!;
    expect(card.closest("a, .had-mark")).toBeNull();
    expect(card.previousSibling).toBe(iframeDoc.querySelector("a"));
    for (const b of card.querySelectorAll("button")) b.click();
    card.click();
    expect(markClick).not.toHaveBeenCalled();
    expect(docClick).not.toHaveBeenCalled();
  });
});

describe("L14: locating a proposal that cannot be struck inline", () => {
  it("a directive's fallback card sits after ITS directive, not the first one", () => {
    const { proposals, metas } = setup({ paragraphs: ["Intro [[first]] here.", "Then [[second]] there.", "And [[third]] last."] });
    proposals.renderProposal({ id: "directive-3#p1", threadId: "directive-3", rationale: "", edits: [{ oldText: "not in the doc", newText: "x" }] });
    const fallback = metas.find((m) => m.fallback) as { fallback: { at: number } };
    // Paragraph 3 starts after two paragraphs: "Intro [[first]] here." (21 chars + 2) and
    // "Then [[second]] there." (22 + 2); "[[third]]" ends 13 characters into it.
    expect(fallback.fallback.at).toBe(23 + 24 + 1 + "And [[third]]".length);
  });

  it("an HTML hunk with inline tags is found by its text", () => {
    expect(projectionNeedlesForHtmlHunk("<p>Some <b>bold</b> text</p>")).toContain("Some bold text");
  });

  it("an HTML card for a tagged hunk lands after that passage, not at the end of the document", () => {
    const iframeDoc = document.implementation.createHTMLDocument("");
    iframeDoc.body.innerHTML = "<p>Some <b>bold</b> text</p><p>Unrelated tail.</p>";
    const { proposals } = setup({ htmlDoc: iframeDoc });
    proposals.renderProposalHtml({ id: "c0001#p1", threadId: "c0001", rationale: "", edits: [{ oldText: "<p>Some <b>bold</b> text</p>", newText: "<p>x</p>" }] });
    const card = iframeDoc.querySelector("[data-had-proposal]")!;
    expect(card.parentElement!.textContent).toContain("Some bold text");
    expect(iframeDoc.body.lastElementChild).not.toBe(card);
  });
});
