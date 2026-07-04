import { extname } from "node:path";
import { isHtmlDoc } from "../had/doc-format.js";

export type McpTransport = "stdio" | "http" | "sse";
export type McpToolSafety = "read" | "draft" | "write";
export type DocToolchain = "fast-html" | "markdown-editor" | "pptx";

interface McpServerDefinition {
  enabled?: boolean;
  transport: McpTransport;
  /** stdio transport command. */
  command?: string;
  /** stdio transport args. */
  args?: string[];
  /** http/sse transport URL. */
  url?: string;
  /** Environment values for stdio servers; callers should prefer env var names over secrets. */
  env?: Record<string, string>;
  /**
   * Tool allowlist with safety classification. "draft" means the tool may create
   * patch/draft output but must not mutate the canonical doc.
   */
  tools?: Record<string, McpToolSafety> | string[];
  description?: string;
}

export interface PiMcpServerConfig {
  transport: McpTransport;
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  /** Tool names allowlisted for this Docuzen session after safety filtering. */
  tools?: string[];
}

export interface ResolvedMcpSettings {
  servers: Record<string, PiMcpServerConfig>;
  readToolNames: string[];
  writeToolNames: string[];
}

interface ResolveMcpOptions {
  allowWrite: boolean;
}

const FAST_HTML_PRESET: Record<string, McpServerDefinition> = {
  "fast-html": {
    enabled: true,
    transport: "stdio",
    command: "npx",
    args: ["-y", "@docuzen/fast-html-mcp"],
    description:
      "Recommended HTML-doc helper MCP: source reads, selector queries, validation, and draft patches.",
    tools: {
      fast_html_read: "read",
      fast_html_query: "read",
      fast_html_validate: "read",
      fast_html_patch_draft: "draft",
      fast_html_write: "write",
    },
  },
};

const MARKDOWN_EDITOR_PRESET: Record<string, McpServerDefinition> = {
  "markdown-editor": {
    enabled: true,
    transport: "stdio",
    command: "npx",
    args: ["-y", "@docuzen/markdown-editor-mcp"],
    description:
      "Recommended Markdown-doc helper MCP: source reads, structural queries, validation, and draft patches.",
    tools: {
      markdown_editor_read: "read",
      markdown_editor_query: "read",
      markdown_editor_patch_draft: "draft",
      markdown_editor_write: "write",
    },
  },
};

function toolEntries(
  tools: McpServerDefinition["tools"],
): [string, McpToolSafety][] {
  if (!tools) return [];
  if (Array.isArray(tools)) return tools.map((name) => [name, "read"]);
  return Object.entries(tools);
}

function toPiServerConfig(server: McpServerDefinition, tools: string[]): PiMcpServerConfig {
  return {
    transport: server.transport,
    ...(server.command ? { command: server.command } : {}),
    ...(server.args ? { args: server.args } : {}),
    ...(server.url ? { url: server.url } : {}),
    ...(server.env ? { env: server.env } : {}),
    ...(tools.length ? { tools } : {}),
  };
}

export function resolveDocToolchain(docPath: string | undefined): DocToolchain | undefined {
  if (isHtmlDoc(docPath ?? "")) return "fast-html";
  const ext = extname(docPath ?? "").toLowerCase();
  if (ext === ".md" || ext === ".mdx" || ext === ".markdown") return "markdown-editor";
  if (ext === ".pptx") return "pptx";
  return undefined;
}

function toolchainServers(toolchain: DocToolchain | undefined): Record<string, McpServerDefinition> {
  if (toolchain === "fast-html") return FAST_HTML_PRESET;
  if (toolchain === "markdown-editor") return MARKDOWN_EDITOR_PRESET;
  return {};
}

export function resolveMcpToolchain(
  toolchain: DocToolchain | undefined,
  options: ResolveMcpOptions,
): ResolvedMcpSettings {
  const allServers = toolchainServers(toolchain);

  const servers: Record<string, PiMcpServerConfig> = {};
  const readToolNames: string[] = [];
  const writeToolNames: string[] = [];

  for (const [name, server] of Object.entries(allServers)) {
    if (server.enabled === false) continue;
    const safeTools: string[] = [];
    for (const [toolName, safety] of toolEntries(server.tools)) {
      if (safety === "write") {
        if (options.allowWrite) {
          safeTools.push(toolName);
          writeToolNames.push(toolName);
        }
      } else {
        safeTools.push(toolName);
        readToolNames.push(toolName);
      }
    }
    servers[name] = toPiServerConfig(server, safeTools);
  }

  return { servers, readToolNames, writeToolNames };
}
