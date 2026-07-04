import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { PiMcpServerConfig, ResolvedMcpSettings } from "./mcp.js";

type McpContentBlock =
  | { type: "text"; text?: string }
  | { type: "image"; data?: string; mimeType?: string }
  | { type: "resource"; resource?: { uri?: string; text?: string; blob?: string } }
  | { type: "resource_link"; uri?: string; name?: string }
  | { type: "audio"; mimeType?: string };

type PiContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export interface McpCallResult {
  content?: McpContentBlock[];
  isError?: boolean;
}

export interface McpConnection {
  listTools?(): Promise<McpToolInfo[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult>;
  close(): Promise<void>;
}

export type McpConnector = (
  serverName: string,
  server: PiMcpServerConfig,
) => Promise<McpConnection>;

export interface McpProxyOptions {
  connector?: McpConnector;
}

interface ToolLocation {
  serverName: string;
  server: PiMcpServerConfig;
}

function textResult(text: string, details?: Record<string, unknown>): {
  content: PiContentBlock[];
  details: Record<string, unknown> | undefined;
} {
  return {
    content: [{ type: "text" as const, text }],
    details,
  };
}

function toolAllowlist(server: PiMcpServerConfig): Set<string> {
  return new Set(server.tools ?? []);
}

function allToolLocations(resolved: ResolvedMcpSettings): Map<string, ToolLocation[]> {
  const locations = new Map<string, ToolLocation[]>();
  for (const [serverName, server] of Object.entries(resolved.servers)) {
    for (const toolName of toolAllowlist(server)) {
      const existing = locations.get(toolName) ?? [];
      existing.push({ serverName, server });
      locations.set(toolName, existing);
    }
  }
  return locations;
}

function summarizeStatus(resolved: ResolvedMcpSettings): string {
  const names = Object.keys(resolved.servers);
  if (!names.length) return "No MCP servers are enabled for this session.";

  const lines = ["MCP servers configured for this Docuzen session:"];
  for (const name of names) {
    const tools = resolved.servers[name]?.tools ?? [];
    lines.push(`- ${name}: ${tools.length ? tools.join(", ") : "no allowlisted tools"}`);
  }
  return lines.join("\n");
}

function parseArgs(raw: unknown): { ok: true; args: Record<string, unknown> } | { ok: false; error: string } {
  if (raw === undefined) return { ok: true, args: {} };
  if (typeof raw === "string") {
    try {
      const parsed = raw.trim() ? JSON.parse(raw) : {};
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        const got = Array.isArray(parsed) ? "array" : parsed === null ? "null" : typeof parsed;
        return { ok: false, error: `Invalid args: expected a JSON object, got ${got}.` };
      }
      return { ok: true, args: parsed as Record<string, unknown> };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: `Invalid args JSON: ${message}` };
    }
  }
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return { ok: true, args: raw as Record<string, unknown> };
  }
  return { ok: false, error: "Invalid args: pass a JSON object string." };
}

function resolveToolLocation(
  resolved: ResolvedMcpSettings,
  toolName: string,
  serverName?: string,
): { ok: true; location: ToolLocation } | { ok: false; error: string } {
  if (serverName) {
    const server = resolved.servers[serverName];
    if (!server) return { ok: false, error: `MCP server "${serverName}" is not configured.` };
    if (!toolAllowlist(server).has(toolName)) {
      return {
        ok: false,
        error: `MCP tool "${toolName}" is not allowlisted for server "${serverName}" in this session.`,
      };
    }
    return { ok: true, location: { serverName, server } };
  }

  const locations = allToolLocations(resolved).get(toolName) ?? [];
  if (locations.length === 0) {
    return { ok: false, error: `MCP tool "${toolName}" is not allowlisted in this session.` };
  }
  if (locations.length > 1) {
    return {
      ok: false,
      error: `MCP tool "${toolName}" is available on multiple servers; pass server explicitly.`,
    };
  }
  return { ok: true, location: locations[0] };
}

