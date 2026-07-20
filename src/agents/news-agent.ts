import { Agent } from "agents";

interface NewsApiArticle {
  title: string;
  description: string | null;
  source: { name: string };
  url: string;
}

interface NewsApiResponse {
  status: string;
  articles?: NewsApiArticle[];
  message?: string;
}

// NewsAPI's free "top-headlines" endpoint only supports this fixed set of
// country codes. Anything else falls back to a keyword search instead.
const TOP_HEADLINES_COUNTRIES = new Set([
  "ae", "ar", "at", "au", "be", "bg", "br", "ca", "ch", "cn", "co", "cu",
  "cz", "de", "eg", "fr", "gb", "gr", "hk", "hu", "id", "ie", "il", "in",
  "it", "jp", "kr", "lt", "lv", "ma", "mx", "my", "ng", "nl", "no", "nz",
  "ph", "pl", "pt", "ro", "rs", "ru", "sa", "se", "sg", "si", "sk", "th",
  "tr", "tw", "ua", "us", "ve", "za",
]);

export class NewsAgent extends Agent<Env> {
  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const countryName = url.searchParams.get("name");
    const countryCode = (url.searchParams.get("code") || "").toLowerCase();

    if (!countryName) {
      return Response.json({ error: "Missing ?name= query param" }, { status: 400 });
    }

    try {
      const articles = await this.fetchHeadlines(countryName, countryCode);

      if (articles.length === 0) {
        return Response.json({
          country: countryName,
          headlines: [],
          briefing: `No recent news articles were found for ${countryName}.`,
        });
      }

      const briefing = await this.summarize(countryName, articles);

      return Response.json({
        country: countryName,
        headlines: articles.slice(0, 5).map((a) => ({
          title: a.title,
          source: a.source.name,
          url: a.url,
        })),
        briefing,
      });
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
  ): Promise<NewsApiArticle[]> {
    const apiKey = this.env.NEWS_API_KEY;
    const useTopHeadlines = TOP_HEADLINES_COUNTRIES.has(countryCode);

    const endpoint = useTopHeadlines
      ? `https://newsapi.org/v2/top-headlines?country=${countryCode}&pageSize=8`
      : `https://newsapi.org/v2/everything?q=${encodeURIComponent(countryName)}&language=en&sortBy=publishedAt&pageSize=8`;

    const res = await fetch(endpoint, {
      headers: { "X-Api-Key": apiKey },
    });
    const data = (await res.json()) as NewsApiResponse;

    if (data.status !== "ok") {
      throw new Error(data.message || "NewsAPI request failed");
    }

    return (data.articles || []).filter((a) => a.title && a.title !== "[Removed]");
  }

  private async summarize(countryName: string, articles: NewsApiArticle[]): Promise<string> {
    const headlineList = articles
      .slice(0, 5)
      .map((a, i) => `${i + 1}. ${a.title}${a.description ? ` — ${a.description}` : ""}`)
      .join("\n");

    const result = await this.env.AI.run("@cf/meta/llama-3.1-8b-instruct", {
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
