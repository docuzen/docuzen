import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

// addCommentCard/registerBranchEntry/setCommentActionState moved to chat.ts in the
// frontend split. Assertion semantics are unchanged; only the source file moved.
const chatSource = readFileSync(new URL("./chat.ts", import.meta.url), "utf8");

function sourceBetween(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return source.slice(startIndex, endIndex);
}

describe("agent retry/open UX", () => {
  const cardSource = sourceBetween(
    chatSource,
    "function addCommentCard(",
    "function registerBranchEntry",
  );

  it("opens a comment card in the chat pane with a single click", () => {
    expect(cardSource).toContain('card.addEventListener("click",');
    expect(cardSource).toContain("void promoteToChat(id)");
  });

  it("does not render a separate Open button on comment cards", () => {
    expect(cardSource).not.toContain('class="promote"');
    expect(cardSource).not.toContain(">Open</button>");
  });

  it("keeps failed discussions actionable as Retry", () => {
    expect(chatSource).toContain('discussBtn.textContent = "Retry"');
    expect(cardSource).toContain("setCommentActionState");
  });
});
