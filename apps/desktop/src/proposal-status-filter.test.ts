import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

// Regression pin for the "stuck approved proposal card" bug: listProposals returns
// EVERY proposal for a doc regardless of status (packages/docd/src/had/proposals.ts's
// listProposals does no filtering — see that file), so the load path is the only place
// that keeps an already-resolved proposal from rendering an actionable card again on
// reload/tab-switch. Both the markdown load path (shell.ts's activateTab) and the HTML
// load path (surface.ts's onHtmlReady) must skip any non-pending proposal BEFORE doing
// anything else with it (including the full-rewrite "pending full rewrite —" chat
// affordance and the inline/overlay card renderers) — a filter placed after either
// branch would still resurrect an approved/rejected proposal as clickable.
//
// This is a source-pin test (repo pattern — see agent-retry-ux.test.ts's file header):
// this package's vitest setup has no DOM, so shell.ts/surface.ts aren't executed here;
// instead we assert on their source text directly.

const shellSource = readFileSync(new URL("./shell.ts", import.meta.url), "utf8");
const surfaceSource = readFileSync(new URL("./surface.ts", import.meta.url), "utf8");

function sourceBetween(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return source.slice(startIndex, endIndex);
}

describe("shell.ts activateTab — proposal load-path status filter", () => {
  const proposalsBlock = sourceBetween(
    shellSource,
    "const props = await deps.api.listProposals({ docPath: tab.docPath });",
    "resetDocumentViewport();",
  );

  it("skips any non-pending proposal before rendering it in any form", () => {
    expect(proposalsBlock).toContain('if (p.status !== "pending") continue;');
    // the guard must come BEFORE both the full-rewrite chat affordance and the inline
    // renderer, not after — otherwise an approved/rejected proposal still renders once
    // before being (or without ever being) filtered.
    const guardAt = proposalsBlock.indexOf('if (p.status !== "pending") continue;');
    const fullRewriteAt = proposalsBlock.indexOf("deps.chatTurnWithAction(");
    const inlineAt = proposalsBlock.indexOf("deps.renderProposal(");
    expect(guardAt).toBeGreaterThanOrEqual(0);
    expect(guardAt).toBeLessThan(fullRewriteAt);
    expect(guardAt).toBeLessThan(inlineAt);
  });
});

describe("surface.ts onHtmlReady — proposal load-path status filter", () => {
  const proposalsBlock = sourceBetween(
    surfaceSource,
    "const props = await deps.api.listProposals({ docPath });",
    "} catch (e) {\n      reportError(\"load html proposals\", e, deps.log);",
  );

  it("skips any non-pending proposal before rendering it in any form", () => {
    expect(proposalsBlock).toContain('if (p.status !== "pending") continue;');
    const guardAt = proposalsBlock.indexOf('if (p.status !== "pending") continue;');
    const fullRewriteAt = proposalsBlock.indexOf("deps.chatTurnWithAction(");
    const inlineAt = proposalsBlock.indexOf("deps.renderProposalHtml(");
    expect(guardAt).toBeGreaterThanOrEqual(0);
    expect(guardAt).toBeLessThan(fullRewriteAt);
    expect(guardAt).toBeLessThan(inlineAt);
  });
});
