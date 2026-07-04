import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { CodexEventParser, CodexRunner, extractCodexText } from "../../src/agent/codex-runner.js";
import type { AgentContext, AgentEvent } from "../../src/agent/types.js";

// Representative codex-cli 0.142.5 --json NDJSON: one command_execution item
// (started + completed) followed by one agent_message. Used to test that the
// parser emits a [tool] marker then the message token in stream order, and that
// JSON-line reassembly is robust to arbitrary byte-split boundaries. The
// aggregated_output field carries em-dash (U+2014) characters so the mid-
// multibyte-split test below has a real multibyte codepoint to split on.
const fixturePath = fileURLToPath(
  new URL("./fixtures/codex-json-lines.ndjson", import.meta.url),
);
const fixture = readFileSync(fixturePath); // Buffer — byte-level splitting below

const fixtureLines = fixture
  .toString("utf8")
  .split("\n")
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l) as { type: string; item?: Record<string, unknown> });
const toolCommand = fixtureLines.find((l) => l.item?.type === "command_execution")!
  .item!.command as string;
const messageText = fixtureLines.find((l) => l.item?.type === "agent_message")!.item!
  .text as string;

function parseAll(chunks: Buffer[]): { events: AgentEvent[]; parser: CodexEventParser } {
  const events: AgentEvent[] = [];
  const parser = new CodexEventParser((e) => events.push(e));
  for (const chunk of chunks) parser.push(chunk);
  parser.end();
  return { events, parser };
}

function splitEvery(buf: Buffer, size: number): Buffer[] {
  const out: Buffer[] = [];
  for (let i = 0; i < buf.length; i += size) out.push(buf.subarray(i, i + size));
  return out;
}