function contentToText(content: McpContentBlock): string {
  if (content.type === "text") return content.text ?? "";
  if (content.type === "image") return `[Image: ${content.mimeType ?? "image/*"}]`;
  if (content.type === "audio") return `[Audio: ${content.mimeType ?? "audio/*"}]`;
  if (content.type === "resource") {
    const uri = content.resource?.uri ?? "(resource)";
    const body = content.resource?.text ?? content.resource?.blob ?? "";
    return `[Resource: ${uri}]${body ? `\n${body}` : ""}`;
  }
  if (content.type === "resource_link") {
    return `[Resource Link: ${content.name ?? content.uri ?? "resource"}]${content.uri ? `\n${content.uri}` : ""}`;
  }
  return JSON.stringify(content);
}

function normalizeResult(result: McpCallResult): {
  content: PiContentBlock[];
  details: Record<string, unknown>;
} {
  const content: PiContentBlock[] = (result.content ?? []).map((part) => {
    if (part.type === "text") return { type: "text" as const, text: part.text ?? "" };
    if (part.type === "image") {
      return {
        type: "image" as const,
        data: part.data ?? "",
        mimeType: part.mimeType ?? "image/png",
      };
    }
    return { type: "text" as const, text: contentToText(part) };
  });

  return {
    content: content.length ? content : [{ type: "text" as const, text: "(empty result)" }],
    details: { isError: !!result.isError },
  };
}

function formatToolList(serverName: string, tools: McpToolInfo[]): string {
  if (!tools.length) return `No allowlisted MCP tools found for "${serverName}".`;
  return tools
    .map((tool) => {
      const desc = tool.description ? `\n  ${tool.description}` : "";
      return `${tool.name} (server: ${serverName})${desc}`;
    })
    .join("\n");
}

async function withConnection<T>(
  connector: McpConnector,
  serverName: string,
  server: PiMcpServerConfig,
  fn: (connection: McpConnection) => Promise<T>,
): Promise<T> {
  const connection = await connector(serverName, server);
  try {
    return await fn(connection);
  } finally {
    await connection.close().catch(() => {});
  }
}

async function listAllowlistedTools(
  connector: McpConnector,
  serverName: string,
  server: PiMcpServerConfig,
): Promise<McpToolInfo[]> {
  const allowed = toolAllowlist(server);
  if (!allowed.size) return [];

  try {
    return await withConnection(connector, serverName, server, async (connection) => {
      const liveTools = connection.listTools ? await connection.listTools() : [];
      if (!liveTools.length) return [...allowed].map((name) => ({ name }));
      const liveByName = new Map(liveTools.map((tool) => [tool.name, tool]));
      return [...allowed].map((name) => liveByName.get(name) ?? { name });
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return [...allowed].map((name) => ({ name, description: `metadata unavailable: ${message}` }));
  }
}

function matchesSearch(tool: McpToolInfo, query: string): boolean {
  const haystack = `${tool.name} ${tool.description ?? ""}`.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .some((term) => haystack.includes(term));
}

async function searchTools(
  connector: McpConnector,
  resolved: ResolvedMcpSettings,
  query: string,
  serverFilter?: string,
): Promise<string> {
  const lines: string[] = [];
  for (const [serverName, server] of Object.entries(resolved.servers)) {
    if (serverFilter && serverName !== serverFilter) continue;
    const tools = (await listAllowlistedTools(connector, serverName, server)).filter((tool) =>
      matchesSearch(tool, query),
    );
    if (tools.length) lines.push(formatToolList(serverName, tools));
  }
  return lines.length ? lines.join("\n") : "No allowlisted MCP tools matched.";
}

async function describeTool(
  connector: McpConnector,
  resolved: ResolvedMcpSettings,
  toolName: string,
  serverName?: string,
): Promise<string> {
  const location = resolveToolLocation(resolved, toolName, serverName);
  if (!location.ok) return location.error;
  const tools = await listAllowlistedTools(
    connector,
    location.location.serverName,
    location.location.server,
  );
  const tool = tools.find((item) => item.name === toolName) ?? { name: toolName };
  const schema = tool.inputSchema ? `\nParameters:\n${JSON.stringify(tool.inputSchema, null, 2)}` : "";
  return `${tool.name} (server: ${location.location.serverName})${tool.description ? `\n${tool.description}` : ""}${schema}`;
}

function envWithOverrides(env?: Record<string, string>): Record<string, string> {
  const base: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) base[key] = value;
  }
  return { ...base, ...(env ?? {}) };
}

