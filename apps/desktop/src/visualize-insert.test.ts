import { describe, expect, it } from "vitest";
import { createAnchor } from "@ai-native-doc/docd/anchor";
import { insertBlockAfterQuote } from "./surface.js";

const BLOCK = "```mermaid\nflowchart TD\n  A-->B\n```";

describe("insertBlockAfterQuote", () => {
  it("inserts after the line containing a plain-text selection (exact match)", () => {
    const markdown = "First paragraph here.\n\nSecond paragraph here.\n";
    // Plain-text projection of "First paragraph here." is identical to the markdown
    const anchor = createAnchor("First paragraph here.\nSecond paragraph here.", 0, 21);
    const result = insertBlockAfterQuote(markdown, anchor, BLOCK);
    // Block must appear before "Second paragraph"
    expect(result.indexOf(BLOCK)).toBeLessThan(result.indexOf("Second paragraph"));
    // Block must appear after "First paragraph"
    expect(result.indexOf(BLOCK)).toBeGreaterThan(result.indexOf("First paragraph"));
  });

  it("inserts after the line when the selection contains inline bold formatting", () => {
    // markdown has **bold** syntax; the projected plain text strips it
    const markdown = "This is **important** text.\n\nNext section.\n";
    // The projection plain text would be "This is important text.\nNext section."
    // anchor.exact = "This is important text." — does NOT appear literally in markdown
    const projText = "This is important text.\nNext section.";
    const anchor = createAnchor(projText, 0, 23); // selects "This is important text."
    const result = insertBlockAfterQuote(markdown, anchor, BLOCK);
    // Block must appear after the bold line, before "Next section"
    expect(result.indexOf(BLOCK)).toBeGreaterThan(result.indexOf("**important**"));
    expect(result.indexOf(BLOCK)).toBeLessThan(result.indexOf("Next section."));
  });

  it("inserts after the selection span when selection crosses paragraph boundary", () => {
    // markdown uses \n\n between paragraphs; projection uses single \n
    const markdown = "Paragraph one.\n\nParagraph two.\n\nParagraph three.\n";
    // Projected text of the first two paragraphs uses single \n
    const projText = "Paragraph one.\nParagraph two.\nParagraph three.";
    // anchor.exact = "Paragraph one.\nParagraph two." — indexOf fails due to \n vs \n\n
    const anchor = createAnchor(projText, 0, 29);
    const result = insertBlockAfterQuote(markdown, anchor, BLOCK);
    // Block must appear after "Paragraph two." and before "Paragraph three."
    expect(result.indexOf(BLOCK)).toBeGreaterThan(result.indexOf("Paragraph two."));
    expect(result.indexOf(BLOCK)).toBeLessThan(result.indexOf("Paragraph three."));
  });

  it("falls back to document end when anchor does not resolve in markdown", () => {
    const markdown = "Some unrelated content.\n";
    // An anchor whose exact text has nothing to do with the markdown
    const anchor = createAnchor("totally different corpus text", 0, 10);
    const result = insertBlockAfterQuote(markdown, anchor, BLOCK);
    // Block must appear at the end (after all document content)
    expect(result.indexOf(BLOCK)).toBeGreaterThan(result.indexOf("unrelated content."));
    expect(result.endsWith(BLOCK + "\n") || result.endsWith(BLOCK)).toBe(true);
  });

  it("legacy: inserts correctly for simple plain-text single paragraph (regression guard)", () => {
    const markdown = "Intro line.\n\nBody text.\n\nConclusion.\n";
    const projText = "Intro line.\nBody text.\nConclusion.";
    const anchor = createAnchor(projText, 13, 22); // "Body text."
    const result = insertBlockAfterQuote(markdown, anchor, BLOCK);
    expect(result.indexOf(BLOCK)).toBeGreaterThan(result.indexOf("Body text."));
    expect(result.indexOf(BLOCK)).toBeLessThan(result.indexOf("Conclusion."));
  });
});
