import { describe, expect, it } from "vitest";

// addCommentCard/registerBranchEntry/setCommentActionState live in chat-comment-cards.ts.
// The behaviour itself (click opens the thread; a failed thread offers Retry after a
// reload) is asserted in chat-behaviour.test.ts; these only pin the markup.
import { chatSource } from "./module-source.test-support.js";

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
    expect(cardSource).toContain("deps.onOpen(id);");
  });

  it("does not render a separate Open button on comment cards", () => {
    expect(cardSource).not.toContain('class="promote"');
    expect(cardSource).not.toContain(">Open</button>");
  });

  it("keeps failed discussions actionable as Retry", () => {
    expect(chatSource).toContain('discussBtn.textContent = "Retry"');
    expect(chatSource).toContain('setCommentActionState(entry, "error");');
  });
});
