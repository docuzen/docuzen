import { describe, it, expect } from "vitest";
import {
  parseDuckDuckGo,
  parseBrave,
  parseTavily,
  htmlToText,
} from "../../src/agent/web-search.js";

describe("web-search parsers", () => {
  it("parses a DuckDuckGo instant answer + related topics", () => {
    const json = {
      Heading: "API gateway",
      AbstractText: "An API gateway is a server that routes requests.",
      AbstractURL: "https://en.wikipedia.org/wiki/API_gateway",
      RelatedTopics: [
        { Text: "Rate limiting - controlling request rates", FirstURL: "https://example.com/rate" },
        { Topics: [{ Text: "Token bucket algorithm", FirstURL: "https://example.com/tb" }] },
      ],
      Results: [],
    };
    const r = parseDuckDuckGo(json);
    expect(r[0]).toEqual({
      title: "API gateway",
      url: "https://en.wikipedia.org/wiki/API_gateway",
      snippet: "An API gateway is a server that routes requests.",
    });
    expect(r.map((x) => x.url)).toContain("https://example.com/rate");
    expect(r.map((x) => x.url)).toContain("https://example.com/tb"); // nested topic flattened
  });

  it("parses Brave web results", () => {
    const r = parseBrave({
      web: { results: [{ title: "T", url: "https://b.com", description: "snippet" }] },
    });
    expect(r).toEqual([{ title: "T", url: "https://b.com", snippet: "snippet" }]);
  });

  it("parses Tavily results", () => {
    const r = parseTavily({ results: [{ title: "T", url: "https://t.com", content: "body" }] });
    expect(r).toEqual([{ title: "T", url: "https://t.com", snippet: "body" }]);
  });

  it("returns [] for empty/missing payloads", () => {
    expect(parseDuckDuckGo({})).toEqual([]);
    expect(parseBrave({})).toEqual([]);
    expect(parseTavily({})).toEqual([]);
  });

  it("strips scripts, styles, and markup to readable text", () => {
    const html =
      "<html><head><style>.x{color:red}</style></head><body><script>evil()</script><h1>Hi</h1><p>Body&nbsp;text &amp; more</p></body></html>";
    expect(htmlToText(html)).toBe("Hi Body text & more");
  });
});
