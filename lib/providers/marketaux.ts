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
// (con warn — audit 2026-05-12 #14) para que el cron siga funcionando
// sólo con Finnhub + RSS y el operador vea que falta una key.
let warnedMissingKey = false;
export async function fetchMarketauxNews(): Promise<NormalizedNewsItem[]> {
  // El refresher local (cada 10min) saltaría la cuota free de 100 req/día;
  // su plist exporta SKIP_MARKETAUX=1 y Marketaux entra solo vía GH Actions.
  if (process.env.SKIP_MARKETAUX === "1") return [];
  const apiKey = process.env.MARKETAUX_API_KEY;
  if (!apiKey) {
    if (!warnedMissingKey) {
      console.warn("[marketaux] MARKETAUX_API_KEY missing — skipping provider");
      warnedMissingKey = true;
    }
    return [];
  }

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
