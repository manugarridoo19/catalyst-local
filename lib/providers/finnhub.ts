import type { NormalizedNewsItem } from "@/lib/types";
import { hashUrl } from "@/lib/hash";

const BASE = "https://finnhub.io/api/v1";

function key() {
  const k = process.env.FINNHUB_API_KEY;
  if (!k) throw new Error("FINNHUB_API_KEY is not set");
  return k;
}

type FinnhubNews = {
  category: string;
  datetime: number; // unix seconds
  headline: string;
  id: number;
  image: string;
  related: string; // CSV de tickers — "AAPL,MSFT"
  source: string;
  summary: string;
  url: string;
};

async function fh<T>(
  path: string,
  params: Record<string, string> = {},
): Promise<T> {
  const url = new URL(`${BASE}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set("token", key());
  const res = await fetch(url.toString(), {
    headers: { "User-Agent": "catalyst-local/0.1" },
  });
  if (!res.ok) {
    throw new Error(`Finnhub ${path} failed: ${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

// Noticias generales (motor del feed). Solo categorías de equities — el
// usuario pidió excluir crypto y forex.
const CATEGORIES = ["general", "merger"] as const;

export async function fetchGeneralNews(): Promise<NormalizedNewsItem[]> {
  const results = await Promise.allSettled(
    CATEGORIES.map((cat) => fh<FinnhubNews[]>("/news", { category: cat })),
  );
  const out: NormalizedNewsItem[] = [];
  for (const r of results) {
    if (r.status === "fulfilled") out.push(...r.value.map(toNormalized));
  }
  return out;
}

// Noticias específicas de un ticker en los últimos N días.
export async function fetchCompanyNews(
  symbol: string,
  days = 7,
): Promise<NormalizedNewsItem[]> {
  const to = new Date();
  const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);
  const items = await fh<FinnhubNews[]>("/company-news", {
    symbol,
    from: from.toISOString().slice(0, 10),
    to: to.toISOString().slice(0, 10),
  });
  return items.map(toNormalized);
}

// Bulk: noticias para varios tickers a la vez. Respeta el rate-limit de
// Finnhub (60 req/min) usando un semáforo de concurrencia 8 con 100ms de
// espaciado entre requests dentro del mismo "slot".
export async function fetchCompanyNewsBatch(
  symbols: string[],
  days = 3,
): Promise<NormalizedNewsItem[]> {
  const out: NormalizedNewsItem[] = [];
  const queue = [...symbols];
  const concurrency = 8;
  const workers = Array.from({ length: concurrency }, async () => {
    while (queue.length) {
      const sym = queue.shift();
      if (!sym) break;
      try {
        const items = await fetchCompanyNews(sym, days);
        out.push(...items);
      } catch {
        // skip failed ticker
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  });
  await Promise.all(workers);
  return out;
}

function toNormalized(n: FinnhubNews): NormalizedNewsItem {
  const apiTickers = (n.related || "")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  return {
    url: n.url,
    hash: hashUrl(n.url),
    headline: n.headline,
    source: `finnhub:${n.source}`.slice(0, 64),
    publishedAt: new Date(n.datetime * 1000),
    body: n.summary || undefined,
    imageUrl: n.image || undefined,
    apiTickers,
  };
}

// --- Search & enrichment -------------------------------------------------

export type FinnhubSearchResult = {
  symbol: string;
  description: string;
  type: string;
  displaySymbol: string;
};

export async function searchSymbols(
  query: string,
): Promise<FinnhubSearchResult[]> {
  const data = await fh<{ count: number; result: FinnhubSearchResult[] }>(
    "/search",
    { q: query, exchange: "US" },
  );
  return data.result || [];
}

export type FinnhubProfile = {
  ticker: string;
  name: string;
  finnhubIndustry: string;
  marketCapitalization: number; // millones
  exchange: string;
  country: string;
  currency: string;
  weburl: string;
  logo: string;
};

export async function getProfile(symbol: string): Promise<FinnhubProfile | null> {
  try {
    const p = await fh<FinnhubProfile>("/stock/profile2", { symbol });
    if (!p || !p.ticker) return null;
    return p;
  } catch {
    return null;
  }
}

export type FinnhubQuote = {
  c: number; // current
  d: number; // change
  dp: number; // change percent
  h: number; // high
  l: number; // low
  o: number; // open
  pc: number; // previous close
  t: number; // unix
};

export async function getQuote(symbol: string): Promise<FinnhubQuote | null> {
  try {
    return await fh<FinnhubQuote>("/quote", { symbol });
  } catch {
    return null;
  }
}