describe("CodexEventParser — captured codex-cli 0.142.5 NDJSON", () => {
  it("emits [tool] marker and agent_message as token, in stream order", () => {
    const { events, parser } = parseAll([fixture]);
    expect(events.map((e) => e.type)).toEqual(["thinking", "token"]);
    expect(events[0]!.text).toBe(`[tool] ${toolCommand}`);
    expect(events[1]!).toEqual({ type: "token", text: messageText });
    expect(parser.streamedToken).toBe(true);
  });

  it.each([1, 7, 64])(
    "is byte-split invariant at chunk size %i (mid-line and mid-multibyte boundaries)",
    (size) => {
      const whole = parseAll([fixture]).events;
      const chunked = parseAll(splitEvery(fixture, size)).events;
      expect(chunked).toEqual(whole);
    },
  );

  it("handles a split placed exactly inside a multibyte character", () => {
    // U+2014 (em dash) is e2 80 94 — split between the e2 and 80 bytes. This
    // multibyte char lives in the fixture's (unemitted) aggregated_output field, so
    // this test proves the JSON-line reassembly is robust to a mid-codepoint split
    // anywhere in the stream, not just in emitted fields — see the dedicated
    // "genuine multibyte text survives a mid-codepoint chunk split" test below for
    // proof that split multibyte content reaching onToken is reproduced correctly.
    const idx = fixture.indexOf(0xe2);
    expect(idx).toBeGreaterThan(0);
    const { events } = parseAll([fixture.subarray(0, idx + 1), fixture.subarray(idx + 1)]);
    expect(events).toEqual(parseAll([fixture]).events);
  });

  it("genuine multibyte text survives a mid-codepoint chunk split when it IS emitted", () => {
    // Synthetic (not the fixture) agent_message text carrying the same em dash
    // (U+2014, e2 80 94 in UTF-8) the real capture has in an unemitted field —
    // this exercises the StringDecoder buffering on a field that actually reaches
    // onToken, split exactly inside the multibyte codepoint.
    const text = "before—after"; // "before—after"
    const line = Buffer.from(
      JSON.stringify({ type: "item.completed", item: { id: "item_1", type: "agent_message", text } }) +
        "\n",
      "utf8",
    );
    const idx = line.indexOf(0xe2);
    expect(idx).toBeGreaterThan(0);
    const { events } = parseAll([line.subarray(0, idx + 1), line.subarray(idx + 1)]);
    expect(events).toEqual([{ type: "token", text }]);
  });

  it("flushes a trailing agent_message line that has no terminating newline", () => {
    // Drop turn.completed and the trailing newline so the agent_message line is the
    // unterminated tail — end() must still parse and emit it.
    const untilMessage = fixture
      .toString("utf8")
      .split("\n")
      .filter((l) => l.trim())
      .slice(0, -1)
      .join("\n"); // no trailing \n
    const { events, parser } = parseAll([Buffer.from(untilMessage, "utf8")]);
    expect(events.at(-1)).toEqual({ type: "token", text: messageText });
    expect(parser.streamedToken).toBe(true);
  });

  it("announces a tool item once, not once per lifecycle event (started + completed)", () => {
    const { events } = parseAll([fixture]);
    expect(events.filter((e) => e.text.startsWith("[tool] "))).toHaveLength(1);
  });

  it("emits nothing and leaves streamedToken false for lifecycle-only streams", () => {
    const lines =
      '{"type":"thread.started","thread_id":"t"}\n' +
      '{"type":"turn.started"}\n' +
      '{"type":"turn.completed","usage":{"input_tokens":1,"cached_input_tokens":0,"output_tokens":1,"reasoning_output_tokens":0}}\n';
    const { events, parser } = parseAll([Buffer.from(lines, "utf8")]);
    expect(events).toEqual([]);
    expect(parser.streamedToken).toBe(false);
  });

  it("ignores non-JSON noise lines without dying", () => {
    const lines = "warning: something\n" + fixture.toString("utf8");
    const { events } = parseAll([Buffer.from(lines, "utf8")]);
    expect(events).toEqual(parseAll([fixture]).events);
  });

  it("dedups growing item.updated deltas against the final item.completed (no double text)", () => {
    // item.updated with growing text is in the CLI's event vocabulary (binary string
    // table) though 0.142.5 was only observed emitting one item.completed per item.
    // The parser must emit only each NEW suffix and NOT re-emit the completed total.
    const lines = [
      '{"type":"item.updated","item":{"id":"item_1","type":"agent_message","text":"Hel"}}',
      '{"type":"item.updated","item":{"id":"item_1","type":"agent_message","text":"Hello wo"}}',
      '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"Hello world"}}',
    ].join("\n");
    const { events, parser } = parseAll([Buffer.from(lines + "\n", "utf8")]);
    expect(events).toEqual([
      { type: "token", text: "Hel" },
      { type: "token", text: "lo wo" },
      { type: "token", text: "rld" },
    ]);
    expect(events.map((e) => e.text).join("")).toBe("Hello world");
    expect(parser.streamedToken).toBe(true);
  });

  it("emits a repeated identical completed event only once", () => {
    const line =
      '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"same"}}\n';
    const { events } = parseAll([Buffer.from(line + line, "utf8")]);
    expect(events).toEqual([{ type: "token", text: "same" }]);
  });

  it("stop() permanently silences the sink, even for a chunk fed after stop()", () => {
    // The exact race this guards: cancel()/timeout-kill/error all call stop() before
    // rejecting, but the child's stdout stream can keep delivering data afterward
    // (SIGTERM isn't instant, and data already in the pipe still arrives). Prove that
    // a chunk pushed after stop() never reaches onToken.
    const events: AgentEvent[] = [];
    const parser = new CodexEventParser((e) => events.push(e));
    parser.push(
      Buffer.from(
        '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"before"}}\n',
        "utf8",
      ),
    );
    expect(events).toEqual([{ type: "token", text: "before" }]);

    parser.stop();
    parser.push(
      Buffer.from(
        '{"type":"item.completed","item":{"id":"item_2","type":"agent_message","text":"after"}}',
        "utf8",
      ),
    );
    parser.end(); // even the trailing-line flush must stay silent post-stop
    expect(events).toEqual([{ type: "token", text: "before" }]); // no new emission
  });
});

