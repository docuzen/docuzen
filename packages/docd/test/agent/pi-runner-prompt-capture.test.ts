import { describe, expect, it } from "vitest";
import { PiRunner } from "../../src/agent/pi-runner.js";
import type { AgentContext } from "../../src/agent/types.js";

// These tests capture PiRunner.firstPrompt/reviewPrompt's CURRENT byte-exact output
// (via vitest inline snapshots) BEFORE the pi/codex prompt-fragment overlap (history
// formatting, standing-instructions block) is extracted into shared builders in
// prompt-sections.ts. After the extraction, these same assertions must still match
// byte-for-byte — that is the behavior-preservation gate for the refactor, since
// prompts are not otherwise parity-testable (they hit live LLMs).
//
// Same technique as pi-runner-prompt.test.ts: firstPrompt/reviewPrompt are private
// instance methods that only touch their `ctx` argument (no constructor-built state
// like the model registry), so Object.create(PiRunner.prototype) lets us call them
// directly without constructing a real PiRunner (which requires a configured pi model).
function firstPrompt(ctx: AgentContext): string {
  return (Object.create(PiRunner.prototype) as { firstPrompt(ctx: AgentContext): string })
    .firstPrompt(ctx);
}
function reviewPrompt(ctx: AgentContext): string {
  return (Object.create(PiRunner.prototype) as { reviewPrompt(ctx: AgentContext): string })
    .reviewPrompt(ctx);
}

const base: AgentContext = {
  docText: "# Title\n\nBody text about Redis caching.",
  anchorExact: "Redis caching",
  surrounding: "Body text about Redis caching.",
  comment: "Why Redis here?",
  stancePrompt: "Be a skeptical reviewer.",
};

