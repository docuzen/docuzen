// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { buildHtmlProjection, rangeForOffsets, wrapRange } from "./html-projection.js";
import { serializeDocument } from "./html-surface.js";

const SVG_NS = "http://www.w3.org/2000/svg";

// The window's own document: happy-dom's Range.surroundContents loses the text in a
// document made by createHTMLDocument.
function docWith(body: string): Document {
  document.body.innerHTML = body;
  return document;
}

/**
 * A diagram as Visualize → Insert into doc writes it: an inline SVG with its own stylesheet,
 * definitions, a tooltip title, a drawn <text> label and an HTML label in a foreignObject.
 * (Built with DOM calls: happy-dom's parser drops everything after an SVG <style>.)
 */
function appendDiagram(d: Document, parent: Element): SVGSVGElement {
  const svg = d.createElementNS(SVG_NS, "svg") as SVGSVGElement;
  const add = (p: Element, name: string, text?: string): Element => {
    const el = d.createElementNS(SVG_NS, name);
    if (text !== undefined) el.textContent = text;
    p.appendChild(el);
    return el;
  };
  add(svg, "style", "#m .node rect{fill:#ECECFF;stroke:#9370DB}");
  add(svg, "script", "console.log('diagram')");
  add(add(svg, "defs"), "marker", "arrowhead");
  add(svg, "title", "Flow chart");
  add(svg, "desc", "A flow chart of the loop");
  add(svg, "text", "Drawn label");
  const fo = add(svg, "foreignObject");
  const div = d.createElement("div");
  div.textContent = "Html label";
  fo.appendChild(div);
  parent.appendChild(svg);
  return svg;
}

describe("HTML text projection", () => {
  it("leaves an inline SVG's stylesheet, script and metadata out (their tagName is lower case)", () => {
    const d = docWith("<p>Before</p><figure></figure><p>After</p>");
    appendDiagram(d, d.querySelector("figure")!);
    const { text } = buildHtmlProjection(d.body);
    for (const hidden of ["fill:#ECECFF", "console.log", "arrowhead", "Flow chart", "A flow chart"]) {
      expect(text).not.toContain(hidden);
    }
    expect(text).toContain("Before");
    expect(text).toContain("Html label");
    expect(text).toContain("After");
  });

  it("leaves out drawn SVG text, which the surface cannot mark (an HTML span inside SVG is not drawn)", () => {
    const d = docWith("<p>Before</p><figure></figure>");
    appendDiagram(d, d.querySelector("figure")!);
    expect(buildHtmlProjection(d.body).text).not.toContain("Drawn label");
  });
});

describe("wrapping a range in marks", () => {
  const mark = (d: Document) => () => {
    const s = d.createElement("span");
    s.setAttribute("data-had-mark", "");
    return s;
  };
  const wrapAll = (d: Document) => {
    const proj = buildHtmlProjection(d.body);
    const range = rangeForOffsets(d, proj, 0, proj.text.length)!;
    return wrapRange(d, range, mark(d));
  };

  it("never puts a mark inside style or script, an SVG, or docuzen's own controls", () => {
    const d = docWith(
      '<p id="a">Alpha <span data-had-overlay="" class="had-badge">1</span></p>' +
        "<style>p { color: red }</style><script>var x = 1;</script><figure></figure><p>Omega</p>",
    );
    appendDiagram(d, d.querySelector("figure")!);
    const spans = wrapAll(d);
    expect(spans.length).toBeGreaterThan(0);
    for (const s of spans) {
      expect(s.closest("style, script, [data-had-overlay]")).toBeNull();
      expect(s.parentElement!.namespaceURI).toBe("http://www.w3.org/1999/xhtml");
      expect(s.parentElement!.closest("svg") && !s.parentElement!.closest("foreignObject")).toBeFalsy();
    }
    expect(d.querySelector("style")!.children.length).toBe(0);
    expect(d.querySelector("script")!.children.length).toBe(0);
    expect(d.querySelector(".had-badge")!.children.length).toBe(0);
    expect(d.querySelector("svg text")!.children.length).toBe(0);
    // Text that is really on the page is marked, the foreignObject's HTML label included.
    const marked = spans.map((s) => s.textContent).join("");
    expect(marked).toContain("Alpha");
    expect(marked).toContain("Html label");
    expect(marked).toContain("Omega");
  });

  it("does not mark the whitespace between rows, cells and list items (it would become a stray table cell)", () => {
    const d = docWith("<table>\n<tr>\n<td>one</td>\n<td>two</td>\n</tr>\n</table>\n<ul>\n<li>three</li>\n</ul>");
    const spans = wrapAll(d);
    for (const s of spans) {
      expect(["TABLE", "TBODY", "TR", "UL"]).not.toContain(s.parentElement!.tagName);
    }
    expect(d.querySelectorAll("table [data-had-mark], ul [data-had-mark]").length).toBe(3);
    expect(spans.map((s) => s.textContent).filter((t) => t!.trim())).toEqual(["one", "two", "three"]);
    // The marks come off again on save.
    expect(serializeDocument(d)).not.toContain("data-had-mark");
  });

  it("marks a range that lies inside one text node", () => {
    const d = docWith("<p>Hello world</p>");
    const proj = buildHtmlProjection(d.body);
    const spans = wrapRange(d, rangeForOffsets(d, proj, 6, 11)!, mark(d));
    expect(spans.map((s) => s.textContent)).toEqual(["world"]);
  });
});
