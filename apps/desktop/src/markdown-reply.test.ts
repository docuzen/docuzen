// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";

const openUrl = vi.fn(async (_url: string) => {});
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: (u: string) => openUrl(u) }));

import { markdownReplyHtml, renderMarkdownReply } from "./markdown-reply.js";

describe("agent replies render as markdown", () => {
  it("renders bold, lists and code instead of showing the syntax", () => {
    const html = markdownReplyHtml("**Improve** the intro:\n\n- one\n- two\n\nUse `npm test`.\n\n```js\nconst a = 1 < 2;\n```");
    expect(html).toContain("<strong>Improve</strong>");
    expect(html).toContain("<li>one</li>");
    expect(html).toContain("<code>npm test</code>");
    expect(html).toContain("const a = 1 &lt; 2;");
    expect(html).not.toContain("**");
  });

  it("shows raw HTML from the model as text and never runs it", () => {
    const into = document.createElement("div");
    renderMarkdownReply(into, 'Wrap it in <div class="x">…</div>.\n\n<script>window.pwned = 1</script>\n\n<img src=x onerror="window.pwned = 1">');
    expect(into.querySelector("script, img, div")).toBeNull();
    expect(into.textContent).toContain('<div class="x">');
    expect(into.textContent).toContain("<script>");
  });

  it("drops javascript: links", () => {
    const into = document.createElement("div");
    renderMarkdownReply(into, "[x](javascript:alert(1)) and [y](/etc/passwd)");
    expect([...into.querySelectorAll("a")].map((a) => a.getAttribute("href"))).toEqual([null, null]);
  });

  it("opens links in the system browser instead of navigating the app window", () => {
    const into = document.createElement("div");
    renderMarkdownReply(into, "See [the docs](https://example.com/a).");
    const a = into.querySelector("a")!;
    const ev = new MouseEvent("click", { bubbles: true, cancelable: true });
    a.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(openUrl).toHaveBeenCalledWith("https://example.com/a");
  });

  it("a plain one-line reply stays one line of text", () => {
    const into = document.createElement("div");
    renderMarkdownReply(into, "Looks fine.");
    expect(into.textContent).toBe("Looks fine.");
    expect(into.classList.contains("md")).toBe(true);
  });

  it("renders inline and block LaTeX math in agent replies while leaving currency and code alone", () => {
    const into = document.createElement("div");
    renderMarkdownReply(
      into,
      [
        "Latency is $T_{\\text{e2e}}$ (costs $5 and $10, code `$z$`).",
        "",
        "$$T_{\\text{e2e}} = \\underbrace{T_{\\text{detect}}}_{\\text{event}} + T_{\\text{prove}}$$",
        "",
        "Also \\(x^2 + 1\\) and:",
        "",
        "```math",
        "\\sum_{i=1}^n i",
        "```",
      ].join("\n"),
    );
    expect(into.querySelectorAll(".math-reply-inline .katex").length).toBe(2);
    expect(into.querySelectorAll(".math-reply-block .katex-display").length).toBe(2);
    expect(into.querySelector(".katex-error")).toBeNull();
    expect(into.textContent).toContain("$5 and $10");
    expect(into.querySelector("code")?.textContent).toBe("$z$");
  });

  it("blocks untrusted LaTeX commands and raw HTML alongside math in agent replies", () => {
    const into = document.createElement("div");
    renderMarkdownReply(
      into,
      'See $\\href{javascript:alert(1)}{x}$ and <script>window.pwned = 1</script> and <img src=x onerror="1">.',
    );
    expect(into.querySelector("a, script, img")).toBeNull();
    expect(into.querySelector(".math-reply-inline .katex")).not.toBeNull();
    expect(into.textContent).toContain("<script>");
  });
});
