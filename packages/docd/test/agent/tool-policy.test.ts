import { describe, it, expect } from "vitest";
import { toolPolicy, READ_ONLY_TOOLS } from "../../src/agent/tool-policy.js";
import type { AgentContext } from "../../src/agent/types.js";

const base: AgentContext = {
  docText: "",
  anchorExact: "",
  surrounding: "",
  comment: "",
  stancePrompt: "",
};

// Exactly one edit mode per session. propose_edit must exist ONLY in propose mode;
// direct mode edits the file with write tools; Improve replies with raw text.
describe("toolPolicy", () => {
  it("propose mode (default): read-only tools + propose_edit, no write", () => {
    const p = toolPolicy({ ...base });
    expect(p.tools).toContain("read");
    expect(p.tools).toContain("propose_edit");
    expect(p.tools).not.toContain("write");
    expect(p.offerProposeEdit).toBe(true);
  });

  it("direct mode (allowEdit): edit/write tools and NO propose_edit", () => {
    const p = toolPolicy({ ...base, allowEdit: true });
    expect(p.tools).toContain("write");
    expect(p.tools).toContain("edit");
    expect(p.tools).not.toContain("propose_edit");
    expect(p.offerProposeEdit).toBe(false);
  });

  it("replacement-only (Improve): read-only, no propose_edit, no write", () => {
    const p = toolPolicy({ ...base, replacementOnly: true });
    expect(p.tools).toEqual(READ_ONLY_TOOLS);
    expect(p.tools).not.toContain("propose_edit");
    expect(p.offerProposeEdit).toBe(false);
  });

  it("replacementOnly wins over allowEdit (Improve is never an editor)", () => {
    const p = toolPolicy({ ...base, replacementOnly: true, allowEdit: true });
    expect(p.tools).not.toContain("write");
    expect(p.tools).not.toContain("propose_edit");
    expect(p.offerProposeEdit).toBe(false);
  });

  it("honors a configured tool override in non-Improve modes", () => {
    const p = toolPolicy({ ...base, allowEdit: true }, ["read", "bash"]);
    expect(p.tools).toEqual(["read", "bash"]);
    expect(p.offerProposeEdit).toBe(false);
  });

  it("review mode: read-only tools + add_review_finding, no propose_edit or write", () => {
    const p = toolPolicy({ ...base, reviewMode: true });
    expect(p.tools).toContain("read");
    expect(p.tools).toContain("add_review_finding");
    expect(p.tools).not.toContain("propose_edit");
    expect(p.tools).not.toContain("write");
    expect(p.offerReviewFinding).toBe(true);
    expect(p.offerProposeEdit).toBe(false);
  });

  it("review mode wins over propose: add_review_finding replaces propose_edit", () => {
    const p = toolPolicy({ ...base, reviewMode: true, allowEdit: true });
    expect(p.tools).toContain("add_review_finding");
    expect(p.tools).not.toContain("write");
    expect(p.offerReviewFinding).toBe(true);
  });

  it("offers web tools when web search is enabled (propose + review modes)", () => {
    const propose = toolPolicy({ ...base, webSearch: { enabled: true, provider: "ddg" } });
    expect(propose.offerWebTools).toBe(true);
    expect(propose.tools).toEqual(expect.arrayContaining(["web_search", "web_fetch", "propose_edit"]));

    const review = toolPolicy({ ...base, reviewMode: true, webSearch: { enabled: true } });
    expect(review.tools).toEqual(expect.arrayContaining(["web_search", "web_fetch", "add_review_finding"]));
  });

  it("does not offer web tools when disabled or in Improve mode", () => {
    expect(toolPolicy({ ...base }).offerWebTools).toBe(false);
    expect(toolPolicy({ ...base, webSearch: { enabled: false } }).offerWebTools).toBe(false);
    const improve = toolPolicy({ ...base, replacementOnly: true, webSearch: { enabled: true } });
    expect(improve.offerWebTools).toBe(false);
    expect(improve.tools).not.toContain("web_search");
  });

  it("offers validate_html for HTML edit and review contexts", () => {
    const propose = toolPolicy({ ...base, htmlMode: true });
    expect(propose.offerValidateHtml).toBe(true);
    expect(propose.tools).toEqual(expect.arrayContaining(["validate_html", "propose_edit"]));

    const review = toolPolicy({ ...base, htmlMode: true, reviewMode: true });
    expect(review.offerValidateHtml).toBe(true);
    expect(review.tools).toEqual(expect.arrayContaining(["validate_html", "add_review_finding"]));

    const markdown = toolPolicy({ ...base });
    expect(markdown.offerValidateHtml).toBe(false);
    expect(markdown.tools).not.toContain("validate_html");
  });

  it("offers propose_edit and validate_html for structured HTML Improve", () => {
    const p = toolPolicy({ ...base, htmlMode: true, improveMode: true });
    expect(p.offerProposeEdit).toBe(true);
    expect(p.offerValidateHtml).toBe(true);
    expect(p.tools).toEqual(expect.arrayContaining(["propose_edit", "validate_html"]));
    expect(p.tools).not.toContain("write");
  });

  it("allows only read/draft MCP tools in propose mode", () => {
    const p = toolPolicy(
      { ...base },
      undefined,
      {
        readToolNames: ["mcp_html_read", "mcp_html_patch_draft"],
        writeToolNames: ["mcp_html_write"],
        proxyToolName: "mcp",
      },
    );

    expect(p.tools).toEqual(expect.arrayContaining(["mcp_html_read", "mcp_html_patch_draft"]));
    expect(p.tools).toContain("mcp");
    expect(p.tools).not.toContain("mcp_html_write");
    expect(p.tools).not.toContain("write");
    expect(p.offerMcpTool).toBe(true);
  });

  it("allows write-capable MCP tools only in direct edit mode", () => {
    const p = toolPolicy(
      { ...base, allowEdit: true },
      undefined,
      { readToolNames: ["mcp_html_read"], writeToolNames: ["mcp_html_write"], proxyToolName: "mcp" },
    );

    expect(p.tools).toEqual(expect.arrayContaining(["mcp", "mcp_html_read", "mcp_html_write", "write"]));
    expect(p.offerMcpTool).toBe(true);
  });

  // Phase 10: conversation turns (discuss/reply/panel/branch) never edit or propose an
  // edit, regardless of `allowEdit` — see AgentContext.conversationOnly.
  it("conversationOnly (discuss/reply/panel): read-only tools, no propose_edit, no write", () => {
    const p = toolPolicy({ ...base, conversationOnly: true });
    expect(p.tools).toEqual(READ_ONLY_TOOLS);
    expect(p.tools).not.toContain("propose_edit");
    expect(p.tools).not.toContain("write");
    expect(p.offerProposeEdit).toBe(false);
    expect(p.offerReviewFinding).toBe(false);
  });

  it("conversationOnly wins over allowEdit — never a direct editor, regardless of settings.agentEdit", () => {
    const p = toolPolicy({ ...base, conversationOnly: true, allowEdit: true });
    expect(p.tools).not.toContain("write");
    expect(p.tools).not.toContain("edit");
    expect(p.tools).not.toContain("propose_edit");
    expect(p.offerProposeEdit).toBe(false);
  });

  it("conversationOnly still offers web/validate_html/MCP-read tools (discussion, not editing, is disabled)", () => {
    const p = toolPolicy(
      { ...base, conversationOnly: true, htmlMode: true, webSearch: { enabled: true, provider: "ddg" } },
      undefined,
      { readToolNames: ["mcp_html_read"], writeToolNames: ["mcp_html_write"], proxyToolName: "mcp" },
    );
    expect(p.tools).toEqual(
      expect.arrayContaining(["web_search", "web_fetch", "validate_html", "mcp", "mcp_html_read"]),
    );
    expect(p.tools).not.toContain("mcp_html_write");
    expect(p.tools).not.toContain("propose_edit");
  });

  it("keeps MCP tools out of replacement-only Improve", () => {
    const p = toolPolicy(
      { ...base, replacementOnly: true },
      undefined,
      { readToolNames: ["mcp_html_read"], writeToolNames: ["mcp_html_write"], proxyToolName: "mcp" },
    );

    expect(p.tools).toEqual(READ_ONLY_TOOLS);
    expect(p.offerMcpTool).toBe(false);
  });
});
