import {
  fetchCompanyNewsBatch,
  fetchGeneralNews,
} from "@/lib/providers/finnhub";
import { fetchMarketauxNews } from "@/lib/providers/marketaux";
import { fetchAllRssNews } from "@/lib/providers/rss-aggregator";
import { fetchGoogleNewsByTicker } from "@/lib/providers/google-news-tickers";
import { extractTickers } from "@/lib/tickers/extractor";
import { enrichPendingTickers } from "@/lib/tickers/enricher";
import { scoreNewsItem } from "@/lib/scoring";
import {
  deleteOldNews,
  getTickerMetaMap,
  getTopTickersForFetch,
  insertNewsWithTickers,
  insertScore,
  loadAliases,
  upsertTickers,
} from "@/lib/db/queries";
import { broadcastNews, type FeedNewsPayload } from "@/lib/pusher/server";
import type { ExtractedTicker, NormalizedNewsItem } from "@/lib/types";

// Refresh-news NO scorea. Fetch + insert + enrich ya consume 30-40s en
// el 60s budget; añadirle scoring nos lleva a 504 intermitentes. score-
// orphans tiene su propio 60s tick cada 5min y se encarga de TODO el
// scoring. Latencia "news llega → news scoreada" sigue ≤5min.
const SCORING_BATCH = 0;
const SCORING_CONCURRENCY = 1;

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

  // 6) Scoring — priorizamos las más recientes y respetamos el cap.
  newlyInserted.sort(
    (a, b) => b.item.publishedAt.getTime() - a.item.publishedAt.getTime(),
  );
  const toScore = newlyInserted.slice(0, SCORING_BATCH);

  // Scoring concurrente — N workers tirando del queue. Cada provider tiene
  // rate-limit alto (Groq 30/min, OpenRouter ~20/min); con C=5 quedamos por
  // debajo y el batch entero corre en ~10-20s.
  let scored = 0;
  let failedScores = 0;
  const broadcast: FeedNewsPayload[] = [];
  let cursor = 0;
  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= toScore.length) return;
      const entry = toScore[i];
      try {
        const score = await scoreNewsItem({
          headline: entry.item.headline,
          body: entry.item.body,
          tickers: entry.tickers,
          source: entry.item.source,
        });
        if (score) {
          await insertScore(entry.id, score);
          scored++;
          broadcast.push({
            id: entry.id,
            headline: entry.item.headline,
            body: entry.item.body,
            source: entry.item.source,
            publishedAt: entry.item.publishedAt.toISOString(),
            url: entry.item.url,
            tickers: entry.tickers,
            primarySymbol: entry.tickers[0] ?? null,
            impact: score.impact,
            sentiment: score.sentiment,
            rationale: score.rationale,
          });
        } else {
          failedScores++;
        }
      } catch (err) {
        failedScores++;
        console.warn(
          `[cron] scoring failed for news ${entry.id}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  }
  await Promise.all(
    Array.from({ length: SCORING_CONCURRENCY }, () => worker()),
  );

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
