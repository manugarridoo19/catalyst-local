import {
  fetchCompanyNewsBatch,
  fetchGeneralNews,
} from "@/lib/providers/finnhub";
import { fetchMarketauxNews } from "@/lib/providers/marketaux";
import { fetchAllRssNews } from "@/lib/providers/rss-aggregator";
import { fetchGoogleNewsByTicker } from "@/lib/providers/google-news-tickers";
import { extractTickers } from "@/lib/tickers/extractor";
import { enrichPendingTickers } from "@/lib/tickers/enricher";
import {
  deleteOldNews,
  getTickerMetaMap,
  getTopTickersForFetch,
  insertNewsWithTickers,
  loadAliases,
  upsertTickers,
} from "@/lib/db/queries";
import { broadcastNews, type FeedNewsPayload } from "@/lib/pusher/server";
import type { ExtractedTicker, NormalizedNewsItem } from "@/lib/types";

// Refresh-news NO scorea. Fetch + insert + enrich ya consume 30-40s en
// el 60s budget; añadirle scoring nos lleva a 504 intermitentes. score-
// orphans tiene su propio 60s tick cada 5min y se encarga de TODO el
// scoring. Latencia "news llega → broadcast" ahora es inmediata; los
// badges Signif/Sent aparecen cuando score-orphans rebroadcast con
// score → el cliente actualiza el card in-place por id.

// Retención: borramos news >14 días al final de cada cron para no saturar
// la BD. La home queda orientada a presente/futuro.
const RETENTION_DAYS = 14;

export type CronResult = {
  fetched: {
    finnhub: number;
    finnhubCompany: number;
    marketaux: number;
    rss: number;
    gnewsTickers: number;
  };
  inserted: number;
  scored: number;
  failedScores: number;
  enriched: { processed: number; succeeded: number };
  durationMs: number;
};

