import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAgentContext } from "../../src/orchestrator/context.js";
import type { Annotation } from "../../src/had/types.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ctx-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function ann(exact: string, prefix: string, suffix: string): Annotation {
  return {
    id: "c0001",
    type: "comment",
    anchor: { exact, prefix, suffix },
    status: "open",
    thread: "threads/c0001.md",
    session: "sessions/c0001.session.jsonl",
    createdAt: "t",
  };
}

// HTML annotations are anchored in the rendered text; the agent is shown the raw source
// around the highlight. The highlighted words often also appear earlier in the source
// (the <title>, a nav link, an earlier paragraph), so the first raw match is not
// necessarily the highlighted one.
describe("buildAgentContext — HTML local source (L7)", () => {
  it("shows the source around the highlighted occurrence, not the <title>", async () => {
    const docPath = join(dir, "page.html");
    const filler = "<p>" + "Background material. ".repeat(40) + "</p>";
    const html =
      `<!doctype html><html><head><title>Rollout plan</title></head><body>\n` +
      `${filler}\n<h2>Phases</h2>\n<p>The Rollout plan starts with 5% of traffic in eu-west-1.</p>\n</body></html>\n`;
    await writeFile(docPath, html, "utf8");

    const ctx = await buildAgentContext({
      docPath,
      ann: ann("Rollout plan", "Phases\nThe ", " starts with 5% of traffic"),
      threadId: "c0001",
      comment: "?",
      stance: "none",
    });
    expect(ctx.surrounding).toContain("starts with 5% of traffic in eu-west-1");
  });

  it("picks between two body occurrences by the anchor's prefix and suffix", async () => {
    const docPath = join(dir, "page.html");
    const filler = "<p>" + "Unrelated discussion. ".repeat(40) + "</p>";
    const html =
      `<html><body>\n<p>Phase one uses <b>Redis</b> for counters only.</p>\n${filler}\n` +
      `<p>Phase two moves limits to <b>Redis</b> with a TTL of one hour.</p>\n</body></html>\n`;
    await writeFile(docPath, html, "utf8");

    const ctx = await buildAgentContext({
      docPath,
      ann: ann("Redis", "Phase two moves limits to ", " with a TTL of one hour."),
      threadId: "c0001",
      comment: "?",
      stance: "none",
    });
    expect(ctx.surrounding).toContain("TTL of one hour");
    expect(ctx.surrounding).not.toContain("counters only");
  });
});
