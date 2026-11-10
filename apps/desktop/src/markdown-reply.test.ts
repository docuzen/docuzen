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
});
