import { spawnSync } from "node:child_process";
import { extname } from "node:path";
import { isHtmlDoc } from "../had/doc-format.js";

export type McpTransport = "stdio" | "http" | "sse";
/**
 * "read" tools never mutate anything. "draft" tools can produce a patch/diff but must not
 * mutate the canonical doc — enforced by `forcedArgs` (see below), not by trusting the model.
 * There is deliberately no "write" class: every document change goes through a reviewable
 * proposal (propose_edit / add_review_finding), never through an MCP tool.
 */
export type McpToolSafety = "read" | "draft";
export type DocToolchain = "fast-html" | "markdown-editor" | "pptx";

interface McpServerDefinition {
  transport: McpTransport;
  /** stdio transport command. */
  command?: string;
  /** stdio transport args. */
  args?: string[];
  /** http/sse transport URL. */
  url?: string;
  /** Environment values for stdio servers; callers should prefer env var names over secrets. */
  env?: Record<string, string>;
  /** Tool allowlist with safety classification. */
  tools: Record<string, McpToolSafety>;
  /**
   * Arguments the bridge overwrites on every call to a tool, whatever the model passed.
   * This is what makes a "draft" tool safe: the server's own preview flag is pinned on.
   */
  forcedArgs?: Record<string, Record<string, unknown>>;
}

export interface PiMcpServerConfig {
  transport: McpTransport;
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  /** Tool names allowlisted for this Docuzen session after safety filtering. */
  tools?: string[];
  /** Per-tool arguments the bridge pins on every call (see McpServerDefinition.forcedArgs). */
  forcedArgs?: Record<string, Record<string, unknown>>;
}

export interface ResolvedMcpSettings {
  servers: Record<string, PiMcpServerConfig>;
  /** Read-only and draft tool names; all of them are safe in every agent mode. */
  readToolNames: string[];
}

export interface ResolveMcpOptions {
  /**
   * Directory the document tools are confined to (the session's tool scope). The
   * filesystem server refuses every path outside it. Without one, no server is offered.
   */
  scopeDir?: string;
  /**
   * Whether the stdio launcher (`npx`) can be run. Defaults to a cached one-time probe;
   * tests pass it explicitly. When false no server is offered, so the agent is never
   * told about a tool that cannot start (e.g. a packaged app on a machine without Node).
   */
  launcherAvailable?: boolean;
}

/**
 * The official Model Context Protocol filesystem server, pinned to an exact version so a
 * new publish can never change what runs on a user's machine without a docuzen release.
 */
export const DOC_FILES_SERVER = "doc-files";
const FILESYSTEM_SERVER_PACKAGE = "@modelcontextprotocol/server-filesystem@2.2.0";

/**
 * Both document toolchains use the same server: source reads, searches, and a DRAFT edit
 * (`edit_file` with `dryRun` pinned on returns a git-style diff and writes nothing). The
 * server's mutating tools (write_file, append_file, move_file, …) are simply not allowlisted.
 */
function documentFilesPreset(scopeDir: string): Record<string, McpServerDefinition> {
  return {
    [DOC_FILES_SERVER]: {
      transport: "stdio",
      command: "npx",
      args: ["-y", FILESYSTEM_SERVER_PACKAGE, scopeDir],
      tools: {
        read_text_file: "read",
        read_multiple_files: "read",
        search_files: "read",
        list_directory: "read",
        directory_tree: "read",
        get_file_info: "read",
        edit_file: "draft",
      },
      forcedArgs: { edit_file: { dryRun: true } },
    },
  };
}

let launcherProbe: boolean | undefined;
function defaultLauncherAvailable(): boolean {
  if (launcherProbe === undefined) {
    const res = spawnSync("npx", ["--version"], { encoding: "utf8", timeout: 5_000 });
    launcherProbe = !res.error && res.status === 0;
  }
  return launcherProbe;
}

export function resolveDocToolchain(docPath: string | undefined): DocToolchain | undefined {
  if (isHtmlDoc(docPath ?? "")) return "fast-html";
  const ext = extname(docPath ?? "").toLowerCase();
  if (ext === ".md" || ext === ".mdx" || ext === ".markdown") return "markdown-editor";
  if (ext === ".pptx") return "pptx";
  return undefined;
}

function toolchainServers(
  toolchain: DocToolchain | undefined,
  scopeDir: string,
): Record<string, McpServerDefinition> {
  if (toolchain === "fast-html" || toolchain === "markdown-editor") return documentFilesPreset(scopeDir);
  return {}; // "pptx" and unknown types: no vetted server yet
}

export function resolveMcpToolchain(
  toolchain: DocToolchain | undefined,
  options: ResolveMcpOptions = {},
): ResolvedMcpSettings {
  const servers: Record<string, PiMcpServerConfig> = {};
  const readToolNames: string[] = [];
  if (!toolchain || !options.scopeDir) return { servers, readToolNames };
  if (!(options.launcherAvailable ?? defaultLauncherAvailable())) return { servers, readToolNames };

  for (const [name, server] of Object.entries(toolchainServers(toolchain, options.scopeDir))) {
    const tools = Object.keys(server.tools);
    readToolNames.push(...tools);
    servers[name] = {
      transport: server.transport,
      ...(server.command ? { command: server.command } : {}),
      ...(server.args ? { args: server.args } : {}),
      ...(server.url ? { url: server.url } : {}),
      ...(server.env ? { env: server.env } : {}),
      ...(tools.length ? { tools } : {}),
      ...(server.forcedArgs ? { forcedArgs: server.forcedArgs } : {}),
    };
  }
  return { servers, readToolNames };
}
