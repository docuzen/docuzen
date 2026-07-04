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
    expect(harnessSource).toContain("Model: harness-managed");
  });

  it("disables Pi model controls when the selected harness owns models and web search", () => {
    const settingsSource = sourceBetween(
      shellSource,
      "function selectedHarnessInfo",
      "setScopeEl.addEventListener",
    );

    expect(htmlSource).toContain('id="setDefaultModelHint"');
    expect(htmlSource).toContain('id="setWebSearchHint"');
    expect(settingsSource).toContain("function syncHarnessManagedControls");
    expect(settingsSource).toContain("setDefaultModelEl.disabled = harnessManagedModels");
    expect(settingsSource).toContain("modelAddBtn.disabled = harnessManagedModels");
    expect(settingsSource).toContain("setWebSearchEl.disabled = harnessManagedWebSearch");
    expect(settingsSource).toContain("syncHarnessManagedControls()");
  });
});
