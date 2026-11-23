import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import {
  createMcpProxyTool,
  defaultMcpConnector,
  type McpConnector,
} from "../../src/agent/mcp-bridge.js";
import type { PiMcpServerConfig, ResolvedMcpSettings } from "../../src/agent/mcp.js";

type ToolResult = {
  content: { type: string; text?: string }[];
  details?: unknown;
};

type ExecutableTool = {
  name: string;
  execute: (toolCallId: string, params: Record<string, unknown>, signal?: AbortSignal) => Promise<ToolResult>;
};

const probeServer = fileURLToPath(new URL("./fixtures/probe-mcp-server.mjs", import.meta.url));

function probe(extra: Partial<PiMcpServerConfig> = {}): PiMcpServerConfig {
  return { transport: "stdio", command: process.execPath, args: [probeServer], tools: ["env", "hang"], ...extra };
}

/** Resolve with the promise's outcome, or reject if it hasn't settled within `ms`. */
function within<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`still pending after ${ms}ms`)), ms)),
  ]);
}

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
    readToolNames: tools,
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

  it("pins a server's forced args over whatever the model passed (draft tools stay drafts)", async () => {
    const calls: { name: string; args: unknown }[] = [];
    const connector: McpConnector = async () => ({
      async callTool(name, args) {
        calls.push({ name, args });
        return { content: [{ type: "text", text: "diff" }] };
      },
      async close() {},
    });
    const resolved = resolvedDocs(["edit_file"]);
    resolved.servers.docs.forcedArgs = { edit_file: { dryRun: true } };
    const tool = asExecutable(createMcpProxyTool(resolved, { connector }));

    await tool.execute("call-1", { tool: "edit_file", args: '{"path":"a.md","dryRun":false}' });

    expect(calls).toEqual([{ name: "edit_file", args: { path: "a.md", dryRun: true } }]);
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

  it("reports a server it could not connect to as a failure, not as connected", async () => {
    const connector: McpConnector = async () => {
      throw new Error("spawn npx ENOENT");
    };
    const tool = asExecutable(createMcpProxyTool(resolvedDocs(["docs_read"]), { connector }));

    const result = await tool.execute("call-1", { connect: "docs" });

    expect(text(result)).not.toMatch(/^Connected/);
    expect(text(result)).toContain('Could not connect to MCP server "docs"');
    expect(text(result)).toContain("spawn npx ENOENT");
  });

  it("Stop ends a stuck MCP call at once and closes its connection", async () => {
    let closed = 0;
    const connector: McpConnector = async () => ({
      callTool: () => new Promise(() => {}), // the server never answers
      async close() {
        closed++;
      },
    });
    const tool = asExecutable(createMcpProxyTool(resolvedDocs(["docs_read"]), { connector }));
    const stop = new AbortController();

    const pending = tool.execute("call-1", { tool: "docs_read", args: "{}" }, stop.signal);
    await new Promise((r) => setTimeout(r, 20));
    stop.abort();

    await expect(within(pending, 1_000)).rejects.toThrow(/aborted/i);
    expect(closed).toBeGreaterThan(0);
  });

  it("does not connect at all when the turn was already stopped", async () => {
    let connects = 0;
    const connector: McpConnector = async () => {
      connects++;
      return { callTool: async () => ({ content: [] }), async close() {} };
    };
    const tool = asExecutable(createMcpProxyTool(resolvedDocs(["docs_read"]), { connector }));
    const stop = new AbortController();
    stop.abort();

    await expect(tool.execute("call-1", { tool: "docs_read", args: "{}" }, stop.signal)).rejects.toThrow(/aborted/i);
    expect(connects).toBe(0);
  });
});

describe("default MCP connector (real stdio server)", () => {
  it("starts a stdio server with only its configured env plus the SDK's safe defaults", async () => {
    process.env.DOCUZEN_TEST_SECRET = "sk-must-not-leak";
    const connection = await defaultMcpConnector("probe", probe({ env: { PROBE_SETTING: "on" } }));
    try {
      const result = await connection.callTool("env", {});
      const first = result.content?.[0];
      const env = JSON.parse(first?.type === "text" ? (first.text ?? "{}") : "{}") as Record<string, string>;
      expect(env.PROBE_SETTING).toBe("on");
      expect(env.PATH).toBe(process.env.PATH);
      expect(env.DOCUZEN_TEST_SECRET).toBeUndefined();
    } finally {
      delete process.env.DOCUZEN_TEST_SECRET;
      await connection.close();
    }
  }, 20_000);

  it("Stop aborts a stuck call on a real server", async () => {
    const resolved: ResolvedMcpSettings = { servers: { probe: probe() }, readToolNames: ["env", "hang"] };
    const tool = asExecutable(createMcpProxyTool(resolved));
    const stop = new AbortController();

    const pending = tool.execute("call-1", { tool: "hang", args: "{}" }, stop.signal);
    await new Promise((r) => setTimeout(r, 1_000)); // connected and waiting on the call
    stop.abort();

    await expect(within(pending, 2_000)).rejects.toThrow(/aborted/i);
  }, 20_000);
});
