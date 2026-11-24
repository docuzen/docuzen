import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const mainSource = readFileSync(new URL("./main.ts", import.meta.url), "utf8");
// Tabs (the array/activeIdx, session persistence, activateTab/openInTab/closeTab/
// restoreTabSession) and the Tauri native-menu listener both moved to shell.ts
// in the frontend split (the DocSession store's OWNERSHIP FLIP: shell.ts's tabs
// are now the sole source of truth, replacing the old main.ts `DOC_PATH`/
// `currentFormat` globals). Assertion semantics are unchanged; only the source
// file (and `deps.`-prefixed calls becoming direct in-module calls once their
// targets moved into the same module) moved.
import { shellSource } from "./module-source.test-support.js";

function sourceBetween(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return source.slice(startIndex, endIndex);
}

describe("desktop tab session restore", () => {
  it("restores persisted tabs before falling back to the dev default doc", () => {
    const initSource = sourceBetween(
      mainSource,
      "async function init(): Promise<void>",
      "void init();",
    );

    expect(shellSource).toContain("const TAB_SESSION_KEY");
    expect(shellSource).toContain("function saveTabSession()");
    expect(shellSource).toContain("async function restoreTabSession()");
    expect(initSource).toContain("await shell.restoreTabSession()");
    expect(initSource.indexOf("await shell.restoreTabSession()")).toBeLessThan(
      initSource.indexOf("if (shell.getTabCount() === 0 && initialDocPath)"),
    );
  });

  it("drains files opened from Finder right after the restore, before the empty state and default doc", () => {
    // main.ts runs at import, so its boot order is pinned on source; the drain's own gating
    // (no-op until this boot drain) is behavioural in tab-content.test.ts.
    const initSource = sourceBetween(mainSource, "async function init(): Promise<void>", "void init();");
    const drainAt = initSource.indexOf("await shell.drainExternalOpens({ boot: true });");
    expect(drainAt).toBeGreaterThan(initSource.indexOf("await shell.restoreTabSession()"));
    expect(drainAt).toBeLessThan(initSource.indexOf("if (shell.getTabCount() === 0 && initialDocPath)"));
    expect(drainAt).toBeLessThan(initSource.indexOf("shell.showEmptyState()"));
  });

  it("persists session state when tabs open, activate, close, or the window unloads", () => {
    const openSource = sourceBetween(
      shellSource,
      "async function openInTab(path: string): Promise<void>",
      "async function closeTab",
    );
    const closeSource = sourceBetween(
      shellSource,
      "async function closeTab(idx: number): Promise<void>",
      "async function restoreTabSession",
    );
    const activateSource = sourceBetween(
      shellSource,
      "async function activateTab(",
      "/** True for the rpc client",
    );

    expect(openSource).toContain("saveTabSession()");
    expect(closeSource).toContain("saveTabSession()");
    expect(activateSource).toContain("saveTabSession()");
    expect(shellSource).toContain('window.addEventListener("beforeunload", saveTabSession)');
  });

  it("reload menu action reloads the active document instead of resetting the webview", () => {
    const menuSource = sourceBetween(
      shellSource,
      'void listen<string>("menu-action"',
      "// --- Settings modal",
    );

    expect(menuSource).toContain('e.payload === "reload") void reloadActiveDoc()');
    expect(menuSource).not.toContain("location.reload()");
  });
});
