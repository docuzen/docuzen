import { describe, expect, it } from "vitest";
import { extractCodexProposal } from "../../src/agent/codex-runner.js";

// Parser half of the Codex structured-edit contract (see PROPOSAL_CONTRACT /
// canProposeEdits in codex-runner.ts). buildCodexPrompt asks
// Codex to end its reply with exactly one trailing ```json block; these tests pin
// extractCodexProposal's contract for turning that block into a ProposedEdit.
describe("extractCodexProposal", () => {
  it("parses the contract shape ({rationale, hunks[]}) and strips the block, keeping prose", () => {
    const reply =
      "Here's my rationale for the change.\n\n" +
      '```json\n{"rationale":"Fix the typo","hunks":[{"oldText":"teh","newText":"the"}]}\n```';
    const result = extractCodexProposal(reply);
    expect(result.proposal).toEqual({
      rationale: "Fix the typo",
      hunks: [{ oldText: "teh", newText: "the" }],
    });
    expect(result.reply).toBe("Here's my rationale for the change.");
  });

  it("parses the contract shape ({rationale, fullRewrite}) and strips the block", () => {
    const reply =
      "Rewriting the section.\n```json\n{"
      + '"rationale":"Clarify","fullRewrite":"# New body"'
      + "}\n```";
    const result = extractCodexProposal(reply);
    expect(result.proposal).toEqual({ rationale: "Clarify", fullRewrite: "# New body" });
    expect(result.reply).toBe("Rewriting the section.");
  });

  it("accepts multiple hunks", () => {
    const reply =
      '```json\n{"rationale":"Two fixes","hunks":[{"oldText":"a","newText":"b"},{"oldText":"c","newText":"d"}]}\n```';
    const result = extractCodexProposal(reply);
    expect(result.proposal).toEqual({
      rationale: "Two fixes",
      hunks: [
        { oldText: "a", newText: "b" },
        { oldText: "c", newText: "d" },
      ],
    });
  });

  it("maps the legacy flat shape {oldText, newText} to one hunk with an empty rationale", () => {
    const reply = 'Sure, here:\n```json\n{"oldText":"foo","newText":"bar"}\n```';
    const result = extractCodexProposal(reply);
    expect(result.proposal).toEqual({ rationale: "", hunks: [{ oldText: "foo", newText: "bar" }] });
    expect(result.reply).toBe("Sure, here:");
  });

  it("only considers a TRAILING block — a non-trailing ```json block is left as ordinary prose", () => {
    const reply =
      "For example:\n```json\n{\"foo\":\"bar\"}\n```\nThat's just an illustration, no proposal here.";
    const result = extractCodexProposal(reply);
    expect(result.proposal).toBeUndefined();
    expect(result.reply).toBe(reply);
  });

  it("with multiple ```json blocks, only the trailing one is considered", () => {
    const reply =
      "Example:\n```json\n{\"foo\":\"bar\"}\n```\nNow my actual proposal:\n" +
      '```json\n{"rationale":"real one","hunks":[{"oldText":"x","newText":"y"}]}\n```';
    const result = extractCodexProposal(reply);
    expect(result.proposal).toEqual({
      rationale: "real one",
      hunks: [{ oldText: "x", newText: "y" }],
    });
    // The earlier, non-trailing block stays put as part of the kept prose.
    expect(result.reply).toBe(
      'Example:\n```json\n{"foo":"bar"}\n```\nNow my actual proposal:',
    );
  });

  it("malformed JSON in the trailing block → reply unchanged, no proposal", () => {
    const reply = "Here you go:\n```json\n{not valid json\n```";
    const result = extractCodexProposal(reply);
    expect(result.proposal).toBeUndefined();
    expect(result.reply).toBe(reply);
  });

  it("valid JSON that matches neither shape → reply unchanged, no proposal", () => {
    const reply = '```json\n{"foo":"bar"}\n```';
    const result = extractCodexProposal(reply);
    expect(result.proposal).toBeUndefined();
    expect(result.reply).toBe(reply);
  });

  it("empty hunks array → reply unchanged, no proposal", () => {
    const reply = '```json\n{"rationale":"nothing to do","hunks":[]}\n```';
    const result = extractCodexProposal(reply);
    expect(result.proposal).toBeUndefined();
    expect(result.reply).toBe(reply);
  });

  it("a hunk with a non-string oldText/newText → reply unchanged, no proposal", () => {
    const reply = '```json\n{"rationale":"r","hunks":[{"oldText":1,"newText":"b"}]}\n```';
    const result = extractCodexProposal(reply);
    expect(result.proposal).toBeUndefined();
    expect(result.reply).toBe(reply);
  });

  it("no fenced json block at all → reply unchanged, no proposal", () => {
    const reply = "Just a plain reply with no block.";
    const result = extractCodexProposal(reply);
    expect(result.proposal).toBeUndefined();
    expect(result.reply).toBe(reply);
  });

  it("falls back to the proposal's rationale when the reply is empty after stripping", () => {
    const reply = '```json\n{"rationale":"Did the thing","hunks":[{"oldText":"a","newText":"b"}]}\n```';
    const result = extractCodexProposal(reply);
    expect(result.proposal).toBeTruthy();
    expect(result.reply).toBe("Did the thing");
  });

  it('falls back to "Proposed an edit." when both prose and rationale are empty', () => {
    const reply = '```json\n{"hunks":[{"oldText":"a","newText":"b"}]}\n```';
    const result = extractCodexProposal(reply);
    expect(result.proposal).toEqual({ rationale: "", hunks: [{ oldText: "a", newText: "b" }] });
    expect(result.reply).toBe("Proposed an edit.");
  });

  it("tolerates trailing whitespace/newlines after the closing fence", () => {
    const reply =
      'Done.\n```json\n{"rationale":"r","hunks":[{"oldText":"a","newText":"b"}]}\n```\n\n  ';
    const result = extractCodexProposal(reply);
    expect(result.proposal).toEqual({ rationale: "r", hunks: [{ oldText: "a", newText: "b" }] });
    expect(result.reply).toBe("Done.");
  });
});
