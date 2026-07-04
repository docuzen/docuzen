import { describe, expect, it } from "vitest";
import { createMcpProxyTool, type McpConnector } from "../../src/agent/mcp-bridge.js";
import type { ResolvedMcpSettings } from "../../src/agent/mcp.js";

type ToolResult = {
  content: { type: string; text?: string }[];
  details?: unknown;
};

type ExecutableTool = {
  name: string;
  execute: (toolCallId: string, params: Record<string, unknown>) => Promise<ToolResult>;
};

function asExecutable(tool: unknown): ExecutableTool {
  return tool as ExecutableTool;
}

function text(result: ToolResult): string {
  return result.content.map((part) => part.text ?? "").join("\n");
}

function resolvedDocs(tools: string[]): ResolvedMcpSettings {
  return {
    servers: {
      docs: {
        transport: "stdio",
        command: "node",
        args: ["docs-mcp.js"],
        tools,
      },
    },
    readToolNames: tools.filter((name) => name !== "docs_write"),
    writeToolNames: tools.includes("docs_write") ? ["docs_write"] : [],
  };
}

describe("MCP bridge proxy tool", () => {
  it("calls an allowlisted MCP tool through the configured server", async () => {
    const calls: unknown[] = [];
    const connector: McpConnector = async (serverName) => ({
      async listTools() {
        return [{ name: "docs_read", description: "Read doc", inputSchema: { type: "object" } }];
      },
      async callTool(name, args) {
        calls.push({ serverName, name, args });
        return { content: [{ type: "text", text: "read ok" }] };
      },
      async close() {},
    });
    const resolved = resolvedDocs(["docs_read"]);
    const tool = asExecutable(createMcpProxyTool(resolved, { connector }));

    const result = await tool.execute("call-1", {
      tool: "docs_read",
      args: '{"path":"guide.md"}',
    });

    expect(text(result)).toContain("read ok");
    expect(calls).toEqual([{ serverName: "docs", name: "docs_read", args: { path: "guide.md" } }]);
  });

  it("blocks tools filtered out by propose-mode safety", async () => {
    const calls: unknown[] = [];
    const connector: McpConnector = async () => ({
      async callTool(name, args) {
        calls.push({ name, args });
        return { content: [{ type: "text", text: "wrote" }] };
      },
      async close() {},
    });
    const resolved = resolvedDocs(["docs_read"]);
    const tool = asExecutable(createMcpProxyTool(resolved, { connector }));

    const result = await tool.execute("call-1", { tool: "docs_write", args: "{}" });

    expect(text(result)).toContain("not allowlisted");
    expect(calls).toEqual([]);
  });

  it("searches live tool metadata but only returns allowlisted tools", async () => {
    const connector: McpConnector = async () => ({
      async listTools() {
        return [
          { name: "docs_read", description: "Read markdown document", inputSchema: { type: "object" } },
          { name: "docs_write", description: "Write canonical document", inputSchema: { type: "object" } },
        ];
      },
      async callTool() {
        throw new Error("should not call");
      },
      async close() {},
    });
    const resolved = resolvedDocs(["docs_read"]);
    const tool = asExecutable(createMcpProxyTool(resolved, { connector }));

    const result = await tool.execute("call-1", { search: "document" });

    expect(text(result)).toContain("docs_read");
    expect(text(result)).not.toContain("docs_write");
  });
});
