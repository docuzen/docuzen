import { describe, expect, it } from "vitest";
import { captureSessionEvent, finishTurn, type SessionEntry } from "../../src/agent/pi-runner.js";

// Bug trace (task-0): the pi SDK (@earendil-works/pi-coding-agent 0.79.3) never emits a
// top-level `type: "error"` event — a failed model/gateway call (wrong/forbidden model id,
// an unreachable gateway, a timeout, rate-limiting, ...) surfaces as a "message_update"
// event whose NESTED `assistantMessageEvent.type` is "error" (see pi-ai's
// AssistantMessageEvent + pi-agent-core's AgentEvent). PiRunner used to check the (dead)
// top-level shape, so every one of those failures vanished: the turn resolved with an
// empty reply and no error, and the desktop bubble rendered its generic "No response ...
// Check the model in File > Settings" copy with no real detail anywhere. These tests drive
// captureSessionEvent/finishTurn — the two pure functions PiRunner.start()/run() now use —
// directly against each SDK failure shape, without a live pi session.

function freshEntry(): SessionEntry {
  return {
    session: undefined as unknown as SessionEntry["session"],
    sink: null,
    buf: "",
    think: "",
    error: null,
    aborted: false,
    proposal: null,
    findings: [],
    chain: Promise.resolve(),
  };
}

describe("captureSessionEvent — each SDK failure shape", () => {
  it("captures a message_update 'error' assistantMessageEvent (the SDK's primary failure shape)", () => {
    const entry = freshEntry();
    captureSessionEvent(entry, {
      type: "message_update",
      assistantMessageEvent: {
        type: "error",
        reason: "error",
        error: { role: "assistant", stopReason: "error", errorMessage: "401 model litellm/gpt-9 not allowed" },
      },
    });
    expect(entry.error).toBe("401 model litellm/gpt-9 not allowed");
    expect(entry.aborted).toBe(false);
  });

  it("falls back to a generic reason-based message when the errored AssistantMessage has no errorMessage", () => {
    const entry = freshEntry();
    captureSessionEvent(entry, {
      type: "message_update",
      assistantMessageEvent: { type: "error", reason: "error", error: { role: "assistant", stopReason: "error" } },
    });
    expect(entry.error).toBe("model call failed (error)");
  });

  it("treats a message_update 'error' event with reason 'aborted' as a stop, NOT a failure", () => {
    const entry = freshEntry();
    captureSessionEvent(entry, {
      type: "message_update",
      assistantMessageEvent: {
        type: "error",
        reason: "aborted",
        error: { role: "assistant", stopReason: "aborted", errorMessage: "aborted by user" },
      },
    });
    expect(entry.aborted).toBe(true);
    expect(entry.error).toBeNull();
  });

  it("captures an errored message_end event (belt-and-braces path)", () => {
    const entry = freshEntry();
    captureSessionEvent(entry, {
      type: "message_end",
      message: { role: "assistant", stopReason: "error", errorMessage: "gateway unreachable: ECONNREFUSED" },
    });
    expect(entry.error).toBe("gateway unreachable: ECONNREFUSED");
  });

  it("treats an aborted message_end event as a stop, not a failure", () => {
    const entry = freshEntry();
    captureSessionEvent(entry, { type: "message_end", message: { role: "assistant", stopReason: "aborted" } });
    expect(entry.aborted).toBe(true);
    expect(entry.error).toBeNull();
  });

  it("does not let a later message_end overwrite an already-captured message_update error", () => {
    const entry = freshEntry();
    captureSessionEvent(entry, {
      type: "message_update",
      assistantMessageEvent: {
        type: "error",
        reason: "error",
        error: { errorMessage: "rate limited (429)" },
      },
    });
    captureSessionEvent(entry, {
      type: "message_end",
      message: { role: "assistant", stopReason: "error", errorMessage: "rate limited (429)" },
    });
    expect(entry.error).toBe("rate limited (429)");
  });

  it("captures auto_retry_end's finalError once retries are exhausted", () => {
    const entry = freshEntry();
    captureSessionEvent(entry, { type: "auto_retry_end", success: false, attempt: 3, finalError: "still 503 after 3 retries" } as never);
    expect(entry.error).toBe("still 503 after 3 retries");
  });

  it("captures auto_retry_start's errorMessage as interim context", () => {
    const entry = freshEntry();
    captureSessionEvent(entry, { type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 500, errorMessage: "503 overloaded" } as never);
    expect(entry.error).toBe("503 overloaded");
  });

  it("still accumulates text/thinking/tool events exactly as before", () => {
    const entry = freshEntry();
    captureSessionEvent(entry, {
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "Hello" },
    });
    captureSessionEvent(entry, {
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", delta: "thinking..." },
    });
    captureSessionEvent(entry, {
      type: "message_update",
      assistantMessageEvent: { type: "tool_execution_start", toolName: "read" },
    });
    expect(entry.buf).toBe("Hello");
    expect(entry.think).toBe("thinking...");
    expect(entry.error).toBeNull();
  });
});

describe("finishTurn — the no-content/error decision every failure shape funnels through", () => {
  it("throws the captured error detail when the turn produced no content", () => {
    const entry = freshEntry();
    entry.error = "401 model litellm/gpt-9 not allowed";
    expect(() => finishTurn(entry)).toThrow("401 model litellm/gpt-9 not allowed");
  });

  it("throws an honest 'no content' error when there is no reply, proposal, findings, OR error", () => {
    const entry = freshEntry();
    expect(() => finishTurn(entry)).toThrow(/no reply, proposal, or findings/);
  });

  it("does NOT throw for a genuinely empty reply when the turn was aborted (Stop button)", () => {
    const entry = freshEntry();
    entry.aborted = true;
    expect(finishTurn(entry)).toEqual({ reply: "" });
  });

  it("does NOT throw for a propose_edit-only turn (no reply text, but a real proposal)", () => {
    const entry = freshEntry();
    entry.proposal = { rationale: "tighten wording", fullRewrite: "New body." };
    expect(finishTurn(entry)).toEqual({ reply: "", proposal: entry.proposal });
  });

  it("does NOT throw for a review-pass turn with findings but no reply text", () => {
    const entry = freshEntry();
    entry.findings = [{ anchorText: "Redis", comment: "Consider an in-memory bucket." }];
    expect(finishTurn(entry)).toEqual({ reply: "", findings: entry.findings });
  });

  it("returns the accumulated reply when the turn produced real content, even if an error was also seen", () => {
    const entry = freshEntry();
    entry.buf = "Partial answer before a late hiccup.";
    entry.error = "transient blip";
    expect(finishTurn(entry)).toEqual({ reply: "Partial answer before a late hiccup." });
  });

  it("captures a rejected session.prompt() (e.g. the SDK's own 'no model selected' preflight check)", () => {
    const entry = freshEntry();
    expect(() => finishTurn(entry, new Error("no model selected"))).toThrow("no model selected");
  });

  it("prefers an already-captured event error over a later promptError's message", () => {
    const entry = freshEntry();
    entry.error = "401 model litellm/gpt-9 not allowed";
    expect(() => finishTurn(entry, new Error("prompt() rejected"))).toThrow(
      "401 model litellm/gpt-9 not allowed",
    );
  });

  it("stringifies a non-Error rejection", () => {
    const entry = freshEntry();
    expect(() => finishTurn(entry, "network down")).toThrow("network down");
  });
});
