// Web search + fetch for the agent. pi has no built-in web tool, so this provides one,
// behind a provider abstraction. Default is DuckDuckGo's official Instant Answer API
// (keyless, ToS-permitted); Brave and Tavily are opt-in and read their key from the
// environment (BRAVE_API_KEY / TAVILY_API_KEY) — keys are never stored in the .had sidecar.

import type { LookupAddress } from "node:dns";
import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { Readable, pipeline } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";

export type WebSearchProvider = "ddg" | "brave" | "tavily";

/** Every outbound request the agent can trigger is bounded: a hung host can't stall a turn. */
const FETCH_TIMEOUT_MS = 15_000;
/** Bytes read from a fetched page before the body is cut off (the text is truncated further). */
const MAX_BODY_BYTES = 2_000_000;
const MAX_REDIRECTS = 5;

export interface WebSearchConfig {
  enabled?: boolean;
  provider?: WebSearchProvider;
}

export interface WebResult {
  title: string;
  url: string;
  snippet: string;
}

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Parse DuckDuckGo Instant Answer JSON into results (abstract + related topics). */
export function parseDuckDuckGo(json: any): WebResult[] {
  const out: WebResult[] = [];
  if (json?.AbstractText && json?.AbstractURL) {
    out.push({
      title: json.Heading || "Summary",
      url: json.AbstractURL,
      snippet: json.AbstractText,
    });
  }
  const walk = (topics: any[] | undefined): void => {
    for (const t of topics ?? []) {
      if (t?.FirstURL && t?.Text) {
        out.push({ title: String(t.Text).split(" - ")[0] || t.Text, url: t.FirstURL, snippet: t.Text });
      } else if (Array.isArray(t?.Topics)) {
        walk(t.Topics);
      }
    }
  };
  walk(json?.RelatedTopics);
  walk(json?.Results);
  return out;
}

/** Parse Brave Web Search API JSON into results. */
export function parseBrave(json: any): WebResult[] {
  return (json?.web?.results ?? []).map((r: any) => ({
    title: r?.title ?? "",
    url: r?.url ?? "",
    snippet: r?.description ?? "",
  }));
}

/** Parse Tavily search JSON into results. */
export function parseTavily(json: any): WebResult[] {
  return (json?.results ?? []).map((r: any) => ({
    title: r?.title ?? "",
    url: r?.url ?? "",
    snippet: r?.content ?? "",
  }));
}

/* eslint-enable @typescript-eslint/no-explicit-any */

/** Strip a fetched HTML page down to readable text (no scripts/styles/markup). */
export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

/** Release a response body that will not be read, so its connection is freed now, not at GC. */
async function discard(res: Response): Promise<void> {
  await res.body?.cancel().catch(() => {});
}

async function failed(res: Response, what: string): Promise<Error> {
  await discard(res);
  return new Error(`${what}: ${res.status}`);
}

/** Run a web search via the configured provider. Throws if a key-based provider lacks its key. */
export async function searchWeb(query: string, cfg: WebSearchConfig = {}): Promise<WebResult[]> {
  const provider = cfg.provider ?? "ddg";
  if (provider === "brave") {
    const key = process.env.BRAVE_API_KEY;
    if (!key) throw new Error("Brave search selected but BRAVE_API_KEY is not set");
    const res = await fetch(
      `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=8`,
      { headers: { "X-Subscription-Token": key, Accept: "application/json" }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) },
    );
    if (!res.ok) throw await failed(res, "Brave search failed");
    return parseBrave(await res.json());
  }
  if (provider === "tavily") {
    const key = process.env.TAVILY_API_KEY;
    if (!key) throw new Error("Tavily search selected but TAVILY_API_KEY is not set");
    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_key: key, query, max_results: 8, search_depth: "basic" }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) throw await failed(res, "Tavily search failed");
    return parseTavily(await res.json());
  }
  // Default: DuckDuckGo official Instant Answer API (keyless, no registration).
  const res = await fetch(
    `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&no_redirect=1&t=docuzen`,
    { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) },
  );
  if (!res.ok) throw await failed(res, "DuckDuckGo search failed");
  return parseDuckDuckGo(await res.json());
}

const ipv4ToInt = (ip: string): number => ip.split(".").reduce((n, part) => n * 256 + Number(part), 0);

/** IPv4 ranges that are not globally reachable (IANA special-purpose registry). */
const BLOCKED_V4: Array<[base: number, prefix: number]> = (
  [
    ["0.0.0.0", 8], // "this network"
    ["10.0.0.0", 8], // private
    ["100.64.0.0", 10], // carrier-grade NAT
    ["127.0.0.0", 8], // loopback
    ["169.254.0.0", 16], // link-local, incl. the 169.254.169.254 cloud-metadata endpoint
    ["172.16.0.0", 12], // private
    ["192.0.0.0", 24], // IETF protocol assignments
    ["192.0.2.0", 24], // documentation
    ["192.88.99.0", 24], // 6to4 relay anycast (deprecated)
    ["192.168.0.0", 16], // private
    ["198.18.0.0", 15], // benchmarking
    ["198.51.100.0", 24], // documentation
    ["203.0.113.0", 24], // documentation
    ["224.0.0.0", 4], // multicast
    ["240.0.0.0", 4], // reserved, incl. 255.255.255.255 broadcast
  ] as const
).map(([base, prefix]) => [ipv4ToInt(base), prefix]);

