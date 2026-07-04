import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const indexSource = readFileSync(new URL("../index.html", import.meta.url), "utf8");
// The search PluginKey + plugin registration moved to editor.ts, and the search
// panel/refresh logic moved wholesale to surface.ts, in the frontend split.
// Assertion semantics are unchanged; only the source files moved.
const editorSource = readFileSync(new URL("./editor.ts", import.meta.url), "utf8");
const searchSurfaceSource = readFileSync(new URL("./surface.ts", import.meta.url), "utf8");
const stylesSource = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
// html-surface.ts (the HTML iframe surface class) — unrelated to, and unmoved by,
// the search extraction above; kept under its pre-existing name.
const surfaceSource = readFileSync(new URL("./html-surface.ts", import.meta.url), "utf8");

describe("document search UI wiring", () => {
  it("exposes search from the top bar and keyboard help", () => {
    expect(indexSource).toContain('id="searchBtn"');
    expect(indexSource).toContain('id="searchPanel"');
    expect(indexSource).toContain('id="searchInput"');
    expect(indexSource).toContain("<kbd>⌘F</kbd>");
  });

  it("uses non-persistent markdown decorations and iframe spans for matches", () => {
    expect(editorSource).toContain('new PluginKey("doc-search")');
    expect(editorSource).toContain(".use(searchPlugin)");
    expect(searchSurfaceSource).toContain("data-had-search");
    expect(searchSurfaceSource).toContain("function refreshHtmlSearch");
  });

  it("styles search matches distinctly and strips iframe search spans on save", () => {
    expect(stylesSource).toContain(".had-search-match");
    expect(stylesSource).toContain(".had-search-match.active");
    expect(surfaceSource).toContain("[data-had-search]");
  });
});
