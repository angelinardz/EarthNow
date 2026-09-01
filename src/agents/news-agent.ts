import { Agent } from "agents";

interface Article {
  title: string;
  description: string | null;
  source: { name: string };
  url: string;
}

interface NewsPayload {
  country: string;
  headlines: { title: string; source: string; url: string }[];
  briefing: string;
}

// Google News publishes a country "edition" for these codes. For anything
// else we fall back to a keyword search on the country's name.
const GOOGLE_NEWS_EDITIONS = new Set([
  "ae", "ar", "at", "au", "bd", "be", "bg", "br", "ca", "ch", "cl", "co",
  "cu", "cz", "de", "eg", "es", "fr", "gb", "gr", "hk", "hu", "id", "ie",
  "il", "in", "it", "jp", "ke", "kr", "lb", "lt", "lv", "ma", "mx", "my",
  "ng", "nl", "no", "nz", "pe", "ph", "pk", "pl", "pt", "ro", "rs", "ru",
  "sa", "se", "sg", "si", "sk", "th", "tr", "tw", "ua", "us", "ve", "vn",
  "za",
]);

// How long to serve a cached result for a country before re-fetching.
// Google News RSS content doesn't change fast enough to need every click
// to hit the network, and this also takes pressure off the rate limit.
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// Transient upstream statuses worth retrying — a 503 from Google News RSS
// is usually a momentary rate-limit/overload response, not a permanent failure.
const RETRYABLE_STATUSES = new Set([502, 503, 429]);

export class NewsAgent extends Agent<Env> {
  // In-memory per-instance cache. Since each country gets its own Agent
  // instance (keyed by country code), this naturally caches per-country.
  // NOTE: this resets if the Durable Object is evicted/restarted — it's a
  // performance/rate-limit cushion, not durable storage. If you want it to
  // survive evictions, swap this for the Agent SDK's persistent storage.
  private cache: { payload: NewsPayload; cachedAt: number } | null = null;

  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const countryName = url.searchParams.get("name");
    const countryCode = (url.searchParams.get("code") || "").toLowerCase();

    if (!countryName) {
      return Response.json({ error: "Missing ?name= query param" }, { status: 400 });
    }

    if (this.cache && Date.now() - this.cache.cachedAt < CACHE_TTL_MS) {
      return Response.json(this.cache.payload);
    }

    try {
      const articles = await this.fetchHeadlines(countryName, countryCode);

      let payload: NewsPayload;
      if (articles.length === 0) {
        payload = {
          country: countryName,
          headlines: [],
          briefing: `No recent news articles were found for ${countryName}.`,
        };
      } else {
        const briefing = await this.summarize(countryName, articles);
        payload = {
          country: countryName,
          headlines: articles.slice(0, 5).map((a) => ({
            title: a.title,
            source: a.source.name,
            url: a.url,
          })),
          briefing,
        };
      }

      this.cache = { payload, cachedAt: Date.now() };
      return Response.json(payload);
    } catch (err) {
      console.error("NewsAgent error:", err);
      return Response.json(
        { error: "Failed to fetch or summarize news for this country." },
        { status: 502 },
      );
    }
  }

  private async fetchHeadlines(
    countryName: string,
    countryCode: string,
  ): Promise<Article[]> {
    // Google News RSS needs no API key. `gl` sets the country edition and
    // `ceid` must repeat it as COUNTRY:language. `hl=en` keeps results in
    // English regardless of the local language.
    const region = countryCode.toUpperCase();
    const endpoint = GOOGLE_NEWS_EDITIONS.has(countryCode)
      ? `https://news.google.com/rss?hl=en&gl=${region}&ceid=${region}:en`
      : `https://news.google.com/rss/search?q=${encodeURIComponent(countryName)}&hl=en&gl=US&ceid=US:en`;

    const res = await this.fetchWithRetry(endpoint);
    return parseRssItems(await res.text()).slice(0, 8);
  }

  // Retries transient upstream failures (503/502/429) with exponential
  // backoff before giving up. Non-transient errors (4xx other than 429)
  // fail immediately since retrying won't help.
  private async fetchWithRetry(
    endpoint: string,
    maxRetries = 2,
    baseDelayMs = 300,
  ): Promise<Response> {
    let lastStatus: number | undefined;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const res = await fetch(endpoint, {
        headers: { "User-Agent": "EarthNow/1.0 (Cloudflare Workers)" },
      });

      if (res.ok) return res;

      lastStatus = res.status;
      const isRetryable = RETRYABLE_STATUSES.has(res.status);
      if (!isRetryable || attempt === maxRetries) break;

      const delay = baseDelayMs * 2 ** attempt; // 300ms, 600ms, ...
      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    throw new Error(`Google News RSS request failed: ${lastStatus}`);
  }

  private async summarize(countryName: string, articles: Article[]): Promise<string> {
    const headlineList = articles
      .slice(0, 5)
      .map((a, i) => `${i + 1}. ${a.title} (${a.source.name})`)
      .join("\n");

    const result = await this.env.AI.run("@cf/meta/llama-3.1-8b-instruct-fp8", {
      messages: [
        {
          role: "system",
          content:
            "You are a concise news briefing assistant. Summarize the given headlines into a neutral 2-3 sentence briefing of what's currently happening in the country. Do not invent facts beyond what's in the headlines.",
        },
        {
          role: "user",
          content: `Country: ${countryName}\n\nHeadlines:\n${headlineList}`,
        },
      ],
    });

    const response = (result as { response?: string }).response;
    return response?.trim() || "Unable to generate a briefing for these headlines.";
  }
}

// --- RSS parsing -----------------------------------------------------------
// Workers have no DOMParser, so we pull the fields out with regex. The feed
// is machine-generated and consistently shaped, so this is safe enough here.

function parseRssItems(xml: string): Article[] {
  const items = xml.match(/<item\b[^>]*>[\s\S]*?<\/item>/g) || [];

  return items
    .map((item): Article | null => {
      const rawTitle = decodeEntities(tag(item, "title"));
      const link = decodeEntities(tag(item, "link"));
      // <source url="...">Publisher</source> gives us the outlet name.
      const source = decodeEntities(
        (item.match(/<source[^>]*>([\s\S]*?)<\/source>/) || [])[1] || "",
      );

      if (!rawTitle || !link) return null;

      // Google appends " - Publisher" to every headline; strip it so the
      // title and the source label don't say the same thing twice.
      const title =
        source && rawTitle.endsWith(` - ${source}`)
          ? rawTitle.slice(0, -(source.length + 3))
          : rawTitle;

      return {
        title: title.trim(),
        description: null,
        source: { name: source || "Google News" },
        url: link,
      };
    })
    .filter((a): a is Article => a !== null);
}

function tag(item: string, name: string): string {
  const match = item.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
  if (!match) return "";
  return stripCdata(match[1]).trim();
}

function stripCdata(value: string): string {
  const cdata = value.match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
  return cdata ? cdata[1] : value;
}

function decodeEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}