import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

// The settings modal (harness caps, model manager) moved to shell.ts in the
// frontend split. Assertion semantics are unchanged; only the source file moved.
const shellSource = readFileSync(new URL("./shell.ts", import.meta.url), "utf8");
const htmlSource = readFileSync(new URL("../index.html", import.meta.url), "utf8");

function sourceBetween(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return source.slice(startIndex, endIndex);
}

describe("Settings harness controls", () => {
  it("shows Codex capabilities and explains unavailable harnesses", () => {
    const harnessSource = sourceBetween(
      shellSource,
      "function renderHarnessCaps",
      "async function refreshHarnesses",
    );

    expect(harnessSource).toContain("unavailableReason");
    expect(harnessSource).toContain("Web: harness");
    expect(harnessSource).toContain("Model: Docuzen provider");
    expect(harnessSource).toContain("Model: harness-managed");
  });

  it("keeps Codex model controls editable while disabling web search that the CLI owns", () => {
    const settingsSource = sourceBetween(
      shellSource,
      "function selectedHarnessInfo",
      "setScopeEl.addEventListener",
    );

    expect(htmlSource).toContain('id="setDefaultModelHint"');
    expect(htmlSource).toContain('id="setWebSearchHint"');
    expect(settingsSource).toContain("function syncHarnessManagedControls");
    expect(settingsSource).toContain('h.id !== "pi" && h.id !== "codex"');
    expect(settingsSource).toContain("modelAddBtn.disabled = harnessManagedModels");
    expect(settingsSource).toContain("launch Codex with a Docuzen provider");
    expect(settingsSource).toContain("setWebSearchEl.disabled = harnessManagedWebSearch");
    expect(settingsSource).toContain("syncHarnessManagedControls()");
  });

  it("offers xhigh reasoning for Codex-compatible model provider rows", () => {
    expect(htmlSource).toContain('<option value="xhigh">reasoning: xhigh</option>');
  });
});
