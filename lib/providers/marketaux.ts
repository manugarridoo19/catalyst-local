import type { NormalizedNewsItem } from "@/lib/types";
import { hashUrl } from "@/lib/hash";

const BASE = "https://api.marketaux.com/v1";

type MarketauxEntity = {
  symbol: string;
  type: string; // "equity" | "index" | ...
  exchange?: string;
  match_score?: number;
};

type MarketauxNews = {
  uuid: string;
  title: string;
  description: string;
  snippet: string;
  url: string;
  image_url: string;
  published_at: string; // ISO
  source: string;
  entities: MarketauxEntity[];
};

// Marketaux free tier: 100 requests/día. Devolvemos hasta 100 noticias por
// llamada y filtramos a equity-only. Si no hay key, devolvemos array vacío
// para que el cron siga funcionando sólo con Finnhub + RSS.
export async function fetchMarketauxNews(): Promise<NormalizedNewsItem[]> {
  const apiKey = process.env.MARKETAUX_API_KEY;
  if (!apiKey) return [];

  const url = new URL(`${BASE}/news/all`);
  url.searchParams.set("api_token", apiKey);
  url.searchParams.set("language", "en");
  url.searchParams.set("filter_entities", "true");
  url.searchParams.set("limit", "100");

  const res = await fetch(url.toString(), {
    headers: { "User-Agent": "catalyst-local/0.1" },
  });
  if (!res.ok) {
    throw new Error(`Marketaux failed: ${res.status} ${res.statusText}`);
  }
  const json = (await res.json()) as { data?: MarketauxNews[] };
  return (json.data ?? []).map((n) => ({
    url: n.url,
    hash: hashUrl(n.url),
    headline: n.title,
    source: `marketaux:${n.source}`.slice(0, 64),
    publishedAt: new Date(n.published_at),
    body: n.description || n.snippet || undefined,
    imageUrl: n.image_url || undefined,
    apiTickers: (n.entities ?? [])
      .filter((e) => e.type === "equity" && (e.match_score ?? 1) >= 0.5)
      .map((e) => e.symbol.toUpperCase()),
  }));
}