export const defaultMcpConnector: McpConnector = async (_serverName, server) => {
  const client = new Client({ name: "docuzen-mcp-bridge", version: "0.0.0" });
  let transport:
    | StdioClientTransport
    | SSEClientTransport
    | StreamableHTTPClientTransport;

  if (server.transport === "stdio") {
    if (!server.command) throw new Error("stdio MCP server requires command");
    transport = new StdioClientTransport({
      command: server.command,
      args: server.args ?? [],
      env: envWithOverrides(server.env),
    });
  } else {
    if (!server.url) throw new Error(`${server.transport} MCP server requires url`);
    transport =
      server.transport === "sse"
        ? new SSEClientTransport(new URL(server.url))
        : new StreamableHTTPClientTransport(new URL(server.url));
  }

  await client.connect(transport);
  return {
    async listTools() {
      const tools: McpToolInfo[] = [];
      let cursor: string | undefined;
      do {
        const page = await client.listTools(cursor ? { cursor } : undefined);
        tools.push(...(page.tools ?? []));
        cursor = page.nextCursor;
      } while (cursor);
      return tools;
    },
    async callTool(name, args) {
      return (await client.callTool({ name, arguments: args })) as McpCallResult;
    },
    async close() {
      await client.close().catch(() => {});
      await transport.close().catch(() => {});
    },
  };
};

export function createMcpProxyTool(
  resolved: ResolvedMcpSettings,
  options: McpProxyOptions = {},
) {
  const connector = options.connector ?? defaultMcpConnector;
  return defineTool({
    name: "mcp",
    label: "MCP",
    description:
      "Proxy to configured Model Context Protocol servers. Use search/list/describe first, then call allowlisted tools with args as a JSON object string.",
    promptSnippet:
      "mcp(search?, describe?, server?, tool?, args?) — search/list/call allowlisted MCP tools for this document session",
    promptGuidelines: [
      "Use mcp({ search: \"query\" }) to discover allowlisted MCP tools, mcp({ describe: \"tool_name\" }) to inspect parameters, and mcp({ tool: \"tool_name\", args: \"{...}\" }) to call one.",
      "In propose/review modes, only read-only or patch-draft MCP tools are allowlisted. Do not use MCP tools to write the canonical document unless direct-edit mode explicitly exposes that tool.",
    ],
    parameters: Type.Object({
      tool: Type.Optional(Type.String({ description: "Allowlisted MCP tool name to call." })),
      args: Type.Optional(Type.String({ description: "Tool arguments as a JSON object string." })),
      server: Type.Optional(Type.String({ description: "Server name for listing or disambiguating tool calls." })),
      search: Type.Optional(Type.String({ description: "Search allowlisted tools by name or description." })),
      describe: Type.Optional(Type.String({ description: "Show one allowlisted tool's description and JSON schema." })),
      connect: Type.Optional(Type.String({ description: "Probe a configured server and refresh its live tool metadata." })),
    }),
    async execute(_toolCallId, params) {
      const serverName = typeof params.server === "string" ? params.server : undefined;
      if (typeof params.search === "string") {
        return textResult(await searchTools(connector, resolved, params.search, serverName));
      }
      if (typeof params.describe === "string") {
        return textResult(await describeTool(connector, resolved, params.describe, serverName));
      }
      if (typeof params.connect === "string") {
        const server = resolved.servers[params.connect];
        if (!server) return textResult(`MCP server "${params.connect}" is not configured.`);
        const tools = await listAllowlistedTools(connector, params.connect, server);
        return textResult(`Connected to "${params.connect}" (${tools.length} allowlisted tools).`);
      }
      if (serverName && !params.tool) {
        const server = resolved.servers[serverName];
        if (!server) return textResult(`MCP server "${serverName}" is not configured.`);
        return textResult(formatToolList(serverName, await listAllowlistedTools(connector, serverName, server)));
      }
      if (typeof params.tool === "string") {
        const parsed = parseArgs(params.args);
        if (!parsed.ok) return textResult(parsed.error);
        const location = resolveToolLocation(resolved, params.tool, serverName);
        if (!location.ok) return textResult(location.error);
        try {
          return await withConnection(
            connector,
            location.location.serverName,
            location.location.server,
            async (connection) => normalizeResult(await connection.callTool(params.tool as string, parsed.args)),
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return textResult(`MCP tool call failed: ${message}`, { error: "call_failed" });
        }
      }
      return textResult(summarizeStatus(resolved));
    },
  });
}
