import { describe, expect, it } from "vitest";
import { FakePiRunner } from "../../src/agent/fake-runner.js";
import {
  CODEX_CAPABILITIES,
  createCodexHarness,
} from "../../src/agent/codex-runner.js";
import {
  HarnessRegistry,
  PI_CAPABILITIES,
  type AgentHarness,
} from "../../src/agent/harness-registry.js";

describe("HarnessRegistry", () => {
  it("resolves a single pi runner by default", () => {
    const runner = new FakePiRunner([]);
    const registry = HarnessRegistry.single(runner);

    expect(registry.defaultId()).toBe("pi");
    expect(registry.resolve().runner).toBe(runner);
    expect(registry.resolve("pi").capabilities).toEqual(PI_CAPABILITIES);
  });

  it("lists harness metadata without leaking runner instances", () => {
    const registry = HarnessRegistry.single(new FakePiRunner([]));
    const item = registry.list()[0];

    expect(item).toMatchObject({ id: "pi", label: "Pi", available: true });
    expect(item).not.toHaveProperty("runner");
  });

  it("falls back to the default harness when an unknown harness id is requested", () => {
    const registry = HarnessRegistry.single(new FakePiRunner([]));

    expect(registry.resolve("missing").id).toBe("pi");
  });

  it("throws for a known but unavailable harness", () => {
    const registry = HarnessRegistry.single(new FakePiRunner([]));
    const unavailable: AgentHarness = {
      id: "codex",
      label: "Codex",
      runner: new FakePiRunner([]),
      capabilities: { ...PI_CAPABILITIES, webSearch: "harness-managed" },
      available: false,
    };
    registry.register(unavailable);

    expect(() => registry.resolve("codex")).toThrow(/unavailable/);
  });

  it("builds an unavailable Codex harness when the CLI is missing", () => {
    const harness = createCodexHarness({
      detect: () => ({ available: false, reason: "codex not found on PATH" }),
    });

    expect(harness).toMatchObject({
      id: "codex",
      label: "Codex",
      available: false,
      unavailableReason: "codex not found on PATH",
      capabilities: CODEX_CAPABILITIES,
    });
    expect(harness.capabilities.webSearch).toBe("harness-managed");
  });

  it("includes the unavailable Codex reason when resolving fails", () => {
    const registry = HarnessRegistry.single(new FakePiRunner([]));
    registry.register(
      createCodexHarness({
        detect: () => ({ available: false, reason: "codex not found on PATH" }),
      }),
    );

    expect(() => registry.resolve("codex")).toThrow(/codex not found on PATH/);
  });

  it("registers an available Codex harness with harness-managed web search", () => {
    const registry = HarnessRegistry.single(new FakePiRunner([]));
    registry.register(
      createCodexHarness({
        detect: () => ({ available: true, command: "/bin/codex", version: "codex 1.2.3" }),
      }),
    );

    expect(registry.resolve("codex")).toMatchObject({
      id: "codex",
      available: true,
      capabilities: { webSearch: "harness-managed" },
    });
  });
});
