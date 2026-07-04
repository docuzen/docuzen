import { describe, expect, it } from "vitest";
import { buildPiSessionOptions, PiRunner } from "../../src/agent/pi-runner.js";
import type { AgentContext } from "../../src/agent/types.js";

function firstPrompt(ctx: AgentContext): string {
  return (Object.create(PiRunner.prototype) as { firstPrompt(ctx: AgentContext): string })
    .firstPrompt(ctx);
}

describe("PiRunner replacement-only prompt", () => {
  it("uses prior discussion as context for Improve instead of asking for a chat reply", () => {
    const prompt = firstPrompt({
      docText: "We store limits in Redis with a TTL.",
      anchorExact: "Redis",
      surrounding: "limits in Redis with a TTL",
      comment:
        "Use the conversation so far to rewrite the highlighted passage around the single-node token bucket conclusion.",
      stancePrompt: "",
      replacementOnly: true,
      history: [
        { role: "you", body: "We only run one node; should this still say Redis?" },
        {
          role: "agent",
          body: "Redis is for multi-node sharing; for one node, use an in-memory token bucket.",
        },
      ],
    });

    expect(prompt).toContain("## Conversation so far");
    expect(prompt).toContain("We only run one node");
    expect(prompt).toContain("in-memory token bucket");
    expect(prompt).toContain("Use the conversation so far");
    expect(prompt).toContain("replacement text for the highlighted passage");
    expect(prompt).not.toContain("Respond to their comment");
  });
});

// Phase 10: conversation turns (discuss/reply/panel/branch) must never promise or
// instruct an edit, regardless of settings.agentEdit — see AgentContext.conversationOnly.
describe("PiRunner conversationOnly prompt narration", () => {
  const base: AgentContext = {
    docText: "We store limits in Redis with a TTL.",
    anchorExact: "Redis",
    surrounding: "limits in Redis with a TTL",
    comment: "Why Redis?",
    stancePrompt: "",
  };

  it("never mentions propose_edit or a direct-edit tool for a conversation turn", () => {
    const prompt = firstPrompt({ ...base, conversationOnly: true });
    expect(prompt).not.toContain("propose_edit");
    expect(prompt).not.toContain("edit/write tools");
    expect(prompt).toContain("no edit or edit-proposal tools");
    expect(prompt).toContain("Respond to their comment");
  });

  it("conversationOnly wins over allowEdit — no direct-edit instruction even when agentEdit was 'direct'", () => {
    const prompt = firstPrompt({ ...base, conversationOnly: true, allowEdit: true });
    expect(prompt).not.toContain("edit the document file directly");
    expect(prompt).toContain("no edit or edit-proposal tools");
  });

  it("gives conversation-specific MCP guidance instead of the propose/direct-edit phrasing", () => {
    const prompt = firstPrompt({
      ...base,
      conversationOnly: true,
      docToolchain: "fast-html",
    });
    expect(prompt).toContain("This is a conversation turn");
    expect(prompt).not.toContain("call propose_edit/add_review_finding unless direct-edit mode");
  });
});

describe("PiRunner MCP config construction", () => {
  it("tells the agent to use the MCP proxy tool for an internally selected document toolchain", () => {
    const prompt = firstPrompt({
      docText: "Use HTML helpers.",
      anchorExact: "HTML",
      surrounding: "Use HTML helpers.",
      comment: "Check the source.",
      stancePrompt: "",
      htmlMode: true,
      docToolchain: "fast-html",
    });

    expect(prompt).toContain("Docuzen selected an internal document toolchain for this file");
    expect(prompt).toContain("Use the mcp tool when it is available to search, describe, and call allowlisted document tools");
    expect(prompt).toContain("only read-only or patch-draft MCP tools are allowlisted");
  });

  it("does not mention MCP when no document toolchain has an implemented MCP server", () => {
    const prompt = firstPrompt({
      docText: "Plain text.",
      anchorExact: "text",
      surrounding: "Plain text.",
      comment: "Check this.",
      stancePrompt: "",
    });

    expect(prompt).not.toContain("MCP tool safety");
    expect(prompt).not.toContain("document toolchain");
  });

  it("passes resolved MCP servers and read-safe tool names into the pi session options", () => {
    const options = buildPiSessionOptions({
      cwd: "/tmp/doc",
      model: {},
      sessionManager: {},
      authStorage: {},
      modelRegistry: {},
      tools: ["read", "propose_edit", "fast_html_read"],
      customTools: [],
      mcpServers: {
        "fast-html": {
          transport: "stdio",
          command: "npx",
          args: ["-y", "@docuzen/fast-html-mcp"],
          tools: ["fast_html_read"],
        },
      },
    });

    expect(options.tools).toEqual(["read", "propose_edit", "fast_html_read"]);
    expect((options as { mcpServers?: unknown }).mcpServers).toEqual({
      "fast-html": {
        transport: "stdio",
        command: "npx",
        args: ["-y", "@docuzen/fast-html-mcp"],
        tools: ["fast_html_read"],
      },
    });
  });
});
