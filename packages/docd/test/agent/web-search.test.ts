import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import { afterAll, afterEach, beforeAll, describe, it, expect, vi } from "vitest";
import {
  parseDuckDuckGo,
  parseBrave,
  parseTavily,
  htmlToText,
  fetchUrl,
  isPrivateAddress,
  requestPinned,
  searchWeb,
  type FetchUrlDeps,
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

  it("judges an IPv4 address carried inside IPv6 by that IPv4 address", () => {
    for (const ip of [
      "::ffff:7f00:1", // mapped, in the hex form the URL parser normalizes to
      "[::ffff:7f00:1]",
      "::ffff:a9fe:a9fe", // 169.254.169.254
      "::ffff:10.0.0.1",
      "::7f00:1", // IPv4-compatible
      "::127.0.0.1",
      "::ffff:0:7f00:1", // IPv4-translated
      "::ffff:0:127.0.0.1",
      "64:ff9b::7f00:1", // NAT64
      "64:ff9b::192.168.0.1",
      "2002:7f00:1::1", // 6to4
      "2002:a9fe:a9fe::",
      "2001:0:4136:e378:8000:63bf:80ff:fffe", // Teredo, client 127.0.0.1 (stored inverted)
      "2001:0:a00:1::1", // Teredo, server 10.0.0.1
    ]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
  });

  it("flags multicast, reserved, documentation and other non-routable ranges", () => {
    for (const ip of [
      "224.0.0.1", "239.255.255.250", "240.0.0.1", "255.255.255.255", "0.1.2.3",
      "192.0.0.8", "192.0.2.1", "198.18.0.1", "198.19.255.255", "198.51.100.7", "203.0.113.9",
      "::ffff:224.0.0.1", "ff02::1", "ff0e::1", "fec0::1", "100::1", "64:ff9b:1::a",
      "2001:db8::1", "3fff::1", "fe80::1%lo0", "2001:10::1", "2001:2f::1", "2001:2::1",
    ]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
  });

  it("allows public addresses, including public IPv4 inside IPv6 transition forms", () => {
    for (const ip of [
      "93.184.216.34", "172.32.0.1", "8.8.8.8", "100.128.0.1", "198.20.0.1",
      "2606:4700:4700::1111", "2001:4860:4860::8888", "::ffff:8.8.8.8", "64:ff9b::808:808",
      "2002:808:808::1", "2001:30::1", "2001:200::1", "3fff:1000::1",
    ]) {
      expect(isPrivateAddress(ip), ip).toBe(false);
    }
  });
});

describe("fetchUrl guards", () => {
  const publicLookup = async () => ["93.184.216.34"];
  const page = (body: BodyInit | null, init: ResponseInit = {}) => new Response(body, init);
  type Request = NonNullable<FetchUrlDeps["request"]>;

  it("returns the readable text of a public page", async () => {
    const text = await fetchUrl("https://example.com/a", 8000, {
      request: async () => page("<p>Hello <b>world</b></p>"),
      lookup: publicLookup,
    });
    expect(text).toBe("Hello world");
  });

  it("refuses non-http schemes, IP literals in private ranges, and hosts that resolve privately", async () => {
    const never: Request = async () => {
      throw new Error("must not fetch");
    };
    await expect(fetchUrl("file:///etc/passwd", 8000, { request: never, lookup: publicLookup })).rejects.toThrow(
      "unsupported URL scheme",
    );
    await expect(fetchUrl("http://169.254.169.254/latest", 8000, { request: never, lookup: publicLookup })).rejects.toThrow(
      "private or local address",
    );
    await expect(fetchUrl("http://[::1]:8137/", 8000, { request: never, lookup: publicLookup })).rejects.toThrow(
      "private or local address",
    );
    await expect(
      fetchUrl("http://intranet.example/", 8000, { request: never, lookup: async () => ["93.184.216.34", "10.0.0.5"] }),
    ).rejects.toThrow("private or local address");
    await expect(fetchUrl("http://nowhere.example/", 8000, { request: never, lookup: async () => [] })).rejects.toThrow(
      "private or local address",
    );
  });

  it("connects only to the addresses it vetted, so a resolver that answers public then loopback is asked once", async () => {
    let calls = 0;
    const rebinding = async () => (++calls === 1 ? ["93.184.216.34"] : ["127.0.0.1"]);
    const pinned: string[][] = [];
    const text = await fetchUrl("http://rebind.example/", 8000, {
      lookup: rebinding,
      request: async (_url, init) => {
        pinned.push(init.addresses);
        return page("<p>public page</p>");
      },
    });
    expect(text).toBe("public page");
    expect(calls).toBe(1);
    expect(pinned).toEqual([["93.184.216.34"]]);
  });

  it("re-checks every redirect hop, so a public page cannot bounce the fetch to localhost", async () => {
    const seen: string[] = [];
    const fetcher: Request = async (input) => {
      seen.push(String(input));
      return page("", { status: 302, headers: { location: "http://127.0.0.1:8137/secret" } });
    };
    await expect(fetchUrl("https://example.com/", 8000, { request: fetcher, lookup: publicLookup })).rejects.toThrow(
      "private or local address",
    );
    expect(seen).toEqual(["https://example.com/"]);
  });

  it("resolves and pins each redirect hop on its own, refusing a hop whose host resolves privately", async () => {
    const dns: Record<string, string[]> = {
      "a.example": ["93.184.216.34"],
      "b.example": ["2606:4700:4700::1111"],
      "evil.example": ["192.168.1.10"],
    };
    const lookup = async (host: string) => dns[host] ?? [];
    const pinned: string[][] = [];
    const request: Request = async (url, init) => {
      pinned.push(init.addresses);
      if (url.hostname === "a.example") return page("", { status: 301, headers: { location: "http://b.example/next" } });
      return page("<p>landed</p>");
    };
    expect(await fetchUrl("http://a.example/", 8000, { lookup, request })).toBe("landed");
    expect(pinned).toEqual([["93.184.216.34"], ["2606:4700:4700::1111"]]);

    const toEvil: Request = async () => page("", { status: 302, headers: { location: "http://evil.example/" } });
    await expect(fetchUrl("http://a.example/", 8000, { lookup, request: toEvil })).rejects.toThrow(
      "private or local address",
    );
  });

  it("gives up on a redirect loop", async () => {
    const fetcher: Request = async () => page("", { status: 301, headers: { location: "/again" } });
    await expect(fetchUrl("https://example.com/", 8000, { request: fetcher, lookup: publicLookup })).rejects.toThrow(
      "too many redirects",
    );
  });

  it("releases the body of a redirect or error response instead of leaving it unread", async () => {
    let cancelled = 0;
    const body = () =>
      new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(new TextEncoder().encode("x"));
        },
        cancel() {
          cancelled++;
        },
      });
    let hop = 0;
    const redirectThenPage: Request = async () =>
      hop++ === 0 ? page(body(), { status: 302, headers: { location: "/final" } }) : page("<p>ok</p>");
    expect(await fetchUrl("https://example.com/", 8000, { request: redirectThenPage, lookup: publicLookup })).toBe("ok");
    expect(cancelled).toBe(1);

    const serverError: Request = async () => page(body(), { status: 500 });
    await expect(fetchUrl("https://example.com/", 8000, { request: serverError, lookup: publicLookup })).rejects.toThrow(
      "fetch failed: 500",
    );
    expect(cancelled).toBe(2);
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
      request: async () => new Response(body),
      lookup: publicLookup,
    });
    expect(text.endsWith("…[truncated]")).toBe(true);
    expect(pulled).toBeLessThan(10); // ~2 MB cap at 500 KB per chunk
  });
});