export async function runRefreshNewsCron(): Promise<CronResult> {
  const t0 = Date.now();

  // 1) Resolver los top tickers ANTES del fetch — para el barrido
  // per-ticker en Finnhub y Google News.
  const topTickers = await getTopTickersForFetch(50).catch(() => []);

  // 2) Fetch en paralelo (un proveedor caído no tumba el cron).
  // Tamaño de muestra ajustado al budget de 60s en Vercel Hobby.
  const [finnhubR, finnhubCoR, marketauxR, rssR, gnewsR] =
    await Promise.allSettled([
      fetchGeneralNews(),
      fetchCompanyNewsBatch(
        topTickers.slice(0, 15).map((t) => t.symbol),
        3,
      ),
      fetchMarketauxNews(),
      fetchAllRssNews(),
      fetchGoogleNewsByTicker(topTickers.slice(0, 25)),
    ]);

  const finnhubItems = finnhubR.status === "fulfilled" ? finnhubR.value : [];
  const finnhubCoItems =
    finnhubCoR.status === "fulfilled" ? finnhubCoR.value : [];
  const marketauxItems =
    marketauxR.status === "fulfilled" ? marketauxR.value : [];
  const rssItems = rssR.status === "fulfilled" ? rssR.value : [];
  const gnewsItems = gnewsR.status === "fulfilled" ? gnewsR.value : [];
  if (finnhubR.status === "rejected") console.warn("[cron] finnhub failed:", finnhubR.reason);
  if (finnhubCoR.status === "rejected") console.warn("[cron] finnhub-company failed:", finnhubCoR.reason);
  if (marketauxR.status === "rejected") console.warn("[cron] marketaux failed:", marketauxR.reason);
  if (rssR.status === "rejected") console.warn("[cron] rss failed:", rssR.reason);
  if (gnewsR.status === "rejected") console.warn("[cron] gnews-tickers failed:", gnewsR.reason);

  const allItems = [
    ...finnhubItems,
    ...finnhubCoItems,
    ...marketauxItems,
    ...rssItems,
    ...gnewsItems,
  ];

  // 2) Dedupe por hash dentro del lote.
  const byHash = new Map<string, NormalizedNewsItem>();
  for (const item of allItems) {
    if (!byHash.has(item.hash)) byHash.set(item.hash, item);
  }
  const deduped = Array.from(byHash.values());

  // 3) Cargar aliases + extraer tickers.
  const aliases = await loadAliases();
  const itemsWithTickers: { item: NormalizedNewsItem; tickers: ExtractedTicker[] }[] =
    deduped.map((item) => ({
      item,
      tickers: extractTickers(item, aliases),
    }));

  // 4) Asegurar que todos los símbolos detectados estén en `tickers`.
  const allSymbols = new Set<string>();
  for (const { tickers: ts } of itemsWithTickers) {
    for (const t of ts) allSymbols.add(t.symbol);
  }
  await upsertTickers([...allSymbols], "cron");

  // 5) Insertar noticias nuevas. Las que ya existen devuelven null.
  // Try/catch por item — un INSERT roto NO debe tumbar todo el cron (un solo
  // duplicate hash/url falló durante 7h dejando la feed congelada).
  const newlyInserted: { id: number; item: NormalizedNewsItem; tickers: string[] }[] = [];
  let insertFailures = 0;
  for (const { item, tickers } of itemsWithTickers) {
    try {
      const id = await insertNewsWithTickers(item, tickers);
      if (id) {
        newlyInserted.push({ id, item, tickers: tickers.map((t) => t.symbol) });
      }
    } catch (err) {
      insertFailures++;
      console.warn(
        `[cron] insert failed for ${item.url.slice(0, 80)}:`,
        err instanceof Error ? err.message.slice(0, 200) : err,
      );
    }
  }
  if (insertFailures) {
    console.warn(`[cron] ${insertFailures} insert failures (cron continues)`);
  }

  // 6) Broadcast inmediato SIN score. La feed live ve la noticia en
  // segundos; score-orphans la puntúa en su tick y emite un segundo
  // broadcast con scores que actualiza el card in-place.
  // (SCORING_BATCH=0 desde que separamos ingest y scoring por presupuesto
  // de 60s en Vercel Hobby — todo el scoring vive en score-orphans.)
  newlyInserted.sort(
    (a, b) => b.item.publishedAt.getTime() - a.item.publishedAt.getTime(),
  );
  const scored = 0;
  const failedScores = 0;
  // Cap a 50 para no reventar Pusher con un solo push gigante cuando entra
  // un cron muy productivo (~400 items). Las que se queden las traerá el
  // próximo SSR / fetch del usuario.
  const broadcast: FeedNewsPayload[] = newlyInserted.slice(0, 50).map((e) => ({
    id: e.id,
    headline: e.item.headline,
    body: e.item.body,
    source: e.item.source,
    publishedAt: e.item.publishedAt.toISOString(),
    url: e.item.url,
    tickers: e.tickers,
    primarySymbol: e.tickers[0] ?? null,
    impact: null,
    sentiment: null,
    rationale: null,
  }));

  // 7) Enriquecer payload con logo+nombre del primary ticker antes del push.
  if (broadcast.length) {
    const primarySymbols = broadcast
      .map((b) => b.primarySymbol)
      .filter((s): s is string => Boolean(s));
    const meta = await getTickerMetaMap(primarySymbols);
    for (const b of broadcast) {
      if (b.primarySymbol) {
        const m = meta.get(b.primarySymbol);
        b.primaryName = m?.name ?? null;
        b.primaryLogo = m?.logoUrl ?? null;
      }
    }
    await broadcastNews(broadcast);
  }

  // 8) Enriquecer tickers pendientes (background-ish, mismo cron).
  const enriched = await enrichPendingTickers();

  // 9) Retention: borrar noticias antiguas. Los FK con onDelete: cascade
  // limpian news_tickers y news_scores automáticamente.
  await deleteOldNews(RETENTION_DAYS);

  return {
    fetched: {
      finnhub: finnhubItems.length,
      finnhubCompany: finnhubCoItems.length,
      marketaux: marketauxItems.length,
      rss: rssItems.length,
      gnewsTickers: gnewsItems.length,
    },
    inserted: newlyInserted.length,
    scored,
    failedScores,
    enriched,
    durationMs: Date.now() - t0,
  };
}