describe("PiRunner.firstPrompt — byte-exact capture (pre-refactor baseline)", () => {
  it("default propose mode, no optional sections", () => {
    expect(firstPrompt(base)).toMatchInlineSnapshot(`
      "Be a skeptical reviewer.

      You are a focused document reviewer. Discuss the highlighted passage with the reviewer. When you want to change the document, call the \`propose_edit\` tool: pass \`edits\` (each oldText copied VERBATIM from the document with enough context to be unique, plus its newText) for a few localized changes, or \`fullRewrite\` (the complete new body) for a large rewrite. The reviewer approves/rejects it inline. Do NOT paste the edits in your prose. The document is GitHub-flavored Markdown rendered live in a WYSIWYG editor: fenced \`\`\`mermaid blocks render as diagrams (flowchart, sequence, class, state, ER, gantt), GFM tables render as tables, and inline SVG renders as an image. So when a visual would help — a flow, an architecture, a comparison — produce a doc-native \`\`\`mermaid diagram (preferred), a Markdown table, or inline SVG directly in your reply or edit, rather than describing it in prose or referencing an image file. Use your read-only tools (read, grep, ls, find) to consult the rest of the project and the \`.had\` sidecar for other comments when you need more context.

      ## Document
      # Title

      Body text about Redis caching.

      ## Local context around the highlighted passage
      Body text about Redis caching.

      ## The reviewer highlighted
      "Redis caching"

      ## Their comment
      Why Redis here?

      Respond to their comment. Be concise and specific."
    `);
  });

  it("kitchen sink: history + instructions (untrimmed, padded) + surrounding + annotations digest", () => {
    expect(
      firstPrompt({
        ...base,
        instructions: "  Always cite sources.  ",
        annotationsDigest: "Reviewer B flagged the intro as too long.",
        history: [
          { role: "you", body: "Do we need Redis for one node?" },
          { role: "agent", body: "No — use an in-memory bucket." },
        ],
      }),
    ).toMatchInlineSnapshot(`
      "Be a skeptical reviewer.

      You are a focused document reviewer. Discuss the highlighted passage with the reviewer. When you want to change the document, call the \`propose_edit\` tool: pass \`edits\` (each oldText copied VERBATIM from the document with enough context to be unique, plus its newText) for a few localized changes, or \`fullRewrite\` (the complete new body) for a large rewrite. The reviewer approves/rejects it inline. Do NOT paste the edits in your prose. The document is GitHub-flavored Markdown rendered live in a WYSIWYG editor: fenced \`\`\`mermaid blocks render as diagrams (flowchart, sequence, class, state, ER, gantt), GFM tables render as tables, and inline SVG renders as an image. So when a visual would help — a flow, an architecture, a comparison — produce a doc-native \`\`\`mermaid diagram (preferred), a Markdown table, or inline SVG directly in your reply or edit, rather than describing it in prose or referencing an image file. Use your read-only tools (read, grep, ls, find) to consult the rest of the project and the \`.had\` sidecar for other comments when you need more context.

      ## Standing instructions (always apply)
        Always cite sources.  

      ## Document
      # Title

      Body text about Redis caching.

      ## Local context around the highlighted passage
      Body text about Redis caching.

      ## Other highlights & discussions on this document (the reviewer's positioning)
      Reviewer B flagged the intro as too long.

      ## Conversation so far (continue it)
      reviewer: Do we need Redis for one node?
      agent: No — use an in-memory bucket.

      ## The reviewer highlighted
      "Redis caching"

      ## Their comment
      Why Redis here?

      Respond to their comment. Be concise and specific."
    `);
  });

  it("replacementOnly with history", () => {
    expect(
      firstPrompt({
        ...base,
        replacementOnly: true,
        history: [{ role: "you", body: "Make it terser." }],
      }),
    ).toMatchInlineSnapshot(`
      "Be a skeptical reviewer.

      You are a focused document editor. Rewrite the highlighted passage for the reviewer. This is a rewrite request: reply with ONLY the replacement text for the highlighted passage — no commentary. You have no edit or edit-proposal tools here, so put the rewrite directly in your reply. The document is GitHub-flavored Markdown rendered live in a WYSIWYG editor: fenced \`\`\`mermaid blocks render as diagrams (flowchart, sequence, class, state, ER, gantt), GFM tables render as tables, and inline SVG renders as an image. So when a visual would help — a flow, an architecture, a comparison — produce a doc-native \`\`\`mermaid diagram (preferred), a Markdown table, or inline SVG directly in your reply or edit, rather than describing it in prose or referencing an image file. Use your read-only tools (read, grep, ls, find) to consult the rest of the project and the \`.had\` sidecar for other comments when you need more context.

      ## Document
      # Title

      Body text about Redis caching.

      ## Local context around the highlighted passage
      Body text about Redis caching.

      ## Conversation so far (continue it)
      reviewer: Make it terser.

      ## The reviewer highlighted
      "Redis caching"

      ## Rewrite instruction
      Why Redis here?

      Use the conversation so far when it is present, especially the latest reviewer ask and agent response. Do not answer the discussion. Produce only the doc-ready replacement text for the highlighted passage."
    `);
  });

  it("structured improve (improveMode, not replacementOnly)", () => {
    expect(firstPrompt({ ...base, improveMode: true })).toMatchInlineSnapshot(`
      "Be a skeptical reviewer.

      You are a focused document editor. Propose a safe rewrite for the reviewer. This is an Improve rewrite request: call the \`propose_edit\` tool with a focused edit. Do not paste the replacement text or raw HTML in your prose; the reviewer approves the proposal inline. The document is GitHub-flavored Markdown rendered live in a WYSIWYG editor: fenced \`\`\`mermaid blocks render as diagrams (flowchart, sequence, class, state, ER, gantt), GFM tables render as tables, and inline SVG renders as an image. So when a visual would help — a flow, an architecture, a comparison — produce a doc-native \`\`\`mermaid diagram (preferred), a Markdown table, or inline SVG directly in your reply or edit, rather than describing it in prose or referencing an image file. Use your read-only tools (read, grep, ls, find) to consult the rest of the project and the \`.had\` sidecar for other comments when you need more context.

      ## Document
      # Title

      Body text about Redis caching.

      ## Local context around the highlighted passage
      Body text about Redis caching.

      ## The reviewer highlighted
      "Redis caching"

      ## Rewrite instruction
      Why Redis here?

      Use the conversation so far when it is present, especially the latest reviewer ask and agent response. Do not answer the discussion. Call propose_edit with source-safe oldText/newText; do not put the edit itself in prose."
    `);
  });

  it("direct edit mode (allowEdit)", () => {
    expect(firstPrompt({ ...base, allowEdit: true })).toMatchInlineSnapshot(`
      "Be a skeptical reviewer.

      You are a focused document reviewer. Discuss the highlighted passage with the reviewer. When the reviewer asks you to make a change, edit the document file directly using your edit/write tools, then briefly say what you changed. The document is GitHub-flavored Markdown rendered live in a WYSIWYG editor: fenced \`\`\`mermaid blocks render as diagrams (flowchart, sequence, class, state, ER, gantt), GFM tables render as tables, and inline SVG renders as an image. So when a visual would help — a flow, an architecture, a comparison — produce a doc-native \`\`\`mermaid diagram (preferred), a Markdown table, or inline SVG directly in your reply or edit, rather than describing it in prose or referencing an image file. Use your read-only tools (read, grep, ls, find) to consult the rest of the project and the \`.had\` sidecar for other comments when you need more context.

      ## Document
      # Title

      Body text about Redis caching.

      ## Local context around the highlighted passage
      Body text about Redis caching.

      ## The reviewer highlighted
      "Redis caching"

      ## Their comment
      Why Redis here?

      Respond to their comment. Be concise and specific."
    `);
  });

  it("html mode", () => {
    expect(firstPrompt({ ...base, htmlMode: true })).toMatchInlineSnapshot(`
      "Be a skeptical reviewer.

      You are a focused document reviewer. Discuss the highlighted passage with the reviewer. When you want to change the document, call the \`propose_edit\` tool: pass \`edits\` (each oldText copied VERBATIM from the document with enough context to be unique, plus its newText) for a few localized changes, or \`fullRewrite\` (the complete new body) for a large rewrite. The reviewer approves/rejects it inline. Do NOT paste the edits in your prose. This is an HTML document: edit text is raw HTML source, so preserve tags, keep them balanced and properly nested, and use validate_html on candidate HTML before proposing or writing an edit. In conversational replies, use plain text and do not paste raw HTML tags unless explicitly showing code. The document is GitHub-flavored Markdown rendered live in a WYSIWYG editor: fenced \`\`\`mermaid blocks render as diagrams (flowchart, sequence, class, state, ER, gantt), GFM tables render as tables, and inline SVG renders as an image. So when a visual would help — a flow, an architecture, a comparison — produce a doc-native \`\`\`mermaid diagram (preferred), a Markdown table, or inline SVG directly in your reply or edit, rather than describing it in prose or referencing an image file. Use your read-only tools (read, grep, ls, find) to consult the rest of the project and the \`.had\` sidecar for other comments when you need more context.

      ## Document
      # Title

      Body text about Redis caching.

      ## Local context around the highlighted passage
      Body text about Redis caching.

      ## The reviewer highlighted
      "Redis caching"

      ## Their comment
      Why Redis here?

      Respond to their comment. Be concise and specific."
    `);
  });

  it("web search + mcp toolchain enabled", () => {
    expect(
      firstPrompt({
        ...base,
        webSearch: { enabled: true, provider: "brave" },
        htmlMode: true,
        docToolchain: "fast-html",
      }),
    ).toMatchInlineSnapshot(`
      "Be a skeptical reviewer.

      You are a focused document reviewer. Discuss the highlighted passage with the reviewer. When you want to change the document, call the \`propose_edit\` tool: pass \`edits\` (each oldText copied VERBATIM from the document with enough context to be unique, plus its newText) for a few localized changes, or \`fullRewrite\` (the complete new body) for a large rewrite. The reviewer approves/rejects it inline. Do NOT paste the edits in your prose. This is an HTML document: edit text is raw HTML source, so preserve tags, keep them balanced and properly nested, and use validate_html on candidate HTML before proposing or writing an edit. In conversational replies, use plain text and do not paste raw HTML tags unless explicitly showing code. The document is GitHub-flavored Markdown rendered live in a WYSIWYG editor: fenced \`\`\`mermaid blocks render as diagrams (flowchart, sequence, class, state, ER, gantt), GFM tables render as tables, and inline SVG renders as an image. So when a visual would help — a flow, an architecture, a comparison — produce a doc-native \`\`\`mermaid diagram (preferred), a Markdown table, or inline SVG directly in your reply or edit, rather than describing it in prose or referencing an image file. Use your read-only tools (read, grep, ls, find) to consult the rest of the project and the \`.had\` sidecar for other comments when you need more context.

      ## Web search capability
      Web search is enabled for this turn (provider: brave). You can call web_search(query) to find sources and web_fetch(url) to read a result. Use these tools for citations, current facts, external references, and named web resources. If search returns no useful results, say that specifically; do not claim web search is unavailable unless the tool returns a configuration error.

      ## MCP tool safety
      Docuzen selected an internal document toolchain for this file. Use the mcp tool when it is available to search, describe, and call allowlisted document tools. In propose/review modes, only read-only or patch-draft MCP tools are allowlisted; do not use MCP tools to write the canonical document. To change the document, call propose_edit/add_review_finding unless direct-edit mode is explicitly enabled.

      ## Document
      # Title

      Body text about Redis caching.

      ## Local context around the highlighted passage
      Body text about Redis caching.

      ## The reviewer highlighted
      "Redis caching"

      ## Their comment
      Why Redis here?

      Respond to their comment. Be concise and specific."
    `);
  });

  it("dispatches reviewMode to reviewPrompt's exact output", () => {
    const ctx: AgentContext = { ...base, reviewMode: true };
    expect(firstPrompt(ctx)).toBe(reviewPrompt(ctx));
  });
});

