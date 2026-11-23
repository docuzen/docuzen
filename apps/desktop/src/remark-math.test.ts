import { describe, expect, it } from "vitest";
import { remark } from "remark";
import remarkGfm from "remark-gfm";
import { remarkMath } from "./remark-math.js";

const processor = remark().use(remarkGfm).use(remarkMath);

const SCREENSHOT_EQ = String.raw`T_{\text{e2e}} = \underbrace{T_{\text{detect}}}_{\text{event / poll}} + \underbrace{T_{\text{fetch}}}_{\text{cloud/SaaS APIs}} + \underbrace{T_{\text{correlate + schedule}}}_{\text{who decides what to prove?}} + \underbrace{T_{\text{prove}}}_{\text{Kleene + Z3 + repair}}`;

function parse(md: string) {
  return processor.parse(md);
}

function roundTrip(md: string): string {
  return String(processor.stringify(processor.parse(md)));
}

describe("remarkMath: block display math", () => {
  it("parses single-line $$...$$ (the reported screenshot case) as a block math node with no emphasis corruption", () => {
    const md = `security change event from cloud mutation to verified proof:\n\n$$${SCREENSHOT_EQ}$$\n`;
    const tree = parse(md) as { children: Array<{ type: string; value?: string; data?: { multiline?: boolean } }> };
    expect(tree.children.map((n) => n.type)).toEqual(["paragraph", "math"]);
    expect(tree.children[1].value).toBe(SCREENSHOT_EQ);
    expect(tree.children[1].data?.multiline).toBe(false);
    expect(roundTrip(md)).toBe(md);
  });

  it("parses multi-line fenced $$ blocks, including blank lines inside, and preserves fence style", () => {
    const md = [
      "$$",
      String.raw`\begin{aligned}`,
      String.raw`a &= b + c \\`,
      "",
      String.raw`d &= e + f`,
      String.raw`\end{aligned}`,
      "$$",
      "",
    ].join("\n");
    const tree = parse(md) as { children: Array<{ type: string; value?: string; data?: { multiline?: boolean } }> };
    expect(tree.children).toHaveLength(1);
    expect(tree.children[0].type).toBe("math");
    expect(tree.children[0].data?.multiline).toBe(true);
    expect(tree.children[0].value).toContain("\n\n");
    expect(roundTrip(md)).toBe(md);
  });

  it("parses same-line-start multi-line $$ blocks without swallowing following paragraphs", () => {
    const md = "$$a + b\n+ c = d$$\n\nNext paragraph.\n";
    const tree = parse(md) as { children: Array<{ type: string; value?: string }> };
    expect(tree.children.map((n) => n.type)).toEqual(["math", "paragraph"]);
    expect(tree.children[0].value).toBe("a + b\n+ c = d");
  });

  it("handles escaped \\$ and trailing LaTeX linebreaks \\\\ inside $$...$$", () => {
    const escaped = String.raw`$$\$5 + \$10 = \$15$$` + "\n";
    const tree1 = parse(escaped) as { children: Array<{ type: string; value?: string }> };
    expect(tree1.children[0].type).toBe("math");
    expect(tree1.children[0].value).toBe(String.raw`\$5 + \$10 = \$15`);

    const doubleBackslash = String.raw`$$a \\ b \\$$` + "\n";
    const tree2 = parse(doubleBackslash) as { children: Array<{ type: string; value?: string }> };
    expect(tree2.children[0].type).toBe("math");
    expect(tree2.children[0].value).toBe(String.raw`a \\ b \\`);
  });

  it("allows display math to interrupt a paragraph and to sit inside blockquotes and lists", () => {
    const interrupt = "The formula is:\n$$x^2 + y^2 = z^2$$\n";
    const t1 = parse(interrupt) as { children: Array<{ type: string; value?: string }> };
    expect(t1.children.map((n) => n.type)).toEqual(["paragraph", "math"]);
    expect(t1.children[1].value).toBe("x^2 + y^2 = z^2");

    const quoted = "> $$\n> E = mc^2\n> $$\n";
    const t2 = parse(quoted) as { children: Array<{ type: string; children?: Array<{ type: string; value?: string }> }> };
    expect(t2.children[0].type).toBe("blockquote");
    expect(t2.children[0].children?.[0].type).toBe("math");
    expect(t2.children[0].children?.[0].value).toBe("E = mc^2");
    expect(roundTrip(quoted)).toBe(quoted);
  });

  it("does not treat unclosed $$foo as a math block", () => {
    const md = "$$unclosed formula\n\nSecond paragraph.\n";
    const tree = parse(md) as { children: Array<{ type: string }> };
    expect(tree.children.map((n) => n.type)).toEqual(["paragraph", "paragraph"]);
  });

  it("falls back to inline double-dollar math when prose follows $$...$$ on the same line", () => {
    const md = "$$a$$ + $$b$$\n";
    const tree = parse(md) as {
      children: Array<{ type: string; children?: Array<{ type: string; value?: string; data?: { doubleDollar?: boolean } }> }>;
    };
    expect(tree.children[0].type).toBe("paragraph");
    const kids = tree.children[0].children ?? [];
    expect(kids.map((c) => c.type)).toEqual(["inlineMath", "text", "inlineMath"]);
    expect(kids[0].value).toBe("a");
    expect(kids[0].data?.doubleDollar).toBe(true);
    expect(kids[2].value).toBe("b");
    expect(roundTrip(md)).toBe(md);
  });
});

