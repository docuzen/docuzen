// @vitest-environment happy-dom
//
// Markdown lists in the real editor. Up to Milkdown 7.21 the list parser passed `spread`
// as the string "true"; prosemirror-model 1.25.12+ validates attributes on create, so the
// whole list was dropped on open and the next save wrote the document without it.
import { beforeEach, describe, expect, it } from "vitest";
import { getMarkdown } from "@milkdown/kit/utils";
import { bodyHtml, mountEditor, type MountedEditor } from "./editor-harness.test-support.js";

let ed: MountedEditor;

beforeEach(async () => {
  document.body.innerHTML = bodyHtml;
  ed = await mountEditor();
});

const markdown = () => ed.editor.action(getMarkdown());

describe("markdown lists", () => {
  it("shows bullet, ordered and task lists", () => {
    ed.setMarkdown("# Plan\n\n- one\n- two\n\n1. first\n2. second\n\n- [ ] todo\n- [x] done\n\nAfter.\n");
    const items = [...ed.view().dom.querySelectorAll("li")].map((li) => li.textContent?.trim());
    expect(items).toEqual(["one", "two", "first", "second", "todo", "done"]);
  });

  it("keeps every item when the document is written back", () => {
    ed.setMarkdown("# Plan\n\n- one\n- two\n  - nested\n\n3. third\n4. fourth\n\nAfter.\n");
    const out = markdown();
    for (const text of ["one", "two", "nested", "third", "fourth", "After."]) expect(out).toContain(text);
    expect(out).toMatch(/^3\. third$/m);
    ed.setMarkdown(out);
    expect(markdown()).toBe(out);
  });
});
