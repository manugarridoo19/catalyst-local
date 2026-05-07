import Parser from "rss-parser";
import type { NormalizedNewsItem } from "@/lib/types";
import { hashUrl } from "@/lib/hash";

// Fuentes RSS gratuitas y sin auth. La mezcla está pensada para diversidad:
// outlets generalistas (MarketWatch, CNBC, Yahoo), agregadores especializados
// (MarketBeat, Benzinga, Motley Fool), y mirrors de Google News para los que
// no exponen RSS directo (Reuters, Bloomberg, FT, Barrons).
const SOURCES: { name: string; url: string }[] = [
  // -- Generalistas / breaking news ---------------------------------------
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
    name: "investing-com",
    url: "https://www.investing.com/rss/news.rss",
  },
  // -- Stock-specific aggregators -----------------------------------------
  // MarketBeat y Motley Fool no exponen RSS público estable — vía Google News.
  {
    name: "marketbeat",
    url: "https://news.google.com/rss/search?q=site:marketbeat.com&hl=en-US&gl=US&ceid=US:en",
  },
  {
    name: "marketbeat-ratings",
    url: "https://news.google.com/rss/search?q=site:marketbeat.com+%22analyst+rating%22&hl=en-US&gl=US&ceid=US:en",
  },
  {
    name: "benzinga",
    url: "https://www.benzinga.com/feed",
  },
  {
    name: "motley-fool",
    url: "https://news.google.com/rss/search?q=site:fool.com&hl=en-US&gl=US&ceid=US:en",
  },
  {
    name: "seeking-alpha",
    url: "https://seekingalpha.com/market_currents.xml",
  },
  {
    name: "zacks",
    url: "https://news.google.com/rss/search?q=site:zacks.com&hl=en-US&gl=US&ceid=US:en",
  },
  {
    name: "thestreet",
    url: "https://news.google.com/rss/search?q=site:thestreet.com&hl=en-US&gl=US&ceid=US:en",
  },
  {
    name: "forbes-markets",
    url: "https://news.google.com/rss/search?q=site:forbes.com+markets&hl=en-US&gl=US&ceid=US:en",
  },
  {
    name: "etftrends",
    url: "https://www.etftrends.com/feed/",
  },
  {
    name: "kiplinger",
    url: "https://news.google.com/rss/search?q=site:kiplinger.com&hl=en-US&gl=US&ceid=US:en",
  },
  {
    name: "finviz",
    url: "https://news.google.com/rss/search?q=site:finviz.com&hl=en-US&gl=US&ceid=US:en",
  },
  {
    name: "247wallst",
    url: "https://news.google.com/rss/search?q=site:247wallst.com&hl=en-US&gl=US&ceid=US:en",
  },
  {
    name: "tipranks",
    url: "https://news.google.com/rss/search?q=site:tipranks.com&hl=en-US&gl=US&ceid=US:en",
  },
  // SEC 8-K (material events) — gold para significancia.
  {
    name: "sec-8k",
    url: "https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=8-K&output=atom",
  },
  // -- Google News mirrors (para outlets que matan RSS directo) -----------
  {
    name: "reuters-business",
    url: "https://news.google.com/rss/search?q=site:reuters.com+business&hl=en-US&gl=US&ceid=US:en",
  },
  {
    name: "ft-companies",
    url: "https://news.google.com/rss/search?q=site:ft.com+companies&hl=en-US&gl=US&ceid=US:en",
  },
  {
    name: "bloomberg",
    url: "https://news.google.com/rss/search?q=site:bloomberg.com+markets&hl=en-US&gl=US&ceid=US:en",
  },
  {
    name: "barrons",
    url: "https://news.google.com/rss/search?q=site:barrons.com&hl=en-US&gl=US&ceid=US:en",
  },
  {
    name: "wsj-markets",
    url: "https://news.google.com/rss/search?q=site:wsj.com+markets&hl=en-US&gl=US&ceid=US:en",
  },
];

const parser = new Parser({
  timeout: 20_000,
  headers: {
    // Algunos feeds (Reuters mirror, FT, MarketBeat) bloquean User-Agents
    // que no parezcan navegador. Usamos uno común para evitar 403.
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
      headline: cleanTitle(it.title!),
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

// Google News mirrors devuelven titulares como "Some headline - Source",
// donde el "- Source" es ruido. Lo limpiamos para no guardarlo así en DB.
function cleanTitle(t: string): string {
  return t
    .replace(/\s+-\s+[A-Za-z0-9.\s]+$/, "")
    .trim();
}