describe("extractCodexText — stdout fallback when --output-last-message is unreadable", () => {
  it("recovers the agent_message text from the real captured schema", () => {
    // Regression test: the old implementation searched top-level text/delta/message/
    // content/output keys and never looked inside `item`, so on the real
    // `{"type":"item.completed","item":{"type":"agent_message","text":...}}` schema
    // it always returned "" and the stdout fallback was dead code.
    expect(extractCodexText(fixture.toString("utf8"))).toBe(messageText);
  });

  it("ignores non-agent_message items (tool/command_execution) and lifecycle lines", () => {
    const stdout = [
      '{"type":"thread.started","thread_id":"t"}',
      '{"type":"item.completed","item":{"id":"item_0","type":"command_execution","command":"ls"}}',
      '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"final reply"}}',
      '{"type":"turn.completed","usage":{}}',
    ].join("\n");
    expect(extractCodexText(stdout)).toBe("final reply");
  });

  it("concatenates multiple agent_message items in order, deduping a growing item.updated against its item.completed", () => {
    const stdout = [
      '{"type":"item.updated","item":{"id":"item_1","type":"agent_message","text":"Hel"}}',
      '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"Hello"}}',
      '{"type":"item.completed","item":{"id":"item_2","type":"agent_message","text":" world"}}',
    ].join("\n");
    expect(extractCodexText(stdout)).toBe("Hello world");
  });

  it("falls back to raw non-JSON output when there's no agent_message item at all", () => {
    expect(extractCodexText("plain text reply")).toBe("plain text reply");
  });

  it("returns empty string for lifecycle-only or empty stdout", () => {
    expect(extractCodexText('{"type":"thread.started","thread_id":"t"}\n')).toBe("");
    expect(extractCodexText("")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Runner-level: spawn a fake `codex` script so the full spawn → parse → final
// pipeline runs, proving the no-double-final rule end to end.
// ---------------------------------------------------------------------------

const baseCtx: AgentContext = {
  docText: "# Doc",
  anchorExact: "Doc",
  surrounding: "# Doc",
  comment: "hi",
  stancePrompt: "Be brief.",
};

/**
 * Writes an executable fake `codex` whose stdout body + last-message are ours.
 * `lastMessage` is written to its own side file and `cp`'d into place rather than
 * inlined into the script as a shell string literal: a message containing fenced
 * ```json``` blocks has literal backtick pairs, which — even double-quoted — POSIX
 * sh treats as command substitution, mangling the content. Routing it through a
 * file sidesteps shell quoting entirely regardless of what the message contains.
 */
function fakeCodex(dir: string, body: string, lastMessage: string): string {
  const script = join(dir, "fake-codex");
  const lastMessagePath = join(dir, "fake-last-message.txt");
  writeFileSync(lastMessagePath, lastMessage);
  writeFileSync(
    script,
    `#!/bin/sh
out=""
prev=""
for a in "$@"; do
  [ "$prev" = "--output-last-message" ] && out="$a"
  prev="$a"
done
cat > /dev/null
cat ${JSON.stringify(body)}
cp ${JSON.stringify(lastMessagePath)} "$out"
`,
  );
  chmodSync(script, 0o755);
  return script;
}

describe("CodexRunner streaming (fake codex binary)", () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("streams events live and does NOT re-emit the final reply after streaming", async () => {
    dir = mkdtempSync(join(tmpdir(), "docuzen-codex-test-"));
    const body = join(dir, "stdout.ndjson");
    writeFileSync(body, fixture);
    const runner = new CodexRunner({ command: fakeCodex(dir, body, messageText) });
    const events: AgentEvent[] = [];
    const { turn } = await runner.start({ ...baseCtx, scopeDir: dir }, (e) => events.push(e));
    expect(turn.reply).toBe(messageText);
    // The streamed token is the only token — the one-shot final must be suppressed.
    expect(events.filter((e) => e.type === "token")).toEqual([
      { type: "token", text: messageText },
    ]);
    expect(events.map((e) => e.type)).toEqual(["thinking", "token"]);
  });

  it("falls back to the one-shot final token when nothing streamed", async () => {
    dir = mkdtempSync(join(tmpdir(), "docuzen-codex-test-"));
    const body = join(dir, "stdout.ndjson");
    writeFileSync(
      body,
      '{"type":"thread.started","thread_id":"t"}\n{"type":"turn.started"}\n{"type":"turn.completed","usage":{"input_tokens":1,"cached_input_tokens":0,"output_tokens":1,"reasoning_output_tokens":0}}\n',
    );
    const runner = new CodexRunner({ command: fakeCodex(dir, body, "final answer") });
    const events: AgentEvent[] = [];
    const { turn } = await runner.start({ ...baseCtx, scopeDir: dir }, (e) => events.push(e));
    expect(turn.reply).toBe("final answer");
    expect(events).toEqual([{ type: "token", text: "final answer" }]);
  });

  it("cancel() stops emissions even though the child keeps writing to stdout afterward", async () => {
    // Reproduces the reported race: cancel() rejects the in-flight start() promise,
    // but SIGTERM doesn't stop the child instantly — it can keep flowing stdout data
    // into parser.push() afterward. This script ignores SIGTERM and deliberately
    // keeps writing after the point cancel() is called, so a passing test proves the
    // settled/stop() guard — not process death — is what silences onToken.
    dir = mkdtempSync(join(tmpdir(), "docuzen-codex-test-"));
    const script = join(dir, "fake-codex-slow");
    writeFileSync(
      script,
      `#!/bin/sh
trap '' TERM
out=""
prev=""
for a in "$@"; do
  [ "$prev" = "--output-last-message" ] && out="$a"
  prev="$a"
done
cat > /dev/null
echo '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"before cancel"}}'
sleep 0.15
echo '{"type":"item.completed","item":{"id":"item_2","type":"agent_message","text":"after cancel"}}'
printf 'unused' > "$out"
exit 1
`,
    );
    chmodSync(script, 0o755);

    const runner = new CodexRunner({ command: script });
    const events: AgentEvent[] = [];
    const cancelKey = "cancel-me";
    const started = runner.start({ ...baseCtx, scopeDir: dir, cancelKey }, (e) => events.push(e));

    // Poll rather than guess a fixed delay: shell/process startup time is variable
    // (especially under sandboxing/CI), and a too-short wait would call cancel()
    // before the script even reaches its `trap` line, killing it outright and making
    // the test pass for the wrong reason (no output at all, not "guard suppressed it").
    const deadline = Date.now() + 2_000;
    while (events.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(events).toEqual([{ type: "token", text: "before cancel" }]); // arrived pre-cancel

    await runner.cancel(cancelKey);
    await expect(started).rejects.toThrow(/cancelled/i);

    await new Promise((r) => setTimeout(r, 300)); // long enough for "after cancel" to land if unguarded
    expect(events).toEqual([{ type: "token", text: "before cancel" }]); // no new emission post-cancel
  });

  it("timeout-kill stops emissions even though the child ignores SIGTERM and keeps writing", async () => {
    // Same race as the cancel test, but settled via the timeoutMs path: the timer
    // fires, SIGTERM is sent — and ignored — and the child writes another NDJSON
    // line ~500ms later. The settled/stop() guard (not process death) must swallow it.
    dir = mkdtempSync(join(tmpdir(), "docuzen-codex-test-"));
    const script = join(dir, "fake-codex-timeout");
    writeFileSync(
      script,
      `#!/bin/sh
trap '' TERM
cat > /dev/null
echo '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"before timeout"}}'
sleep 0.5
echo '{"type":"item.completed","item":{"id":"item_2","type":"agent_message","text":"after timeout"}}'
exit 0
`,
    );
    chmodSync(script, 0o755);

    const runner = new CodexRunner({ command: script, timeoutMs: 150 });
    const events: AgentEvent[] = [];
    await expect(
      runner.start({ ...baseCtx, scopeDir: dir }, (e) => events.push(e)),
    ).rejects.toThrow(/timed out after 150ms/);

    await new Promise((r) => setTimeout(r, 600)); // long enough for "after timeout" to land if unguarded
    // Not asserting the pre-timeout event arrived (spawn latency vs the 150ms timer is
    // inherently racy); the contract under test is that NOTHING emits post-settle.
    expect(events.filter((e) => e.text.includes("after timeout"))).toEqual([]);
    expect(events.every((e) => e.text === "before timeout")).toBe(true);
  });

  it("spawn error (nonexistent binary) rejects without any emission", async () => {
    dir = mkdtempSync(join(tmpdir(), "docuzen-codex-test-"));
    const runner = new CodexRunner({ command: join(dir, "no-such-binary") });
    const events: AgentEvent[] = [];
    await expect(
      runner.start({ ...baseCtx, scopeDir: dir }, (e) => events.push(e)),
    ).rejects.toThrow(/ENOENT/);
    expect(events).toEqual([]);
  });

  it("non-zero exit streams pre-exit events, rejects with stderr detail, and stays silent after", async () => {
    dir = mkdtempSync(join(tmpdir(), "docuzen-codex-test-"));
    const script = join(dir, "fake-codex-fail");
    writeFileSync(
      script,
      `#!/bin/sh
cat > /dev/null
echo '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"partial reply"}}'
echo 'boom: provider exploded' >&2
exit 1
`,
    );
    chmodSync(script, 0o755);

    const runner = new CodexRunner({ command: script });
    const events: AgentEvent[] = [];
    await expect(
      runner.start({ ...baseCtx, scopeDir: dir }, (e) => events.push(e)),
    ).rejects.toThrow(/Codex failed[\s\S]*boom: provider exploded/);
    // Everything the child wrote before dying DID stream (close settles after
    // parser.end(), so pre-exit output isn't lost)...
    expect(events).toEqual([{ type: "token", text: "partial reply" }]);
    // ...and once the close path has settled, nothing further can ever emit.
    await new Promise((r) => setTimeout(r, 100));
    expect(events).toEqual([{ type: "token", text: "partial reply" }]);
  });
});

// ---------------------------------------------------------------------------
// Runner-level: the structured-edit contract (buildCodexPrompt's PROPOSAL_CONTRACT
// + extractCodexProposal) exercised end to end through start(), same fake-binary
// harness as the streaming suite above.
// ---------------------------------------------------------------------------
describe("CodexRunner structured-edit proposal (fake codex binary)", () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("sets turn.proposal from a trailing ```json block and strips it from turn.reply", async () => {
    dir = mkdtempSync(join(tmpdir(), "docuzen-codex-test-"));
    // Lifecycle-only stdout (no agent_message item) so the reply is read from
    // --output-last-message, not the stdout fallback — proving the proposal
    // extraction runs on whichever path produced the final reply.
    const body = join(dir, "stdout.ndjson");
    writeFileSync(
      body,
      '{"type":"thread.started","thread_id":"t"}\n{"type":"turn.completed","usage":{}}\n',
    );
    const lastMessage =
      "Applied the requested fix.\n" +
      '```json\n{"rationale":"Fix the typo","hunks":[{"oldText":"# Doc","newText":"# Document"}]}\n```';
    const runner = new CodexRunner({ command: fakeCodex(dir, body, lastMessage) });
    const { turn } = await runner.start({ ...baseCtx, scopeDir: dir });
    expect(turn.reply).toBe("Applied the requested fix.");
    expect(turn.proposal).toEqual({
      rationale: "Fix the typo",
      hunks: [{ oldText: "# Doc", newText: "# Document" }],
    });
  });

  it("leaves turn.proposal unset and turn.reply untouched when there is no trailing json block", async () => {
    dir = mkdtempSync(join(tmpdir(), "docuzen-codex-test-"));
    const body = join(dir, "stdout.ndjson");
    writeFileSync(
      body,
      '{"type":"thread.started","thread_id":"t"}\n{"type":"turn.completed","usage":{}}\n',
    );
    const runner = new CodexRunner({ command: fakeCodex(dir, body, "Just a plain reply.") });
    const { turn } = await runner.start({ ...baseCtx, scopeDir: dir });
    expect(turn.reply).toBe("Just a plain reply.");
    expect(turn.proposal).toBeUndefined();
  });

  it("does not extract a proposal in reviewMode even if the reply carries a trailing json block", async () => {
    dir = mkdtempSync(join(tmpdir(), "docuzen-codex-test-"));
    const body = join(dir, "stdout.ndjson");
    writeFileSync(
      body,
      '{"type":"thread.started","thread_id":"t"}\n{"type":"turn.completed","usage":{}}\n',
    );
    const lastMessage =
      "Findings below.\n" + '```json\n{"rationale":"r","hunks":[{"oldText":"a","newText":"b"}]}\n```';
    const runner = new CodexRunner({ command: fakeCodex(dir, body, lastMessage) });
    const { turn } = await runner.start({ ...baseCtx, scopeDir: dir, reviewMode: true });
    expect(turn.reply).toBe(lastMessage);
    expect(turn.proposal).toBeUndefined();
  });

  // Phase 10: conversation turns (discuss/reply/panel/branch) never propose an edit,
  // regardless of settings.agentEdit — a volunteered trailing ```json block stays
  // visible prose exactly like the reviewMode case above (see canProposeEdits).
  it("does not extract a proposal in a conversation turn even if the reply carries a trailing json block", async () => {
    dir = mkdtempSync(join(tmpdir(), "docuzen-codex-test-"));
    const body = join(dir, "stdout.ndjson");
    writeFileSync(
      body,
      '{"type":"thread.started","thread_id":"t"}\n{"type":"turn.completed","usage":{}}\n',
    );
    const lastMessage =
      "Here's a change you could make.\n" +
      '```json\n{"rationale":"r","hunks":[{"oldText":"a","newText":"b"}]}\n```';
    const runner = new CodexRunner({ command: fakeCodex(dir, body, lastMessage) });
    const { turn } = await runner.start({ ...baseCtx, scopeDir: dir, conversationOnly: true });
    expect(turn.reply).toBe(lastMessage); // fenced json stays IN the reply, as plain prose
    expect(turn.proposal).toBeUndefined();
  });
});
