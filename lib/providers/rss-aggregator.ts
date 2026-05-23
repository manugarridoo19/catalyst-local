import Parser from "rss-parser";
import type { NormalizedNewsItem } from "@/lib/types";
import { hashUrl } from "@/lib/hash";

// Fuentes RSS gratuitas y sin auth. Lista completa restaurada 2026-05-17
// tras mover el cron al runner de GitHub Actions: el coste CPU de parsear
// XML ya no afecta Vercel Fluid, solo el wall-clock del runner (timeout
// 3min). 24 feeds en paralelo terminan en ~10-15s.
// Mezcla pensada para diversidad: generalistas (MarketWatch, CNBC, Yahoo),
// aggregators (Benzinga, Motley Fool, Seeking Alpha, Zacks), y mirrors
// de Google News para outlets que matan RSS directo (Reuters, Bloomberg,
// FT, Barrons, WSJ).
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
  // finviz, sec-8k REMOVIDOS 2026-05-23 (audit-orphans):
  // - finviz: 85% orphan, 95% son "Person Name - Insider Trading - Form 4"
  //   (nombres de personas, no se puede atribuir a empresa desde headline).
  // - sec-8k: 88% orphan, 90% son IDs/slugs ("EDGAR Filing Documents for
  //   0001555280-26-000029", "zd-20260518") sin company name extraíble.
  // Los pocos hits útiles no compensan el ruido en /news tab. Si en el
  // futuro quieres signal SEC, mejor consumir EDGAR direct API + parsear
  // el form body (no RSS title).
  {
    name: "247wallst",
    url: "https://news.google.com/rss/search?q=site:247wallst.com&hl=en-US&gl=US&ceid=US:en",
  },
  {
    name: "tipranks",
    url: "https://news.google.com/rss/search?q=site:tipranks.com&hl=en-US&gl=US&ceid=US:en",
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

// Timeout 10s (audit 2026-05-12 #7): bajado desde 15s. Un Reuters/FT mirror
// lento ya no domina el bucket. Las respuestas exitosas se cachean 15min
// (ver `lastGoodResponses`) y se sirven como fallback si la siguiente
// llamada falla — así un blip de 502 no nos deja sin ese feed por 5min
// hasta el próximo tick. 24 feeds × 10s max ≈ 10s peak, vs 20s antes.
const RSS_TIMEOUT_MS = 10_000;
const RSS_CACHE_TTL_MS = 15 * 60 * 1000;

const parser = new Parser({
  timeout: RSS_TIMEOUT_MS,
  headers: {
    // Algunos feeds (Reuters mirror, FT, MarketBeat) bloquean User-Agents
    // que no parezcan navegador. Usamos uno común para evitar 403.
    "User-Agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
    Accept:
      "application/rss+xml, application/xml;q=0.9, application/atom+xml;q=0.9, text/xml;q=0.8, */*;q=0.5",
  },
});

// Cache last-good por fuente. Cuando una fuente falla pero antes funcionó
// hace <15min, reutilizamos. Dedupe vía hash en insertNewsBatch evita
// duplicados — el coste de re-broadcast es 0 porque el hash conflict skip
// no entra a `inserted`.
type RssCacheEntry = {
  items: NormalizedNewsItem[];
  expiresAt: number;
};
const lastGoodResponses = new Map<string, RssCacheEntry>();

// Devuelve noticias de TODAS las fuentes en paralelo. Si una fuente falla
// loggeamos y seguimos — un feed roto no debe tumbar el cron.
export async function fetchAllRssNews(): Promise<NormalizedNewsItem[]> {
  const results = await Promise.allSettled(
    SOURCES.map((s) => fetchOne(s.name, s.url)),
  );
  const items: NormalizedNewsItem[] = [];
  results.forEach((r, i) => {
    const src = SOURCES[i].name;
    if (r.status === "fulfilled") {
      items.push(...r.value);
      lastGoodResponses.set(src, {
        items: r.value,
        expiresAt: Date.now() + RSS_CACHE_TTL_MS,
      });
    } else {
      const cached = lastGoodResponses.get(src);
      if (cached && cached.expiresAt > Date.now()) {
        console.warn(
          `[rss] source "${src}" failed, serving last-good (${cached.items.length} items): ${
            r.reason instanceof Error ? r.reason.message : r.reason
          }`,
        );
        items.push(...cached.items);
      } else {
        console.warn(
          `[rss] source "${src}" failed: ${
            r.reason instanceof Error ? r.reason.message : r.reason
          }`,
        );
      }
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
