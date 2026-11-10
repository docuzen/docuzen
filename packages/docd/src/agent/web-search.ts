// Web search + fetch for the agent. pi has no built-in web tool, so this provides one,
// behind a provider abstraction. Default is DuckDuckGo's official Instant Answer API
// (keyless, ToS-permitted); Brave and Tavily are opt-in and read their key from the
// environment (BRAVE_API_KEY / TAVILY_API_KEY) — keys are never stored in the .had sidecar.

import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

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
    if (!res.ok) throw new Error(`Brave search failed: ${res.status}`);
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
    if (!res.ok) throw new Error(`Tavily search failed: ${res.status}`);
    return parseTavily(await res.json());
  }
  // Default: DuckDuckGo official Instant Answer API (keyless, no registration).
  const res = await fetch(
    `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&no_redirect=1&t=docuzen`,
    { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) },
  );
  if (!res.ok) throw new Error(`DuckDuckGo search failed: ${res.status}`);
  return parseDuckDuckGo(await res.json());
}

/**
 * True for addresses a web fetch must never reach: loopback, private (RFC 1918 / ULA),
 * link-local (incl. the 169.254.169.254 cloud-metadata endpoint), CGNAT, and unspecified.
 * The URL comes from a model that has just read untrusted web/search content, so without
 * this a prompt-injected page could make the sidecar probe the user's own machine or LAN.
 */
export function isPrivateAddress(address: string): boolean {
  const ip = address.toLowerCase().replace(/^\[|\]$/g, "");
  const family = isIP(ip);
  if (family === 4) {
    const [a, b] = ip.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }
  if (family === 6) {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(ip);
    if (mapped) return isPrivateAddress(mapped[1]);
    return (
      ip === "::" ||
      ip === "::1" ||
      /^f[cd]/.test(ip) || // fc00::/7 unique-local
      /^fe[89ab]/.test(ip) // fe80::/10 link-local
    );
  }
  return true; // not an IP literal at all — callers resolve hostnames first
}

export interface FetchUrlDeps {
  fetch?: typeof fetch;
  /** Resolve a hostname to every address it maps to. */
  lookup?: (hostname: string) => Promise<string[]>;
}

async function defaultLookup(hostname: string): Promise<string[]> {
  return (await dnsLookup(hostname, { all: true })).map((r) => r.address);
}

/** Throws unless `url` is http(s) and every address its host resolves to is public. */
async function assertPublicHttpUrl(url: URL, lookup: (hostname: string) => Promise<string[]>): Promise<void> {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`unsupported URL scheme ${url.protocol}`);
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host) ? [host] : await lookup(host);
  if (!addresses.length || addresses.some(isPrivateAddress)) {
    throw new Error(`refusing to fetch ${url.hostname}: it resolves to a private or local address`);
  }
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
 * page can redirect to a private one), a total time limit, and a body size cap.
 */
export async function fetchUrl(url: string, maxChars = 8000, deps: FetchUrlDeps = {}): Promise<string> {
  const doFetch = deps.fetch ?? fetch;
  const lookup = deps.lookup ?? defaultLookup;
  const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  let current: URL;
  try {
    current = new URL(url);
  } catch {
    throw new Error(`invalid URL: ${url}`);
  }
  for (let hop = 0; ; hop++) {
    await assertPublicHttpUrl(current, lookup);
    const res = await doFetch(current, {
      headers: { "User-Agent": "docuzen/0.1 (+https://docuzen.local)" },
      redirect: "manual",
      signal,
    });
    const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
    if (location) {
      if (hop >= MAX_REDIRECTS) throw new Error("fetch failed: too many redirects");
      current = new URL(location, current);
      continue;
    }
    if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
    const text = htmlToText(await readCapped(res, MAX_BODY_BYTES));
    return text.length > maxChars ? text.slice(0, maxChars) + "\n…[truncated]" : text;
  }
}
