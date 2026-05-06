import Parser from "rss-parser";
import type { NormalizedNewsItem } from "@/lib/types";
import { hashUrl } from "@/lib/hash";

// Fuentes RSS gratuitas y sin auth. Algunas (Reuters) bloquean acceso
// directo, así que usamos Google News como espejo cuando hace falta.
const SOURCES: { name: string; url: string }[] = [
  {
    name: "marketwatch",
    url: "https://feeds.content.dowjones.io/public/rss/mw_topstories",
  },
  { name: "yahoo-finance", url: "https://finance.yahoo.com/news/rssindex" },
  {
    name: "cnbc-business",
    url: "https://www.cnbc.com/id/10001147/device/rss/rss.html",
  },
  {
    name: "seeking-alpha",
    url: "https://seekingalpha.com/market_currents.xml",
  },
  {
    name: "investing-com",
    url: "https://www.investing.com/rss/news.rss",
  },
  {
    name: "reuters-business",
    url: "https://news.google.com/rss/search?q=site:reuters.com+business&hl=en-US&gl=US&ceid=US:en",
  },
  {
    name: "ft-companies",
    url: "https://news.google.com/rss/search?q=site:ft.com+companies&hl=en-US&gl=US&ceid=US:en",
  },
];

const parser = new Parser({
  timeout: 20_000,
  headers: {
    // Algunos feeds (Reuters mirror, FT) bloquean User-Agents que no
    // parezcan navegador. Usamos uno común para evitar 403.
    "User-Agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
    Accept:
      "application/rss+xml, application/xml;q=0.9, application/atom+xml;q=0.9, text/xml;q=0.8, */*;q=0.5",
  },
});

// Devuelve noticias de TODAS las fuentes en paralelo. Si una fuente falla
// loggeamos y seguimos — un feed roto no debe tumbar el cron.
export async function fetchAllRssNews(): Promise<NormalizedNewsItem[]> {
  const results = await Promise.allSettled(
    SOURCES.map((s) => fetchOne(s.name, s.url)),
  );
  const items: NormalizedNewsItem[] = [];
  results.forEach((r, i) => {
    if (r.status === "fulfilled") {
      items.push(...r.value);
    } else {
      console.warn(
        `[rss] source "${SOURCES[i].name}" failed: ${
          r.reason instanceof Error ? r.reason.message : r.reason
        }`,
      );
    }
  });
  return items;
}

async function fetchOne(
  source: string,
  url: string,
): Promise<NormalizedNewsItem[]> {
  const feed = await parser.parseURL(url);
  return (feed.items || [])
    .filter((it) => it.link && it.title)
    .map<NormalizedNewsItem>((it) => ({
      url: it.link!,
      hash: hashUrl(it.link!),
      headline: it.title!.trim(),
      source: `rss:${source}`,
      publishedAt: it.isoDate
        ? new Date(it.isoDate)
        : it.pubDate
          ? new Date(it.pubDate)
          : new Date(),
      body: it.contentSnippet || it.content || undefined,
      apiTickers: [], // RSS no anota tickers — los descubre el extractor.
    }));
}
