import { describe, it, expect } from "vitest";
import { parseDuckDuckGo, parseBrave, parseTavily, htmlToText, fetchUrl, isPrivateAddress } from "../../src/agent/web-search.js";

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

describe("isPrivateAddress", () => {
  it("flags loopback, private, link-local, CGNAT and unspecified addresses", () => {
    for (const ip of [
      "127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1",
      "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "::", "fd00::1", "fe80::1",
      "::ffff:127.0.0.1", "[::1]",
    ]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
  });

  it("allows public addresses", () => {
    for (const ip of ["93.184.216.34", "172.32.0.1", "8.8.8.8", "2606:4700:4700::1111"]) {
      expect(isPrivateAddress(ip), ip).toBe(false);
    }
  });
});

describe("fetchUrl guards", () => {
  const publicLookup = async () => ["93.184.216.34"];
  const page = (body: string, init: ResponseInit = {}) => new Response(body, init);

  it("returns the readable text of a public page", async () => {
    const text = await fetchUrl("https://example.com/a", 8000, {
      fetch: (async () => page("<p>Hello <b>world</b></p>")) as typeof fetch,
      lookup: publicLookup,
    });
    expect(text).toBe("Hello world");
  });

  it("refuses non-http schemes, IP literals in private ranges, and hosts that resolve privately", async () => {
    const never = (async () => {
      throw new Error("must not fetch");
    }) as typeof fetch;
    await expect(fetchUrl("file:///etc/passwd", 8000, { fetch: never, lookup: publicLookup })).rejects.toThrow(
      "unsupported URL scheme",
    );
    await expect(fetchUrl("http://169.254.169.254/latest", 8000, { fetch: never, lookup: publicLookup })).rejects.toThrow(
      "private or local address",
    );
    await expect(fetchUrl("http://[::1]:8137/", 8000, { fetch: never, lookup: publicLookup })).rejects.toThrow(
      "private or local address",
    );
    await expect(
      fetchUrl("http://intranet.example/", 8000, { fetch: never, lookup: async () => ["93.184.216.34", "10.0.0.5"] }),
    ).rejects.toThrow("private or local address");
  });

  it("re-checks every redirect hop, so a public page cannot bounce the fetch to localhost", async () => {
    const seen: string[] = [];
    const fetcher = (async (input: URL) => {
      seen.push(String(input));
      return page("", { status: 302, headers: { location: "http://127.0.0.1:8137/secret" } });
    }) as unknown as typeof fetch;
    await expect(fetchUrl("https://example.com/", 8000, { fetch: fetcher, lookup: publicLookup })).rejects.toThrow(
      "private or local address",
    );
    expect(seen).toEqual(["https://example.com/"]);
  });

  it("gives up on a redirect loop", async () => {
    const fetcher = (async () => page("", { status: 301, headers: { location: "/again" } })) as typeof fetch;
    await expect(fetchUrl("https://example.com/", 8000, { fetch: fetcher, lookup: publicLookup })).rejects.toThrow(
      "too many redirects",
    );
  });

  it("stops reading an oversized body instead of buffering all of it", async () => {
    let pulled = 0;
    const chunk = new TextEncoder().encode("x".repeat(500_000));
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++;
        controller.enqueue(chunk); // endless
      },
    });
    const text = await fetchUrl("https://example.com/big", 100, {
      fetch: (async () => new Response(body)) as typeof fetch,
      lookup: publicLookup,
    });
    expect(text.endsWith("…[truncated]")).toBe(true);
    expect(pulled).toBeLessThan(10); // ~2 MB cap at 500 KB per chunk
  });
});
