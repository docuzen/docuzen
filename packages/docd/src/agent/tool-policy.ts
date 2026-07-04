import type { AgentContext } from "./types.js";

export const READ_ONLY_TOOLS = ["read", "grep", "ls", "find"];
export const EDIT_TOOLS = ["read", "grep", "ls", "find", "edit", "write"];

export interface ToolPolicy {
  /** Built-in pi tool allowlist for the session (also gates custom tools). */
  tools: string[];
  /** Whether to register the custom propose_edit tool for this session. */
  offerProposeEdit: boolean;
  /** Whether to register the custom add_review_finding tool (document-wide review pass). */
  offerReviewFinding: boolean;
  /** Whether to register the custom validate_html tool for HTML-source turns. */
  offerValidateHtml: boolean;
  /** Whether to register the custom web_search + web_fetch tools. */
  offerWebTools: boolean;
  /** Whether to register the custom MCP proxy tool for this session. */
  offerMcpTool: boolean;
}

export interface McpToolPolicyInput {
  /** Read-only or draft-producing MCP tools; safe in propose/review modes. */
  readToolNames?: string[];
  /** Canonical-writing MCP tools; only safe in direct-edit mode. */
  writeToolNames?: string[];
  /** Proxy custom tool name to expose when MCP servers are configured. */
  proxyToolName?: string;
}

/**
 * Decide a session's tools from the context's edit mode. Exactly one mode applies,
 * and the custom tools exist in exactly one of them — registering one elsewhere gives
 * the agent contradictory instructions (e.g. "edit directly" AND "call propose_edit"):
 *
 * - reviewMode (Review pass): read-only tools + add_review_finding — emit anchored findings.
 * - replacementOnly (Markdown Improve): read-only tools, no custom tools — reply with the rewrite.
 * - improveMode + htmlMode: default proposal mode — raw-source edit + validate_html.
 * - conversationOnly (discuss/reply/panel/branch — Phase 10): read-only tools, no custom
 *   tools — discuss only. Wins over `allowEdit`: conversation turns never edit or propose
 *   an edit, regardless of `settings.agentEdit` (see AgentContext.conversationOnly).
 * - allowEdit (direct):        edit/write tools, no custom tools — edit the file directly.
 * - else (propose, default):   read-only tools + propose_edit — propose edits for review.
 *
 * `configured` (PiConfig.tools) overrides the built-in list in the non-Improve modes.
 */
export function toolPolicy(
  ctx: AgentContext,
  configured?: string[],
  mcpTools: McpToolPolicyInput = {},
): ToolPolicy {
  // Web tools are available in every mode except Improve (replacement-only stays minimal).
  const offerWebTools = !!ctx.webSearch?.enabled && !ctx.replacementOnly;
  const offerValidateHtml = !!ctx.htmlMode && !ctx.replacementOnly;
  const offerMcpTool = !!mcpTools.proxyToolName && !ctx.replacementOnly;
  const readMcpTools = mcpTools.readToolNames ?? [];
  const writeMcpTools = mcpTools.writeToolNames ?? [];
  const withWeb = (tools: string[]): string[] =>
    offerWebTools ? [...tools, "web_search", "web_fetch"] : tools;
  const withHtml = (tools: string[]): string[] =>
    offerValidateHtml ? [...tools, "validate_html"] : tools;
  const withMcpProxy = (tools: string[]): string[] =>
    offerMcpTool && mcpTools.proxyToolName ? [...tools, mcpTools.proxyToolName] : tools;
  const withReadMcp = (tools: string[]): string[] => [...tools, ...readMcpTools];
  const withWriteMcp = (tools: string[]): string[] => [...tools, ...readMcpTools, ...writeMcpTools];
  const withExtraTools = (tools: string[]): string[] => withReadMcp(withMcpProxy(withHtml(withWeb(tools))));

  if (ctx.reviewMode) {
    return {
      tools: withExtraTools([...(configured ?? READ_ONLY_TOOLS), "add_review_finding"]),
      offerProposeEdit: false,
      offerReviewFinding: true,
      offerValidateHtml,
      offerWebTools,
      offerMcpTool,
    };
  }
  if (ctx.replacementOnly) {
    return {
      tools: [...READ_ONLY_TOOLS],
      offerProposeEdit: false,
      offerReviewFinding: false,
      offerValidateHtml: false,
      offerWebTools: false,
      offerMcpTool: false,
    };
  }
  if (ctx.conversationOnly) {
    // Phase 10: conversation turns (discuss/reply/panel/branch) never edit or propose an
    // edit, regardless of `allowEdit` — checked BEFORE it below so a stray/legacy
    // allowEdit:true on a conversation context can never grant write tools.
    return {
      tools: withExtraTools([...(configured ?? READ_ONLY_TOOLS)]),
      offerProposeEdit: false,
      offerReviewFinding: false,
      offerValidateHtml,
      offerWebTools,
      offerMcpTool,
    };
  }
  if (ctx.allowEdit) {
    return {
      tools: withWriteMcp(withMcpProxy(withHtml(withWeb([...(configured ?? EDIT_TOOLS)])))),
      offerProposeEdit: false,
      offerReviewFinding: false,
      offerValidateHtml,
      offerWebTools,
      offerMcpTool,
    };
  }
  return {
    tools: withExtraTools([...(configured ?? READ_ONLY_TOOLS), "propose_edit"]),
    offerProposeEdit: true,
    offerReviewFinding: false,
    offerValidateHtml,
    offerWebTools,
    offerMcpTool,
  };
}
