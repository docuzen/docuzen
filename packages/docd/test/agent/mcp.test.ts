import { describe, expect, it } from "vitest";
import { resolveDocToolchain, resolveMcpToolchain } from "../../src/agent/mcp.js";

describe("document toolchain resolver", () => {
  it("selects vetted internal toolchains from the document extension", () => {
    expect(resolveDocToolchain("/docs/plan.html")).toBe("fast-html");
    expect(resolveDocToolchain("/docs/plan.htm")).toBe("fast-html");
    expect(resolveDocToolchain("/docs/plan.md")).toBe("markdown-editor");
    expect(resolveDocToolchain("/docs/plan.markdown")).toBe("markdown-editor");
    expect(resolveDocToolchain("/docs/deck.pptx")).toBe("pptx");
    expect(resolveDocToolchain("/docs/notes.txt")).toBeUndefined();
  });

  it("adds the fast-html MCP server only for the HTML toolchain", () => {
    const markdown = resolveMcpToolchain("markdown-editor", { allowWrite: false });
    expect(markdown.servers).not.toHaveProperty("fast-html");

    const html = resolveMcpToolchain("fast-html", { allowWrite: false });
    expect(Object.keys(html.servers)).toEqual(["fast-html"]);
    expect(html.readToolNames).toEqual(expect.arrayContaining(["fast_html_read", "fast_html_patch_draft"]));
  });

  it("adds the markdown-editor MCP server only for markdown documents", () => {
    const html = resolveMcpToolchain("fast-html", { allowWrite: false });
    expect(html.servers).not.toHaveProperty("markdown-editor");

    const markdown = resolveMcpToolchain("markdown-editor", { allowWrite: false });
    expect(Object.keys(markdown.servers)).toEqual(["markdown-editor"]);
    expect(markdown.readToolNames).toEqual(
      expect.arrayContaining(["markdown_editor_read", "markdown_editor_patch_draft"]),
    );
  });

  it("leaves unknown and future toolchains without MCP servers until implemented", () => {
    expect(resolveMcpToolchain(undefined, { allowWrite: false }).servers).toEqual({});
    expect(resolveMcpToolchain("pptx", { allowWrite: false }).servers).toEqual({});
  });

  it("filters canonical-write tools unless direct edit is enabled", () => {
    const propose = resolveMcpToolchain("markdown-editor", { allowWrite: false });

    expect(propose.servers["markdown-editor"].tools).toEqual([
      "markdown_editor_read",
      "markdown_editor_query",
      "markdown_editor_patch_draft",
    ]);
    expect(propose.readToolNames).toEqual([
      "markdown_editor_read",
      "markdown_editor_query",
      "markdown_editor_patch_draft",
    ]);
    expect(propose.writeToolNames).toEqual([]);

    const direct = resolveMcpToolchain("markdown-editor", { allowWrite: true });

    expect(direct.servers["markdown-editor"].tools).toEqual([
      "markdown_editor_read",
      "markdown_editor_query",
      "markdown_editor_patch_draft",
      "markdown_editor_write",
    ]);
    expect(direct.writeToolNames).toEqual(["markdown_editor_write"]);
  });
});
