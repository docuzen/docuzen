import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

// The selection popover construction/positioning moved to surface.ts in the
// frontend split. Assertion semantics are unchanged; only the source file moved.
import { surfaceSource } from "./module-source.test-support.js";
const stylesSource = readFileSync(new URL("./styles.css", import.meta.url), "utf8");

function sourceBetween(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return source.slice(startIndex, endIndex);
}

describe("selection popover layout", () => {
  it("sections the toolbar into a swatch/comment row and a wrapped quick-action row", () => {
    // End boundary: surface.ts's own "end selection popover" marker comment (see
    // that file), since the following section (proposals.ts's content) no longer
    // lives in the same file.
    const construction = sourceBetween(
      surfaceSource,
      "popover.addEventListener",
      "// --- end selection popover / quick actions ---",
    );
    const popoverCss = sourceBetween(stylesSource, ".popover {", "/* --- mermaid diagrams --- */");

    expect(construction).toContain('popTop.className = "poptop"');
    expect(construction).toContain("popTop.appendChild");
    expect(construction).toContain("popover.appendChild(popTop)");
    expect(construction).toContain("popover.appendChild(popActions)");
    expect(popoverCss).toContain(".popover .poptop");
    expect(popoverCss).toContain("flex-direction: column");
    expect(popoverCss).toContain("max-width: min(24rem, calc(100vw - 1rem))");
    expect(popoverCss).toContain("flex: 1 1 auto");
  });

  it("positions from measured size and clamps horizontally inside the viewport", () => {
    const updatePopover = sourceBetween(
      surfaceSource,
      "function updatePopover(): void {",
      "document.addEventListener",
    );

    expect(updatePopover).toContain("popover.offsetWidth");
    expect(updatePopover).toContain("popover.offsetHeight");
    expect(updatePopover).toContain("Math.min");
    expect(updatePopover).toContain("Math.max");
    expect(updatePopover).toContain("window.innerWidth");
    expect(updatePopover).not.toContain("rect.top - 44");
  });
});

// Bubble cleanup — when a streamed turn completes and the persisted reply differs
// from the accumulated stream text (e.g. Codex's trailing fenced-json edit block,
// stripped server-side into turn.proposal), re-render the bubble from the persisted
// reply. chat.ts's discuss/reply/panel flows get this fix (see agents-panel.test.ts);
// Brainstorm is the same discuss()-based shape (bubble.done() after a discuss() call
// whose RPC result is only `{ ok: boolean }` — see protocol/rpc.ts) and lives here
// in surface.ts, so it needs the identical fetchLastAgentReply round-trip.
describe("Brainstorm's bubble re-renders to the persisted reply on done()", () => {
  it("uses the same shared lastAgentReply round-trip chat.ts uses (one implementation, in ui.ts)", () => {
    expect(surfaceSource).toContain("lastAgentReply(deps.api, deps.getDocPath, threadId)");
  });

  it("runBrainstorm wires fetchLastAgentReply into bubble.done()", () => {
    const runBrainstormSource = sourceBetween(
      surfaceSource,
      "async function runBrainstorm(",
      "/**\n   * Extract a fenced code block",
    );
    expect(runBrainstormSource).toContain("bubble.done(await fetchLastAgentReply(id));");
  });

  it("HtmlSurfaceDeps.streamingAgentTurn's done() type accepts the optional finalText", () => {
    const depsShape = sourceBetween(
      surfaceSource,
      "streamingAgentTurn: (meta?: string) => {",
      "fail: (msg: string) => void;\n  };",
    );
    expect(depsShape).toContain("done: (finalText?: string) => void;");
  });
});
