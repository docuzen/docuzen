// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { unwrapAnno } from "./html-projection.js";
import { confirmAction } from "./ui.js";

describe("deleting a comment", () => {
  it("removes the mark's own number badge with it, and leaves a nested comment's badge alone", () => {
    document.body.innerHTML =
      `<h1><span data-had-mark data-anno="c0001">Title <span data-had-mark data-anno="c0002">inner<span class="had-badge" data-had-overlay>2</span></span>` +
      `<span class="had-badge" data-had-overlay>1</span></span></h1>`;
    unwrapAnno(document, "c0001");
    expect(document.querySelector('[data-anno="c0001"]')).toBeNull();
    expect([...document.querySelectorAll(".had-badge")].map((b) => b.textContent)).toEqual(["2"]);
    expect(document.querySelector("h1")!.textContent).toBe("Title inner2");
  });

  it("waits for the desktop app's async confirm dialog, and honours Cancel", async () => {
    // The dialog plugin replaces window.confirm with a function returning a Promise.
    const set = (fn: () => unknown) => void ((window as unknown as { confirm: unknown }).confirm = fn);
    set(() => Promise.resolve(false));
    expect(await confirmAction("Delete?")).toBe(false);
    set(() => Promise.resolve(true));
    expect(await confirmAction("Delete?")).toBe(true);
    set(() => false);
    expect(await confirmAction("Delete?")).toBe(false);
  });
});