describe("PiRunner.reviewPrompt — byte-exact capture (pre-refactor baseline)", () => {
  it("default review, no optional sections", () => {
    expect(reviewPrompt(base)).toMatchInlineSnapshot(`
      "Be a skeptical reviewer.

      You are doing a full review pass over the document below. Read it closely and record each distinct finding by calling the \`add_review_finding\` tool exactly once per finding. For each finding: copy \`anchorText\` VERBATIM from the document (enough surrounding text to be unique), write a concise \`comment\`, set \`severity\` (info|suggestion|issue) and a short \`kind\` (e.g. clarity, risk, correctness, structure). When you have a concrete fix, include \`edits\` (each \`oldText\` copied verbatim plus its \`newText\`) or \`fullRewrite\`. Do NOT edit the document yourself and do NOT paste edits in prose — the reviewer approves edits. Prefer a focused set of high-value findings over many trivial ones. Use your read-only tools to consult the project and the \`.had\` sidecar when you need more context.

      ## Review focus
      Why Redis here?

      ## Document
      # Title

      Body text about Redis caching.

      Now record your findings with add_review_finding."
    `);
  });

  it("with instructions (untrimmed, padded) + annotations digest + html mode", () => {
    expect(
      reviewPrompt({
        ...base,
        instructions: "  Flag passive voice.  ",
        annotationsDigest: "Existing comment thread on paragraph 2.",
        htmlMode: true,
      }),
    ).toMatchInlineSnapshot(`
      "Be a skeptical reviewer.

      You are doing a full review pass over the document below. Read it closely and record each distinct finding by calling the \`add_review_finding\` tool exactly once per finding. For each finding: copy \`anchorText\` VERBATIM from the document (enough surrounding text to be unique), write a concise \`comment\`, set \`severity\` (info|suggestion|issue) and a short \`kind\` (e.g. clarity, risk, correctness, structure). When you have a concrete fix, include \`edits\` (each \`oldText\` copied verbatim plus its \`newText\`) or \`fullRewrite\`. Do NOT edit the document yourself and do NOT paste edits in prose — the reviewer approves edits. Prefer a focused set of high-value findings over many trivial ones. Use your read-only tools to consult the project and the \`.had\` sidecar when you need more context. This is an HTML document: preserve raw HTML source, keep tags balanced and properly nested, and use validate_html on candidate HTML before proposing a fix.

      ## Review focus
      Why Redis here?

      ## Standing instructions (always apply)
        Flag passive voice.  

      ## Document
      # Title

      Body text about Redis caching.

      ## Existing highlights & discussions (do NOT duplicate these)
      Existing comment thread on paragraph 2.

      Now record your findings with add_review_finding."
    `);
  });
});
