// @vitest-environment happy-dom
//
// The mermaid lightbox (mermaid-lightbox.ts) on index.html's markup. It wires itself once,
// on first open, so the markup is put in place once for the whole file.
import { beforeAll, describe, expect, it } from "vitest";
import { openMermaidLightbox } from "./mermaid-lightbox.js";
import { bodyHtml } from "./editor-harness.test-support.js";

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

let diagram: SVGSVGElement;
beforeAll(() => {
  document.body.innerHTML = bodyHtml;
  const holder = document.createElement("div");
  holder.innerHTML = '<svg viewBox="0 0 10 10"><g id="flowchart-A-0"><rect width="5" height="5"/></g></svg>';
  $("#editor").appendChild(holder);
  diagram = holder.querySelector("svg")!;
});

const stage = () => $("#mermaidLbStage");
const escape = () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

describe("closing the mermaid lightbox", () => {
  it("drops the cloned diagram when the backdrop is clicked (no duplicate element ids left behind)", () => {
    openMermaidLightbox(diagram);
    expect(document.querySelectorAll('[id="flowchart-A-0"]')).toHaveLength(2);

    $("#mermaidLightbox").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect($("#mermaidLightbox").hidden).toBe(true);
    expect(stage().childElementCount).toBe(0);
    expect(document.querySelectorAll('[id="flowchart-A-0"]')).toHaveLength(1);
  });

  it("ends a drag in progress when closed with Escape", () => {
    openMermaidLightbox(diagram);
    stage().dispatchEvent(new MouseEvent("mousedown", { button: 0, clientX: 10, clientY: 10, bubbles: true, cancelable: true }));
    expect(stage().classList.contains("dragging")).toBe(true);
    escape();
    expect($("#mermaidLightbox").hidden).toBe(true);
    expect(stage().classList.contains("dragging")).toBe(false);

    // Reopened, a mouse move without a press must not pan the diagram.
    openMermaidLightbox(diagram);
    window.dispatchEvent(new MouseEvent("mousemove", { clientX: 200, clientY: 150, bubbles: true }));
    expect(stage().querySelector("svg")!.style.transform).toBe("translate(0px, 0px) scale(1)");
    escape();
  });
});
