import { describe, expect, it } from "vitest";
import { buildCodexPrompt } from "../../src/agent/codex-runner.js";
import type { AgentContext } from "../../src/agent/types.js";

// These tests capture buildCodexPrompt's CURRENT byte-exact output (via vitest
// inline snapshots) BEFORE the pi/codex prompt-fragment overlap (history
// formatting, standing-instructions block) is extracted into shared builders
// in prompt-sections.ts. After the extraction, these same assertions must still
// match byte-for-byte. buildCodexPrompt is a plain module function; it was made
// `export`ed (no behavior change) so it can be called directly here instead of
// only through the codex CLI spawn path.
const base: AgentContext = {
  docText: "# Title\n\nBody text about Redis caching.",
  anchorExact: "Redis caching",
  surrounding: "Body text about Redis caching.",
  comment: "Why Redis here?",
  stancePrompt: "Be a skeptical reviewer.",
  docPath: "/tmp/doc.md",
};

describe("buildCodexPrompt — byte-exact capture (pre-refactor baseline)", () => {
  it("default mode, no optional sections", () => {
    expect(buildCodexPrompt(base)).toMatchInlineSnapshot(`
      "You are running as Docuzen's Codex external harness adapter.
      Use Codex's native capabilities, including its managed web search when useful, but do not claim Docuzen tools are available.
      To propose a document edit, end your reply with exactly ONE fenced \`\`\`json block of shape {"rationale": string, "hunks": [{"oldText": string, "newText": string}, …]} or {"rationale": string, "fullRewrite": string}. oldText must be copied verbatim from the document. Output no other fenced json blocks.

      ## Document
      Path: /tmp/doc.md
      Format: Markdown/body text

      ## Stance
      Be a skeptical reviewer.

      ## Current document text
      # Title

      Body text about Redis caching.

      ## Highlight / local context
      Highlighted text: Redis caching
      Body text about Redis caching.

      ## Reviewer request
      Why Redis here?

      ## Adapter limitations
      Do not edit files. Docuzen will persist only your final reply."
    `);
  });

  it("kitchen sink: history + instructions (padded — codex trims the body, unlike pi)", () => {
    expect(
      buildCodexPrompt({
        ...base,
        instructions: "  Always cite sources.  ",
        history: [
          { role: "you", body: "Do we need Redis for one node?" },
          { role: "agent", body: "No — use an in-memory bucket." },
        ],
      }),
    ).toMatchInlineSnapshot(`
      "You are running as Docuzen's Codex external harness adapter.
      Use Codex's native capabilities, including its managed web search when useful, but do not claim Docuzen tools are available.
      To propose a document edit, end your reply with exactly ONE fenced \`\`\`json block of shape {"rationale": string, "hunks": [{"oldText": string, "newText": string}, …]} or {"rationale": string, "fullRewrite": string}. oldText must be copied verbatim from the document. Output no other fenced json blocks.

      ## Document
      Path: /tmp/doc.md
      Format: Markdown/body text

      ## Stance
      Be a skeptical reviewer.

      ## Standing instructions
      Always cite sources.

      ## Conversation so far
      Reviewer: Do we need Redis for one node?
      Agent: No — use an in-memory bucket.

      ## Current document text
      # Title

      Body text about Redis caching.

      ## Highlight / local context
      Highlighted text: Redis caching
      Body text about Redis caching.

      ## Reviewer request
      Why Redis here?

      ## Adapter limitations
      Do not edit files. Docuzen will persist only your final reply."
    `);
  });

  it("replacementOnly", () => {
    expect(buildCodexPrompt({ ...base, replacementOnly: true })).toMatchInlineSnapshot(`
      "You are running as Docuzen's Codex external harness adapter.
      Use Codex's native capabilities, including its managed web search when useful, but do not claim Docuzen tools are available.
      Docuzen has not exposed propose_edit or add_review_finding tools to Codex yet.

      ## Document
      Path: /tmp/doc.md
      Format: Markdown/body text

      ## Stance
      Be a skeptical reviewer.

      ## Current document text
      # Title

      Body text about Redis caching.

      ## Highlight / local context
      Highlighted text: Redis caching
      Body text about Redis caching.

      ## Reviewer request
      Why Redis here?

      ## Adapter limitations
      This turn wants only the replacement text for the highlighted passage. Reply with the replacement text only.
      Do not edit files. Docuzen will persist only your final reply."
    `);
  });

  it("reviewMode", () => {
    expect(buildCodexPrompt({ ...base, reviewMode: true })).toMatchInlineSnapshot(`
      "You are running as Docuzen's Codex external harness adapter.
      Use Codex's native capabilities, including its managed web search when useful, but do not claim Docuzen tools are available.
      Docuzen has not exposed propose_edit or add_review_finding tools to Codex yet.

      ## Document
      Path: /tmp/doc.md
      Format: Markdown/body text

      ## Stance
      Be a skeptical reviewer.

      ## Current document text
      # Title

      Body text about Redis caching.

      ## Highlight / local context
      Highlighted text: Redis caching
      Body text about Redis caching.

      ## Reviewer request
      Why Redis here?

      ## Adapter limitations
      This turn is a document review. Return concise findings in prose. The Codex adapter cannot yet file Docuzen review annotations directly.
      Do not edit files. Docuzen will persist only your final reply."
    `);
  });

  it("allowEdit", () => {
    expect(buildCodexPrompt({ ...base, allowEdit: true })).toMatchInlineSnapshot(`
      "You are running as Docuzen's Codex external harness adapter.
      Use Codex's native capabilities, including its managed web search when useful, but do not claim Docuzen tools are available.
      To propose a document edit, end your reply with exactly ONE fenced \`\`\`json block of shape {"rationale": string, "hunks": [{"oldText": string, "newText": string}, …]} or {"rationale": string, "fullRewrite": string}. oldText must be copied verbatim from the document. Output no other fenced json blocks.

      ## Document
      Path: /tmp/doc.md
      Format: Markdown/body text

      ## Stance
      Be a skeptical reviewer.

      ## Current document text
      # Title

      Body text about Redis caching.

      ## Highlight / local context
      Highlighted text: Redis caching
      Body text about Redis caching.

      ## Reviewer request
      Why Redis here?

      ## Adapter limitations
      Docuzen direct-edit mode is not enabled for the Codex adapter yet; do not edit files. Describe the change instead."
    `);
  });

  // Phase 10: conversation turns (discuss/reply/panel/branch) get NO edit contract,
  // regardless of settings.agentEdit — see canProposeEdits/AgentContext.conversationOnly.
  it("conversationOnly", () => {
    expect(buildCodexPrompt({ ...base, conversationOnly: true })).toMatchInlineSnapshot(`
      "You are running as Docuzen's Codex external harness adapter.
      Use Codex's native capabilities, including its managed web search when useful, but do not claim Docuzen tools are available.
      Docuzen has not exposed propose_edit or add_review_finding tools to Codex yet.

      ## Document
      Path: /tmp/doc.md
      Format: Markdown/body text

      ## Stance
      Be a skeptical reviewer.

      ## Current document text
      # Title

      Body text about Redis caching.

      ## Highlight / local context
      Highlighted text: Redis caching
      Body text about Redis caching.

      ## Reviewer request
      Why Redis here?

      ## Adapter limitations
      This is a conversation turn: discuss only. Docuzen will not apply or offer for approval any edit you include here, even a fenced \`\`\`json block — it will be shown to the reviewer as plain text, not as a proposal. If the reviewer wants a change made, tell them to use Improve, Resolve, or Review instead.
      Do not edit files. Docuzen will persist only your final reply."
    `);
  });

  it("conversationOnly wins over allowEdit — no contract even when agentEdit was 'direct'", () => {
    const prompt = buildCodexPrompt({ ...base, conversationOnly: true, allowEdit: true });
    expect(prompt).not.toContain("To propose a document edit");
    expect(prompt).toContain("This is a conversation turn: discuss only.");
    expect(prompt).toContain("Docuzen direct-edit mode is not enabled for the Codex adapter yet");
  });

  it("htmlMode, no docPath", () => {
    const { docPath: _docPath, ...rest } = base;
    expect(buildCodexPrompt({ ...rest, htmlMode: true })).toMatchInlineSnapshot(`
      "You are running as Docuzen's Codex external harness adapter.
      Use Codex's native capabilities, including its managed web search when useful, but do not claim Docuzen tools are available.
      To propose a document edit, end your reply with exactly ONE fenced \`\`\`json block of shape {"rationale": string, "hunks": [{"oldText": string, "newText": string}, …]} or {"rationale": string, "fullRewrite": string}. oldText must be copied verbatim from the document. Output no other fenced json blocks.

      ## Document
      Path: unknown
      Format: HTML source

      ## Stance
      Be a skeptical reviewer.

      ## Current document text
      # Title

      Body text about Redis caching.

      ## Highlight / local context
      Highlighted text: Redis caching
      Body text about Redis caching.

      ## Reviewer request
      Why Redis here?

      ## Adapter limitations
      Do not edit files. Docuzen will persist only your final reply."
    `);
  });
});