describe("remarkMath: inline math and currency safety", () => {
  it("parses inline $...$ inside prose, headings, lists, and GFM tables, preserving underscores", () => {
    const md = [
      "## Latency $T_{\\text{e2e}}$",
      "",
      "We measure $T_{\\text{detect}} + T_{\\text{prove}}$ and $O(n \\log n)$.",
      "",
      "| Metric | Formula |",
      "| --- | --- |",
      "| Total | $a_1 + a_2$ |",
      "",
    ].join("\n");
    const tree = parse(md) as { children: Array<{ type: string; children?: unknown[] }> };
    expect(tree.children.map((n) => n.type)).toEqual(["heading", "paragraph", "table"]);
    const out = roundTrip(md);
    expect(out).toContain("$T_{\\text{e2e}}$");
    expect(out).toContain("$T_{\\text{detect}} + T_{\\text{prove}}$");
    expect(out).toContain("$O(n \\log n)$");
    expect(out).toContain("$a_1 + a_2$");
    expect(out).not.toContain("\\_");
  });

  it("never misparses currency amounts as math", () => {
    const cases = [
      "The cost is $5 and $10 per month.\n",
      "Plans range from $5-$10 or $100K-$200K.\n",
      "Price is $5 + $10 = $15.\n",
      "Costs ($5) or ($10) depending on tier.\n",
    ];
    for (const md of cases) {
      const tree = parse(md) as { children: Array<{ children?: Array<{ type: string }> }> };
      const types = (tree.children[0].children ?? []).map((n) => n.type);
      expect(types, md).not.toContain("inlineMath");
      expect(roundTrip(md)).toBe(md);
    }
  });

  it("handles currency and inline math in the same sentence", () => {
    const cases = [
      { md: "The fee is $5 and $x = 1$.\n", math: ["x = 1"] },
      { md: "Cost is $5-$10, where $x = 1$.\n", math: ["x = 1"] },
      { md: "Costs $10 ($x$) per unit.\n", math: ["x"] },
      { md: "For $a + b = c$, the cost is $5.\n", math: ["a + b = c"] },
      { md: "Costs $5 and $10, code `$z$`.\n", math: [] },
    ];
    for (const c of cases) {
      const tree = parse(c.md) as { children: Array<{ children?: Array<{ type: string; value?: string }> }> };
      const maths = (tree.children[0].children ?? []).filter((n) => n.type === "inlineMath").map((n) => n.value);
      expect(maths, c.md).toEqual(c.math);
      expect(roundTrip(c.md)).toBe(c.md);
    }
  });

  it("respects escaped dollars, code spans, fenced code blocks, and [[...]] directives", () => {
    const md = [
      "Escaped \\$x\\$ stays text, code `$y$` stays code, and [[keep me]] stays directive.",
      "",
      "```",
      "$$not_math$$",
      "```",
      "",
    ].join("\n");
    const tree = parse(md) as { children: Array<{ type: string; children?: Array<{ type: string }> }> };
    const inlineTypes = (tree.children[0].children ?? []).map((n) => n.type);
    expect(inlineTypes).not.toContain("inlineMath");
    expect(tree.children[1].type).toBe("code");
    // Re-parsing the round-tripped output must still produce zero inlineMath nodes.
    const reparsed = parse(roundTrip(md)) as { children: Array<{ children?: Array<{ type: string }> }> };
    expect((reparsed.children[0].children ?? []).map((n) => n.type)).not.toContain("inlineMath");
  });
});
