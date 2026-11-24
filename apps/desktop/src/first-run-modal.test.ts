// @vitest-environment happy-dom
//
// The first-run harness modal, driven through index.html's real markup and a scripted sidecar:
// what it saves to ~/.docuzen/config.toml and what it tells the rest of the app afterwards.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AppConfig } from "@ai-native-doc/docd/protocol";
import { maybeShowFirstRun } from "./first-run.js";

const here = dirname(fileURLToPath(import.meta.url));
const bodyHtml = /<body[^>]*>([\s\S]*)<\/body>/.exec(readFileSync(resolve(here, "..", "index.html"), "utf8"))![1];
const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
};

function sidecar(config: AppConfig, models: { key: string; name: string; hasKey?: boolean }[] = []) {
  const saved: AppConfig[] = [];
  const client = {
    call: vi.fn(async (method: string, params: Record<string, unknown>): Promise<unknown> => {
      if (method === "getAppConfig") return { config, piUsable: true, codexUsable: true };
      if (method === "listModels") return models;
      if (method === "setAppConfig") return void saved.push(params.config as AppConfig);
      throw new Error(`unexpected ${method}`);
    }),
  };
  return { client, saved };
}

beforeEach(() => {
  document.body.innerHTML = bodyHtml;
});

describe("first-run harness setup", () => {
  it("choosing codex keeps the [pi] and [codex] settings already in config.toml", async () => {
    const { client, saved } = sidecar({ harness: null, pi: { model: "litellm/opus" }, codex: { command: "/opt/bin/codex" } });
    await maybeShowFirstRun(client, vi.fn());
    expect($("#firstRunModal").hidden).toBe(false);
    const harness = $<HTMLSelectElement>("#firstRunHarness");
    harness.value = "codex";
    harness.dispatchEvent(new Event("change"));
    $<HTMLButtonElement>("#firstRunSave").click();
    await settle();
    expect(saved).toEqual([{ harness: { default: "codex" }, pi: { model: "litellm/opus" }, codex: { command: "/opt/bin/codex" } }]);
  });

  it("offers the available Claude harness and saves it as the app default", async () => {
    const { client, saved } = sidecar({ harness: null });
    const oldCall = client.call.getMockImplementation()!;
    client.call.mockImplementation(async (method, params) => method === "listHarnesses"
      ? [{ id: "claude-code", label: "Claude Code", available: true, status: "CLI detected" }]
      : oldCall(method, params));
    await maybeShowFirstRun(client, vi.fn());
    expect($<HTMLSelectElement>("#firstRunHarness").value).toBe("claude-code");
    expect($("#firstRunPiRow").hidden).toBe(true);
    $<HTMLButtonElement>("#firstRunSave").click();
    await settle();
    expect(saved[0].harness?.default).toBe("claude-code");
  });

  it("choosing pi with a model sets that model and keeps the codex command", async () => {
    const { client, saved } = sidecar({ harness: null, codex: { command: "/opt/bin/codex" } }, [
      { key: "litellm/opus", name: "Opus", hasKey: true },
    ]);
    await maybeShowFirstRun(client, vi.fn());
    $<HTMLButtonElement>("#firstRunSave").click();
    await settle();
    expect(saved).toEqual([{ harness: { default: "pi" }, pi: { model: "litellm/opus" }, codex: { command: "/opt/bin/codex" } }]);
  });

  it("tells the app once the harness is configured, so the topbar badge stops showing the old one", async () => {
    const { client } = sidecar({ harness: null });
    const onConfigured = vi.fn();
    await maybeShowFirstRun(client, vi.fn(), { onConfigured });
    $<HTMLButtonElement>("#firstRunSave").click();
    await settle();
    expect(onConfigured).toHaveBeenCalledTimes(1);
    expect($("#firstRunModal").hidden).toBe(true);
  });
});
