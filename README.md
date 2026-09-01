# EarthNow
https://earthnow.angelinardz06.workers.dev/

An interactive 3D globe where clicking any country returns an AI-generated
briefing of what's happening there right now.

Built on Cloudflare Workers. The globe is rendered with Globe.gl / Three.js and
served as a static asset; clicking a country routes to a Durable Object that
pulls live headlines and summarizes them with Workers AI.

## How it works

1. **Click a country** — Globe.gl resolves the click to a GeoJSON feature and
   its ISO2 country code.
2. **Route to an agent** — the request hits `/agents/news-agent/{code}`, and the
   Agents SDK spins up a `NewsAgent` Durable Object scoped to that country.
3. **Fetch headlines** — the agent reads Google News RSS for that country's
   edition, falling back to a keyword search for countries without one.
4. **Summarize** — the top headlines go to Llama 3.1 on Workers AI, which writes
   a neutral 2–3 sentence briefing constrained to what's in the headlines.
5. **Render** — the UI shows the briefing plus the source headlines, each linked
   and attributed to its publisher.

## Stack

| Piece | Used for |
| --- | --- |
| Cloudflare Workers | Hosting, routing, static assets |
| Durable Objects (Agents SDK) | Per-country `NewsAgent` instances |
| Workers AI (`llama-3.1-8b-instruct`) | Headline summarization |
| Google News RSS | Headline source — no API key required |
| Globe.gl / Three.js | 3D globe rendering |

## Running locally

```bash
npm install
npx wrangler dev
```

No secrets or API keys are required — the news source is a public RSS feed.

## Deploying

```bash
npx wrangler deploy
```

## Notes

Headlines come from Google News RSS, which aggregates across many publishers
without editorial filtering. Source names are shown alongside every headline so
readers can weigh them for themselves, and the summarization prompt explicitly
forbids introducing facts not present in the headlines.