function isBlockedV4(ip: number): boolean {
  return BLOCKED_V4.some(([base, prefix]) => ip >>> (32 - prefix) === base >>> (32 - prefix));
}

/** The eight 16-bit groups of a valid IPv6 address (zone id dropped, "::" expanded). */
function ipv6Groups(ip: string): number[] {
  let text = ip.split("%")[0];
  const quad = /(\d+\.\d+\.\d+\.\d+)$/.exec(text); // a trailing dotted quad is the last two groups
  if (quad) {
    const v4 = ipv4ToInt(quad[1]);
    text = `${text.slice(0, quad.index)}${(v4 >>> 16).toString(16)}:${(v4 & 0xffff).toString(16)}`;
  }
  const parse = (part: string): number[] => (part ? part.split(":").map((g) => parseInt(g, 16)) : []);
  const [head, tail] = text.split("::");
  if (tail === undefined) return parse(head);
  const left = parse(head);
  const right = parse(tail);
  return [...left, ...Array<number>(8 - left.length - right.length).fill(0), ...right];
}

function isBlockedV6(g: number[]): boolean {
  const v4 = (hi: number, lo: number): number => hi * 0x10000 + lo;
  const zero = (from: number, to: number): boolean => g.slice(from, to).every((x) => x === 0);
  // Forms that carry an IPv4 address are judged by that address: traffic to them can end up there.
  if (zero(0, 5) && g[5] === 0xffff) return isBlockedV4(v4(g[6], g[7])); // ::ffff:0:0/96 mapped
  if (zero(0, 4) && g[4] === 0xffff && g[5] === 0) return isBlockedV4(v4(g[6], g[7])); // ::ffff:0:0:0/96 translated
  if (zero(0, 6)) return isBlockedV4(v4(g[6], g[7])); // ::/96 compatible; "::" and "::1" land in 0.0.0.0/8
  if (g[0] === 0x64 && g[1] === 0xff9b && zero(2, 6)) return isBlockedV4(v4(g[6], g[7])); // 64:ff9b::/96 NAT64
  if (g[0] === 0x2002) return isBlockedV4(v4(g[1], g[2])); // 2002::/16 6to4
  if (g[0] === 0x2001 && g[1] === 0) {
    // 2001::/32 Teredo: the server's address, and the client's stored bit-inverted.
    return isBlockedV4(v4(g[2], g[3])) || isBlockedV4(v4(g[6] ^ 0xffff, g[7] ^ 0xffff));
  }
  // Only global unicast (2000::/3) is reachable on the internet. That excludes ULA
  // (fc00::/7), link-local (fe80::/10), multicast (ff00::/8), discard (100::/64), local
  // NAT64 (64:ff9b:1::/48) and the rest of the reserved space.
  if ((g[0] & 0xe000) !== 0x2000) return true;
  return (
    (g[0] === 0x2001 && g[1] === 0x0db8) || // 2001:db8::/32 documentation
    (g[0] === 0x2001 && g[1] === 0x0002 && g[2] === 0) || // 2001:2::/48 benchmarking
    (g[0] === 0x2001 && g[1] >= 0x0010 && g[1] <= 0x002f) || // 2001:10::/28, 2001:20::/28 ORCHID
    (g[0] === 0x3fff && g[1] < 0x1000) // 3fff::/20 documentation
  );
}

/**
 * True for addresses a web fetch must never reach: anything not globally reachable —
 * loopback, private (RFC 1918 / ULA), link-local (incl. the 169.254.169.254
 * cloud-metadata endpoint), CGNAT, unspecified, multicast and reserved ranges — and any
 * IPv6 address that carries such an IPv4 address (mapped, compatible, translated, NAT64,
 * 6to4, Teredo). The URL comes from a model that has just read untrusted web/search
 * content, so without this a prompt-injected page could make the sidecar probe the
 * user's own machine or LAN.
 */
export function isPrivateAddress(address: string): boolean {
  const ip = address.toLowerCase().replace(/^\[|\]$/g, "");
  const family = isIP(ip);
  if (family === 4) return isBlockedV4(ipv4ToInt(ip));
  if (family === 6) return isBlockedV6(ipv6Groups(ip));
  return true; // not an IP literal at all — callers resolve hostnames first
}

export interface PinnedRequestInit {
  /** Vetted addresses for the URL's host: the connection goes to these and nowhere else. */
  addresses: string[];
  headers: Record<string, string>;
  signal: AbortSignal;
}

