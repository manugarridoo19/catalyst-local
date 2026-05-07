import Parser from "rss-parser";
import type { NormalizedNewsItem } from "@/lib/types";
import { hashUrl } from "@/lib/hash";

// Google News RSS por ticker — barre internet entero por menciones de un
// símbolo concreto. Para cada ticker hacemos una query con el símbolo y el
// nombre conocido (si lo tenemos) para mejorar recall.
//
// Format de URL: https://news.google.com/rss/search?q={query}&hl=en-US&gl=US&ceid=US:en
//
// La sintaxis de Google News soporta operadores como `OR`, `AND`, `"frase"`.

const parser = new Parser({
  timeout: 12_000,
  headers: {
    "User-Agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
    Accept:
      "application/rss+xml, application/xml;q=0.9, application/atom+xml;q=0.9, text/xml;q=0.8, */*;q=0.5",
  },
});

export type TickerQuery = { symbol: string; name?: string | null };

// Construye query para Google News. Usa $TICKER + name si está disponible.
function buildQuery(t: TickerQuery): string {
  const sym = t.symbol.toUpperCase();
  if (t.name && t.name.length > 2) {
    // "Apple stock" OR $AAPL → buena cobertura sin demasiados falsos positivos.
    const cleaned = t.name
      .replace(/\b(Inc\.?|Corp\.?|Corporation|Co\.?|Ltd\.?|PLC|Group|Holdings)\b/gi, "")
      .trim();
    return `("${cleaned} stock" OR $${sym})`;
  }
  return `$${sym} stock`;
}

async function fetchOne(t: TickerQuery): Promise<NormalizedNewsItem[]> {
  const url = new URL("https://news.google.com/rss/search");
  url.searchParams.set("q", buildQuery(t));
  url.searchParams.set("hl", "en-US");
  url.searchParams.set("gl", "US");
  url.searchParams.set("ceid", "US:en");

  try {
    const feed = await parser.parseURL(url.toString());
    return (feed.items || [])
      .filter((it) => it.link && it.title)
      .slice(0, 25) // limita por ticker para no inflar
      .map<NormalizedNewsItem>((it) => ({
        url: it.link!,
        hash: hashUrl(it.link!),
        headline: cleanTitle(it.title!),
        source: `gnews:${t.symbol}`,
        publishedAt: it.isoDate
          ? new Date(it.isoDate)
          : it.pubDate
            ? new Date(it.pubDate)
            : new Date(),
        body: it.contentSnippet || it.content || undefined,
        // Google News lo encontró buscando por el ticker → es seguro anotarlo.
        apiTickers: [t.symbol.toUpperCase()],
      }));
  } catch {
    return [];
  }
}

function cleanTitle(t: string): string {
  return t.replace(/\s+-\s+[A-Za-z0-9.\s&,]+$/, "").trim();
}

// Fetch en paralelo con concurrencia limitada (Google News no documenta
// rate-limits pero es prudente no abusar).
export async function fetchGoogleNewsByTicker(
  tickers: TickerQuery[],
  concurrency = 6,
): Promise<NormalizedNewsItem[]> {
  const out: NormalizedNewsItem[] = [];
  const queue = [...tickers];
  const workers = Array.from({ length: concurrency }, async () => {
    while (queue.length) {
      const t = queue.shift();
      if (!t) break;
      const items = await fetchOne(t);
      out.push(...items);
    }
  });
  await Promise.all(workers);
  return out;
}
