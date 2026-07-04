import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { buildHtmlSnippetPreviewSrcdoc } from "./html-snippet-preview.js";

const mainSource = readFileSync(new URL("./main.ts", import.meta.url), "utf8");
// renderTurn/chatTurn/streamingAgentTurn/beginEditBranch/runImprove moved to chat.ts
// in the frontend split. Assertion semantics are unchanged; only the source file
// moved (renderPreviewText/rawPreviewText themselves stay in main.ts, so those
// slices are untouched below).
const chatSource = readFileSync(new URL("./chat.ts", import.meta.url), "utf8");
// buildProposalWidget/buildHtmlProposalCard moved to proposals.ts in the frontend
// split.
const proposalsSource = readFileSync(new URL("./proposals.ts", import.meta.url), "utf8");
const stylesSource = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
const helperUrl = new URL("./html-snippet-preview.ts", import.meta.url);
const helperSource = existsSync(helperUrl) ? readFileSync(helperUrl, "utf8") : "";

function sourceBetween(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return source.slice(startIndex, endIndex);
}

describe("HTML snippet previews", () => {
  it("builds sandboxed previews from the active HTML document style context", () => {
    expect(helperSource).toContain("export function htmlPreviewSnippet");
    expect(helperSource).toContain('link[rel~="stylesheet"]');
    expect(helperSource).toContain("style:not([data-had-overlay])");
    expect(helperSource).toContain("<base href=");
    expect(helperSource).toContain('setAttribute("sandbox", "")');
    expect(helperSource).not.toContain("allow-scripts");
  });

  it("renders agent chat turns through the optional HTML preview path", () => {
    const renderTurnSource = sourceBetween(
      chatSource,
      "function renderTurn(",
      "function chatTurn(",
    );
    expect(renderTurnSource).toContain("renderTurnText(b, role, text)");

    const streamingSource = sourceBetween(
      chatSource,
      "function streamingAgentTurn(",
      "function beginEditBranch(",
    );
    expect(streamingSource).toContain('let replyText = ""');
    expect(streamingSource).toContain('renderTurnText(body, "agent", replyText)');
  });

  it("renders proposal previews while preserving the raw proposed text for apply", () => {
    const improveSource = sourceBetween(
      chatSource,
      "async function runImprove",
      "chatImproveEl.addEventListener",
    );
    expect(improveSource).toContain('let proposedText = ""');
    expect(improveSource).toContain("renderPreviewText(pnew, proposedText)");
    expect(improveSource).toContain("rawPreviewText(pnew)");

    const proposalSource = sourceBetween(
      proposalsSource,
      "function buildProposalWidget(",
      "function renderProposal(p: ProposalView)",
    );
    expect(proposalSource).toContain("renderPreviewText(add, p.newText)");
    expect(proposalSource).toContain("renderPreviewText(newEl, edit.newText)");

    const htmlProposalSource = sourceBetween(
      proposalsSource,
      "function buildHtmlProposalCard(",
      "function renderProposalHtml(p: ProposalView)",
    );
    expect(htmlProposalSource).toContain("renderPreviewText(nw, e.newText,");
  });

  it("styles previews as embedded iframes with an expandable raw fallback", () => {
    expect(stylesSource).toContain(".html-snippet-frame");
    expect(stylesSource).toContain(".html-snippet-raw");

    const frameStyleSource = sourceBetween(stylesSource, ".html-snippet-frame", ".html-snippet-raw");
    expect(frameStyleSource).not.toContain("background: #fff");

    const renderPreviewSource = sourceBetween(
      mainSource,
      "function renderPreviewText(",
      "function rawPreviewText(",
    );
    expect(renderPreviewSource).not.toContain("background:#fff");
  });

  it("carries the active document body color context into the preview iframe", () => {
    const context = {
      headHtml: "",
      htmlAttrs: ' class="theme-dark"',
      bodyAttrs: ' class="dark-doc"',
      colorContextCss:
        ":root { --doc-bg: #101010; --doc-fg: #f5f5f5; }\n" +
        "body { background: #101010; color: #f5f5f5; font-family: Inter, sans-serif; }",
    };

    const srcdoc = buildHtmlSnippetPreviewSrcdoc("<p>Readable in dark preview</p>", context);

    expect(srcdoc).toContain('<html class="theme-dark">');
    expect(srcdoc).toContain(
      "body { background: #101010; color: #f5f5f5; font-family: Inter, sans-serif; }",
    );
    expect(srcdoc).toContain('<body class="dark-doc"><main class="had-snippet-root">');
  });
});
