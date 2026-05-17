import Parser from "rss-parser";
import type { NormalizedNewsItem } from "@/lib/types";
import { hashUrl } from "@/lib/hash";

// Fuentes RSS. Lista recortada 2026-05-17 tras el incidente Fluid CPU:
// de 24 sources (15 de ellas Google News mirrors) a 8. Cada feed parsea
// XML sync en el cron — 21 feeds × 50-100 KB de XML × 8 ticks/h era el
// componente más caro de cada invocación. Conservamos los 7 RSS directos
// más SEC 8-K vía Google News (material events son irreemplazables).
// Los aggregators (MarketBeat, Motley Fool, Zacks, TheStreet, Forbes,
// Kiplinger, Finviz, 247wallst, TipRanks) reposteaban contenido ya
// cubierto por MarketWatch/CNBC/Yahoo/Investing/Benzinga/SeekingAlpha
// y eran la principal fuente de noise post-dedupe.
const SOURCES: { name: string; url: string }[] = [
  // -- Generalistas / breaking news (RSS directo) -------------------------
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
  // -- Stock-specific (RSS directo) ---------------------------------------
  {
    name: "benzinga",
    url: "https://www.benzinga.com/feed",
  },
  {
    name: "seeking-alpha",
    url: "https://seekingalpha.com/market_currents.xml",
  },
  {
    name: "etftrends",
    url: "https://www.etftrends.com/feed/",
  },
  // -- Único Google News mirror retenido: SEC 8-K (material events) -------
  {
    name: "sec-8k",
    url: "https://news.google.com/rss/search?q=site:sec.gov+8-K&hl=en-US&gl=US&ceid=US:en",
  },
];

const parser = new Parser({
  timeout: 10_000,
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
