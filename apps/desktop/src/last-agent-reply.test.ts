import { describe, expect, it, vi } from "vitest";
import { lastAgentReply } from "./ui.js";

const thread = (...turns: [string, string][]) => ({ turns: turns.map(([role, body]) => ({ role, body })) });

describe("lastAgentReply", () => {
  it("returns the body of the final turn when the agent wrote it", async () => {
    const api = { getThread: vi.fn(async () => thread(["you", "q"], ["agent", "the answer"])) };
    expect(await lastAgentReply(api, () => "/d/a.md", "c0001")).toBe("the answer");
    expect(api.getThread).toHaveBeenCalledWith({ threadId: "c0001" });
  });

  it("returns undefined when the last turn is not the agent's (nothing new was persisted)", async () => {
    const api = { getThread: async () => thread(["agent", "old"], ["you", "follow-up"]) };
    expect(await lastAgentReply(api, () => "/d/a.md", "c0001")).toBeUndefined();
  });

  it("is best-effort: a failed fetch yields undefined instead of throwing", async () => {
    const api = {
      getThread: async () => {
        throw new Error("sidecar restarting");
      },
    };
    expect(await lastAgentReply(api, () => "/d/a.md", "c0001")).toBeUndefined();
  });

  it("does not call the sidecar when no document is open", async () => {
    const api = { getThread: vi.fn(async () => thread(["agent", "x"])) };
    expect(await lastAgentReply(api, () => undefined, "c0001")).toBeUndefined();
    expect(api.getThread).not.toHaveBeenCalled();
  });
});
