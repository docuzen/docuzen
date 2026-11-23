// @vitest-environment happy-dom
//
// The markdown editor's annotation overlay (editor.ts) on a live editor: how a comment over
// a long passage marks its blocks, and what a ⌘-click inside those blocks lands on.
import { beforeEach, describe, expect, it } from "vitest";
import { annoKey } from "./editor.js";
import { bodyHtml, mountEditor, type MountedEditor } from "./editor-harness.test-support.js";

let ed: MountedEditor;

beforeEach(async () => {
  document.body.innerHTML = bodyHtml;
  ed = await mountEditor();
});

const anno = (id: string, exact: string, type: "highlight" | "comment" = "comment") => ({
  id,
  type,
  anchor: { exact, prefix: "", suffix: "" },
  status: "open",
  thread: `threads/${id}.md`,
  session: `sessions/${id}.session.jsonl`,
  createdAt: "2026-01-01T00:00:00.000Z",
});

const rangeIds = (): (string | null)[] =>
  [...ed.view().dom.querySelectorAll("p")].map((p) => p.getAttribute("data-had-range"));

describe("a long comment's margin bar", () => {
  it("does not take ⌘-clicks meant for another annotation in a block it only partly covers", () => {
    ed.setMarkdown("intro ALPHA here and on\n\nsecond block\n\nthird block\n\nfourth block\n");
    ed.renderLoaded([
      anno("c0002", "here and on\nsecond block\nthird block\nfourth block"),
      anno("c0001", "ALPHA", "highlight"),
    ] as never);
    expect(rangeIds()[0]).toBe("c0002"); // the first block carries the comment's bar...

    ed.metaClick(ed.posOf("ALPHA") + 2); // ...but ALPHA is outside the comment's text
    expect(ed.deps.onAnnotationJump).toHaveBeenCalledWith("c0001");
    expect(ed.deps.onAnnotationJump).toHaveBeenCalledTimes(1);
  });

  it("does not take ⌘-clicks meant for a directive in a block it only partly covers", () => {
    ed.setMarkdown("[[ tighten ]] intro here and on\n\nsecond block\n\nthird block\n\nfourth block\n");
    ed.renderLoaded([anno("c0001", "here and on\nsecond block\nthird block\nfourth block")] as never);

    ed.metaClick(ed.posOf("tighten") + 2);
    expect(ed.deps.onDirectiveJump).toHaveBeenCalledWith(1);
    expect(ed.deps.onAnnotationJump).not.toHaveBeenCalled();
  });

  it("still jumps to the comment from inside its own text", () => {
    ed.setMarkdown("intro here and on\n\nsecond block\n\nthird block\n\nfourth block\n");
    ed.renderLoaded([anno("c0001", "here and on\nsecond block\nthird block\nfourth block")] as never);
    ed.metaClick(ed.posOf("third") + 2);
    expect(ed.deps.onAnnotationJump).toHaveBeenCalledWith("c0001");
  });

  it("lists every long comment covering a block, and drops only the one removed", () => {
    ed.setMarkdown("one\n\ntwo\n\nthree\n\nfour\n\nfive\n\nsix\n");
    ed.renderLoaded([anno("c0001", "one\ntwo\nthree\nfour"), anno("c0002", "three\nfour\nfive\nsix")] as never);
    const ids = (s: string | null) => (s ?? "").split(/\s+/).filter(Boolean).sort();
    expect(rangeIds().map(ids)).toEqual([
      ["c0001"],
      ["c0001"],
      ["c0001", "c0002"],
      ["c0001", "c0002"],
      ["c0002"],
      ["c0002"],
    ]);

    const v = ed.view();
    v.dispatch(v.state.tr.setMeta(annoKey, { remove: "c0001" }));
    expect(rangeIds().map(ids)).toEqual([[], [], ["c0002"], ["c0002"], ["c0002"], ["c0002"]]);
  });
});
