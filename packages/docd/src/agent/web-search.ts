// Web search + fetch for the agent. pi has no built-in web tool, so this provides one,
// behind a provider abstraction. Default is DuckDuckGo's official Instant Answer API
// (keyless, ToS-permitted); Brave and Tavily are opt-in and read their key from the
// environment (BRAVE_API_KEY / TAVILY_API_KEY) — keys are never stored in the .had sidecar.

export type WebSearchProvider = "ddg" | "brave" | "tavily";

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
      { headers: { "X-Subscription-Token": key, Accept: "application/json" } },
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
    });
    if (!res.ok) throw new Error(`Tavily search failed: ${res.status}`);
    return parseTavily(await res.json());
  }
  // Default: DuckDuckGo official Instant Answer API (keyless, no registration).
  const res = await fetch(
    `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&no_redirect=1&t=docuzen`,
    { headers: { Accept: "application/json" } },
  );
  if (!res.ok) throw new Error(`DuckDuckGo search failed: ${res.status}`);
  return parseDuckDuckGo(await res.json());
}

/** Fetch a URL and return readable text, truncated to `maxChars`. */
export async function fetchUrl(url: string, maxChars = 8000): Promise<string> {
  const res = await fetch(url, { headers: { "User-Agent": "docuzen/0.1 (+https://docuzen.local)" } });
  if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
  const text = htmlToText(await res.text());
  return text.length > maxChars ? text.slice(0, maxChars) + "\n…[truncated]" : text;
}