describe("web requests against a local server", () => {
  let server: Server;
  let port: number;
  const hits: Array<{ url: string; host: string }> = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      hits.push({ url: req.url ?? "", host: req.headers.host ?? "" });
      if (req.url === "/gzip") {
        res.writeHead(200, { "content-type": "text/html", "content-encoding": "gzip" });
        res.end(gzipSync("<p>compressed page</p>"));
      } else if (req.url === "/odd-status") {
        res.writeHead(999);
        res.end("?");
      } else if (req.url === "/moved") {
        res.writeHead(302, { location: "/elsewhere" });
        res.end("moved");
      } else {
        res.writeHead(200, { "content-type": "text/html" });
        res.end("<p>local secret</p>");
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
  afterEach(() => {
    hits.length = 0;
  });

  it("refuses every spelling of a loopback address before connecting", async () => {
    for (const host of [
      "127.0.0.1",
      "[::ffff:127.0.0.1]",
      "[::ffff:7f00:1]",
      "[::127.0.0.1]",
      "[::ffff:0:127.0.0.1]",
      "[64:ff9b::127.0.0.1]",
      "[2002:7f00:1::]",
      "[2001:0:4136:e378:8000:63bf:80ff:fffe]",
      "0x7f.1",
      "2130706433",
      "localhost",
    ]) {
      await expect(fetchUrl(`http://${host}:${port}/`), host).rejects.toThrow("private or local address");
    }
    expect(hits).toEqual([]);
  });

  it("connects to the pinned address and never resolves the URL's hostname itself", async () => {
    // .invalid never resolves, so reaching the server proves the pinned address was used.
    const res = await requestPinned(new URL(`http://docuzen-pin.invalid:${port}/page`), {
      addresses: ["127.0.0.1"],
      headers: { "User-Agent": "test" },
      signal: AbortSignal.timeout(5_000),
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("<p>local secret</p>");
    expect(hits).toEqual([{ url: "/page", host: `docuzen-pin.invalid:${port}` }]);
  });

  it("hands back redirects unfollowed and decodes compressed pages", async () => {
    const init = { addresses: ["127.0.0.1"], headers: {}, signal: AbortSignal.timeout(5_000) };
    const moved = await requestPinned(new URL(`http://pin.invalid:${port}/moved`), init);
    expect(moved.status).toBe(302);
    expect(moved.headers.get("location")).toBe("/elsewhere");
    await moved.body?.cancel();

    const gz = await requestPinned(new URL(`http://pin.invalid:${port}/gzip`), init);
    expect(await gz.text()).toBe("<p>compressed page</p>");

    await expect(requestPinned(new URL(`http://pin.invalid:${port}/odd-status`), init)).rejects.toThrow(RangeError);
    expect(hits.map((h) => h.url)).toEqual(["/moved", "/gzip", "/odd-status"]);
  });
});

describe("searchWeb", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("releases the body of a failed search response", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode("{}"));
      },
      cancel() {
        cancelled = true;
      },
    });
    vi.stubGlobal("fetch", async () => new Response(body, { status: 503 }));
    await expect(searchWeb("docuzen")).rejects.toThrow("DuckDuckGo search failed: 503");
    expect(cancelled).toBe(true);
  });
});
