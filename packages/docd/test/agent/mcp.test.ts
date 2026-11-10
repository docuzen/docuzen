import { describe, expect, it } from "vitest";
import { DOC_FILES_SERVER, resolveDocToolchain, resolveMcpToolchain } from "../../src/agent/mcp.js";

const opts = { scopeDir: "/docs", launcherAvailable: true };

describe("document toolchain resolver", () => {
  it("selects vetted internal toolchains from the document extension", () => {
    expect(resolveDocToolchain("/docs/plan.html")).toBe("fast-html");
    expect(resolveDocToolchain("/docs/plan.htm")).toBe("fast-html");
    expect(resolveDocToolchain("/docs/plan.md")).toBe("markdown-editor");
    expect(resolveDocToolchain("/docs/plan.markdown")).toBe("markdown-editor");
    expect(resolveDocToolchain("/docs/deck.pptx")).toBe("pptx");
    expect(resolveDocToolchain("/docs/notes.txt")).toBeUndefined();
  });

  it("offers the pinned official filesystem server, confined to the scope dir, for html and markdown", () => {
    for (const toolchain of ["fast-html", "markdown-editor"] as const) {
      const resolved = resolveMcpToolchain(toolchain, opts);
      expect(Object.keys(resolved.servers)).toEqual([DOC_FILES_SERVER]);
      const server = resolved.servers[DOC_FILES_SERVER];
      expect(server.command).toBe("npx");
      // Exact version pin: a new publish must never change what runs without a docuzen release.
      expect(server.args).toEqual(["-y", "@modelcontextprotocol/server-filesystem@2.2.0", "/docs"]);
    }
  });

  it("allowlists only read tools plus a draft edit whose dry-run flag is pinned on", () => {
    const resolved = resolveMcpToolchain("markdown-editor", opts);
    const server = resolved.servers[DOC_FILES_SERVER];
    expect(server.tools).toEqual([
      "read_text_file",
      "read_multiple_files",
      "search_files",
      "list_directory",
      "directory_tree",
      "get_file_info",
      "edit_file",
    ]);
    expect(resolved.readToolNames).toEqual(server.tools);
    expect(server.forcedArgs).toEqual({ edit_file: { dryRun: true } });
    // None of the server's mutating tools may ever be allowlisted.
    for (const mutating of ["write_file", "append_file", "move_file", "copy_file", "create_directory"]) {
      expect(server.tools).not.toContain(mutating);
    }
  });

  it("leaves unknown and future toolchains without MCP servers until implemented", () => {
    expect(resolveMcpToolchain(undefined, opts).servers).toEqual({});
    expect(resolveMcpToolchain("pptx", opts).servers).toEqual({});
  });

  it("offers nothing without a scope dir or when the launcher cannot run", () => {
    expect(resolveMcpToolchain("markdown-editor", { launcherAvailable: true }).servers).toEqual({});
    const noLauncher = resolveMcpToolchain("markdown-editor", { scopeDir: "/docs", launcherAvailable: false });
    expect(noLauncher.servers).toEqual({});
    expect(noLauncher.readToolNames).toEqual([]);
  });
});
