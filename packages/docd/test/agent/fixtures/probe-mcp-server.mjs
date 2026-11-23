// A tiny stdio MCP server for mcp-bridge tests: `env` returns the environment the server
// was started with; `hang` never answers (a stuck tool call).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const server = new McpServer({ name: "probe", version: "0.0.0" });
server.registerTool("env", { description: "The server's environment" }, async () => ({
  content: [{ type: "text", text: JSON.stringify(process.env) }],
}));
server.registerTool("hang", { description: "Never answers" }, () => new Promise(() => {}));
await server.connect(new StdioServerTransport());
