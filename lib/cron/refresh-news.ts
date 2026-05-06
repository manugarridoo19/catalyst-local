import { fetchGeneralNews } from "@/lib/providers/finnhub";
import { fetchMarketauxNews } from "@/lib/providers/marketaux";
import { fetchAllRssNews } from "@/lib/providers/rss-aggregator";
import { extractTickers } from "@/lib/tickers/extractor";
import { enrichPendingTickers } from "@/lib/tickers/enricher";
import { scoreNewsItem } from "@/lib/scoring";
import {
  getTickerMetaMap,
  insertNewsWithTickers,
  insertScore,
  loadAliases,
  upsertTickers,
} from "@/lib/db/queries";
import { broadcastNews, type FeedNewsPayload } from "@/lib/pusher/server";
import type { ExtractedTicker, NormalizedNewsItem } from "@/lib/types";

// Cap por ejecución. Modelos `:free` son lentos bajo carga (~3-10s por
// llamada), así que mantenemos el batch pequeño para que el cron termine
// dentro del límite de 60s de Vercel Hobby. El resto se procesa en el
// siguiente tick.
const SCORING_BATCH = 8;

export type CronResult = {
  fetched: { finnhub: number; marketaux: number; rss: number };
  inserted: number;
  scored: number;
  failedScores: number;
  enriched: { processed: number; succeeded: number };
  durationMs: number;
};

export async function runRefreshNewsCron(): Promise<CronResult> {
  const t0 = Date.now();

  // 1) Fetch en paralelo (un proveedor caído no tumba el cron).
  const [finnhubR, marketauxR, rssR] = await Promise.allSettled([
    fetchGeneralNews(),
    fetchMarketauxNews(),
    fetchAllRssNews(),
  ]);

  const finnhubItems = finnhubR.status === "fulfilled" ? finnhubR.value : [];
  const marketauxItems =
    marketauxR.status === "fulfilled" ? marketauxR.value : [];
  const rssItems = rssR.status === "fulfilled" ? rssR.value : [];
  if (finnhubR.status === "rejected") console.warn("[cron] finnhub failed:", finnhubR.reason);
  if (marketauxR.status === "rejected") console.warn("[cron] marketaux failed:", marketauxR.reason);
  if (rssR.status === "rejected") console.warn("[cron] rss failed:", rssR.reason);

  const allItems = [...finnhubItems, ...marketauxItems, ...rssItems];

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
  const newlyInserted: { id: number; item: NormalizedNewsItem; tickers: string[] }[] = [];
  for (const { item, tickers } of itemsWithTickers) {
    const id = await insertNewsWithTickers(item, tickers);
    if (id) {
      newlyInserted.push({ id, item, tickers: tickers.map((t) => t.symbol) });
    }
  }

  // 6) Scoring — priorizamos las más recientes y respetamos el cap.
  newlyInserted.sort(
    (a, b) => b.item.publishedAt.getTime() - a.item.publishedAt.getTime(),
  );
  const toScore = newlyInserted.slice(0, SCORING_BATCH);

  let scored = 0;
  let failedScores = 0;
  const broadcast: FeedNewsPayload[] = [];
  for (const entry of toScore) {
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

  return {
    fetched: {
      finnhub: finnhubItems.length,
      marketaux: marketauxItems.length,
      rss: rssItems.length,
    },
    inserted: newlyInserted.length,
    scored,
    failedScores,
    enriched,
    durationMs: Date.now() - t0,
  };
}
