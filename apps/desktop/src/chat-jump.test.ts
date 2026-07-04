import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

// Meta/ctrl+click any agent marker -> its conversation. editor.ts/surface.ts
// only resolve WHICH
// annotation id or directive ordinal a meta/ctrl+click landed on; chat.ts owns the
// actual open-thread routing (jumpToAnnotation/jumpToDirective) exercised here.
// Source-text pins, per this package's convention (chat.ts's DOM wiring isn't
// otherwise unit-testable in this vitest setup — see agents-panel.test.ts's header).
const chatSource = readFileSync(new URL("./chat.ts", import.meta.url), "utf8");

function sourceBetween(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return source.slice(startIndex, endIndex);
}

describe("jumpToAnnotation (meta/ctrl+click on an annotation marker)", () => {
  const fn = sourceBetween(
    chatSource,
    "async function jumpToAnnotation(",
    "async function jumpToDirective(",
  );

  it("promotes into the chat pane when a margin CommentEntry exists (comments + review findings)", () => {
    expect(fn).toContain("if (comments.has(id)) await promoteToChat(id);");
  });

  it("otherwise falls back to the read-only openThreadById view, mirroring the Agents panel's own click routing", () => {
    expect(fn).toContain("else await openThreadById(id, taskTitle(id));");
  });

  it("is exposed on ChatApi for editor.ts/surface.ts's onAnnotationJump deps", () => {
    expect(chatSource).toContain("jumpToAnnotation: (id: string) => Promise<void>;");
    expect(chatSource).toMatch(/return \{[\s\S]*jumpToAnnotation,[\s\S]*\};/);
  });
});

describe("jumpToDirective (meta/ctrl+click on a [[ ]] directive marker)", () => {
  const fn = sourceBetween(
    chatSource,
    "async function jumpToDirective(",
    "/**\n   * Show a directive-pass outcome",
  );

  it("keys the thread id off the 1-based document-order ordinal editor.ts computed", () => {
    expect(fn).toContain("const id = `directive-${n}`;");
  });

  it("checks the thread actually exists before opening the pane", () => {
    expect(fn).toContain("await deps.api.getThread({ threadId: id });");
  });

  it("logs the exact hint instead of opening an empty pane when the directive was never resolved", () => {
    const guarded = sourceBetween(fn, "} catch {", "await openThreadById(id, taskTitle(id));");
    expect(guarded).toContain("run Resolve [[ ]] to start this agent");
    expect(guarded).toContain("return;");
    expect(guarded).not.toContain("openThreadById");
  });

  it("opens the pseudo-thread view once the thread is confirmed to exist", () => {
    expect(fn).toContain("await openThreadById(id, taskTitle(id));");
  });

  it("is exposed on ChatApi for editor.ts's onDirectiveJump dep", () => {
    expect(chatSource).toContain("jumpToDirective: (n: number) => Promise<void>;");
    expect(chatSource).toMatch(/return \{[\s\S]*jumpToDirective,[\s\S]*\};/);
  });
});
