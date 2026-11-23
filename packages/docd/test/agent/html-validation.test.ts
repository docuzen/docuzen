import { describe, expect, it } from "vitest";
import { validateHtml } from "../../src/agent/html-validation.js";

describe("validateHtml", () => {
  it("accepts a '<' in text that does not start a tag", () => {
    for (const html of [
      "<p>latency < 100ms</p>",
      "<p>if x < y</p>",
      "<p>if x < 5, it's ok</p>",
      "<p>a <= b and c >= d</p>",
      "<p>I <3 HTML</p>",
      "<ul><li>1 < 2</li><li>it's \"quoted\"</li></ul>",
      "<p>ends with <</p>",
      "trailing <",
    ]) {
      expect(validateHtml(html), html).toEqual({ ok: true });
    }
  });

  it("accepts unquoted attribute values, including ones ending in '/'", () => {
    for (const html of [
      "<a href=https://example.com/>link</a>",
      "<a href=/docs/>docs</a>",
      "<a title=it's>x</a>",
      "<img src=a.png alt=x/>",
    ]) {
      expect(validateHtml(html), html).toEqual({ ok: true });
    }
  });

  it("treats textarea and title content as text", () => {
    for (const html of [
      "<html><head><title>Tags like <p> and </div></title></head><body></body></html>",
      "<textarea><p>draft</textarea>",
      "<TEXTAREA>a < b</TEXTAREA>",
    ]) {
      expect(validateHtml(html), html).toEqual({ ok: true });
    }
  });

  it("still accepts ordinary well-formed documents", () => {
    for (const html of [
      "<!doctype html>\n<html><body><section><p>Redis</p></section></body></html>\n",
      "<p>a<br>b<br/>c<img src=\"x.png\"/></p>",
      "<svg viewBox=\"0 0 1 1\"><path d=\"M0 0\"/><title>Chart</title></svg>",
      "<script>if (a < b && c > d) { x = '</p>'; }</script><p>x</p>",
      "<style>a > b { color: red }</style>",
      "<!-- <p> --><p>x</p><?xml stuff?>",
      "<div data-x='a>b'>y</div>",
    ]) {
      expect(validateHtml(html), html).toEqual({ ok: true });
    }
  });

  it("still rejects broken markup", () => {
    const cases: Array<[string, RegExp]> = [
      ["<section><p>Memcached</section>", /expected <\/p> before <\/section>/],
      ["<p>Memcached", /unclosed <p>/],
      ["<p>x</p></div>", /unexpected <\/div>/],
      ["<div class=\"x>text</div>", /unclosed <tag>/],
      ["<p>x</p><p", /unclosed <tag>/],
      ["<script>let a = 1;", /unclosed <script>/],
      ["<textarea>draft", /unclosed <textarea>/],
      ["<title>Doc", /unclosed <title>/],
      ["<!-- never closed", /unclosed <!-- comment -->/],
      // An unquoted value ending in "/" does not make the tag self-closing.
      ["<p><a href=https://example.com/>link</p>", /expected <\/a> before <\/p>/],
      // "</ p>" is not an end tag in HTML (it is a bogus comment), so the <p> stays open.
      ["<p>x</ p>", /unclosed <p>/],
      // A '<' directly followed by a letter does start a tag.
      ["<p>if x <y</p>", /unclosed|expected/],
    ];
    for (const [html, error] of cases) {
      const result = validateHtml(html);
      expect(result.ok, html).toBe(false);
      expect(result.error, html).toMatch(error);
    }
  });

  it("reports where the mismatch is and where the open tag started", () => {
    expect(validateHtml("<div>\n  <p>x <b>y</b>\n</div>")).toEqual({
      ok: false,
      error: "expected </p> before </div> at line 3, column 1 (opened <p> at line 2, column 3)",
    });
  });

  it("validates a large document in one pass (approval runs this on the whole page)", () => {
    const html = "<html><body>" + "<p>Some <b>bold</b> text.</p>\n".repeat(20_000) + "</body></html>";
    const started = performance.now();
    expect(validateHtml(html)).toEqual({ ok: true });
    expect(performance.now() - started).toBeLessThan(2_000); // was ~50 s: line/column rescanned per tag
  });
});