export interface FetchUrlDeps {
  /** Resolve a hostname to every address it maps to. */
  lookup?: (hostname: string) => Promise<string[]>;
  /** GET `url` over a connection to one of `init.addresses`, without following redirects. */
  request?: (url: URL, init: PinnedRequestInit) => Promise<Response>;
}

async function defaultLookup(hostname: string): Promise<string[]> {
  return (await dnsLookup(hostname, { all: true })).map((r) => r.address);
}

/**
 * The addresses `url` may be fetched from: throws unless it is http(s) and every address
 * its host resolves to is public. The fetch must connect to these very addresses —
 * resolving the host again would let DNS answer differently the second time.
 */
async function publicAddresses(url: URL, lookup: (hostname: string) => Promise<string[]>): Promise<string[]> {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`unsupported URL scheme ${url.protocol}`);
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host) ? [host] : await lookup(host);
  if (!addresses.length || addresses.some(isPrivateAddress)) {
    throw new Error(`refusing to fetch ${url.hostname}: it resolves to a private or local address`);
  }
  return addresses;
}

/** A body stream with its content-encoding (gzip, deflate, br) undone. */
function decodedBody(res: IncomingMessage): Readable {
  const encoding = String(res.headers["content-encoding"] ?? "").trim().toLowerCase();
  const decoder =
    encoding === "gzip" || encoding === "x-gzip"
      ? createGunzip()
      : encoding === "deflate"
        ? createInflate()
        : encoding === "br"
          ? createBrotliDecompress()
          : null;
  return decoder ? pipeline(res, decoder, () => {}) : res;
}

/**
 * GET `url` without following redirects, connecting only to `init.addresses`: the socket's
 * DNS lookup is answered from that list, so the URL's hostname (still used for the Host
 * header, TLS SNI and certificate checks) is never resolved again.
 */
export function requestPinned(url: URL, init: PinnedRequestInit): Promise<Response> {
  const pinned: LookupAddress[] = init.addresses.map((address) => ({ address, family: isIP(address) }));
  const lookup: LookupFunction = (_hostname, options, callback) => {
    const usable = options.family ? pinned.filter((a) => a.family === options.family) : pinned;
    if (options.all) callback(null, usable);
    else if (usable[0]) callback(null, usable[0].address, usable[0].family);
    else callback(Object.assign(new Error(`no vetted address for ${url.hostname}`), { code: "ENOTFOUND" }), "");
  };
  const send = url.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = send(
      url,
      {
        headers: { "Accept-Encoding": "gzip, deflate, br", ...init.headers },
        signal: init.signal,
        lookup,
        agent: false, // a fresh connection: never a pooled socket opened for another lookup
      },
      (res) => {
        try {
          const status = res.statusCode ?? 0;
          const headers = new Headers();
          for (let i = 0; i + 1 < res.rawHeaders.length; i += 2) headers.append(res.rawHeaders[i], res.rawHeaders[i + 1]);
          const bodyless = status === 204 || status === 205 || status === 304;
          if (bodyless) res.resume();
          const body = bodyless ? null : (Readable.toWeb(decodedBody(res)) as ReadableStream<Uint8Array>);
          resolve(new Response(body, { status, headers })); // throws for a status outside 200–599
        } catch (err) {
          res.destroy();
          reject(err);
        }
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/** Read at most `maxBytes` of a response body, then stop the download. */
async function readCapped(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return (await res.text()).slice(0, maxBytes);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let out = "";
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    out += decoder.decode(value, { stream: true });
    if (received >= maxBytes) {
      await reader.cancel().catch(() => {});
      break;
    }
  }
  return out + decoder.decode();
}

/**
 * Fetch a URL and return readable text, truncated to `maxChars`. Bounded and confined:
 * http(s) only, public addresses only (re-checked on every redirect hop, since a public
 * page can redirect to a private one), connections pinned to the vetted addresses, a total
 * time limit, and a body size cap.
 */
export async function fetchUrl(url: string, maxChars = 8000, deps: FetchUrlDeps = {}): Promise<string> {
  const request = deps.request ?? requestPinned;
  const lookup = deps.lookup ?? defaultLookup;
  const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  let current: URL;
  try {
    current = new URL(url);
  } catch {
    throw new Error(`invalid URL: ${url}`);
  }
  for (let hop = 0; ; hop++) {
    const addresses = await publicAddresses(current, lookup);
    const res = await request(current, {
      addresses,
      headers: { "User-Agent": "docuzen/0.1 (+https://docuzen.local)" },
      signal,
    });
    const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
    if (location) {
      await discard(res);
      if (hop >= MAX_REDIRECTS) throw new Error("fetch failed: too many redirects");
      current = new URL(location, current);
      continue;
    }
    if (!res.ok) throw await failed(res, "fetch failed");
    const text = htmlToText(await readCapped(res, MAX_BODY_BYTES));
    return text.length > maxChars ? text.slice(0, maxChars) + "\n…[truncated]" : text;
  }
}
