import {
  fetchCompanyNewsBatch,
  fetchGeneralNews,
} from "@/lib/providers/finnhub";
import { fetchMarketauxNews } from "@/lib/providers/marketaux";
import { fetchAllRssNews } from "@/lib/providers/rss-aggregator";
import { fetchGoogleNewsByTicker } from "@/lib/providers/google-news-tickers";
import { fetchSecFilings } from "@/lib/providers/sec-edgar";
import { extractTickers } from "@/lib/tickers/extractor";
import { enrichPendingTickers } from "@/lib/tickers/enricher";
import {
  deleteOldNews,
  deleteUnscoredOlderThan,
  getTickerMetaMap,
  getTopTickersForFetch,
  insertNewsBatch,
  loadAliases,
  loadKnownSymbols,
  upsertTickers,
} from "@/lib/db/queries";
import { broadcastNews, type FeedNewsPayload } from "@/lib/pusher/server";
import { RETENTION_DAYS, UNSCORED_RETENTION_DAYS } from "@/lib/time-windows";
import type { ExtractedTicker, NormalizedNewsItem } from "@/lib/types";

// Refresh-news NO scorea. Fetch + insert + enrich ya consume 30-40s en
// el 60s budget; añadirle scoring nos lleva a 504 intermitentes. score-
// orphans tiene su propio 60s tick cada 5min y se encarga de TODO el
// scoring. Latencia "news llega → broadcast" ahora es inmediata; los
// badges Signif/Sent aparecen cuando score-orphans rebroadcast con
// score → el cliente actualiza el card in-place por id.

// Retención: ver lib/time-windows.ts (20 días). Live feed muestra solo
// today; ticker pages 15 días; el buffer extra (>15d) cubre lookback
// para usuarios que naveguen ticker pages al borde de la ventana.

export type CronResult = {
  fetched: {
    finnhub: number;
    finnhubCompany: number;
    marketaux: number;
    rss: number;
    gnewsTickers: number;
    sec: number;
  };
  inserted: number;
  scored: number;
  failedScores: number;
  enriched: { processed: number; succeeded: number };
  durationMs: number;
};

export async function runRefreshNewsCron(): Promise<CronResult> {
  const t0 = Date.now();

  // 1) Resolver top tickers + universo conocido ANTES del fetch. topTickers
  // guía el barrido per-ticker (Finnhub/Google News); knownSymbols filtra
  // SEC EDGAR a las empresas que ya seguimos (y se reutiliza en la
  // extracción, fase 3 — no se recarga).
  const [topTickers, knownSymbols] = await Promise.all([
    getTopTickersForFetch(50).catch(() => []),
    loadKnownSymbols().catch(() => new Set<string>()),
  ]);

  // 2) Fetch en paralelo (un proveedor caído no tumba el cron).
  // Slicing restaurado a valores originales tras mover cron a GitHub
  // Actions runner. CPU del runner no afecta Vercel Fluid; los caps
  // reales son Finnhub free (60/min) y el wall-clock del workflow
  // (timeout 3min en cron-runner.yml). Quedamos cómodos en ambos.
  const [finnhubR, finnhubCoR, marketauxR, rssR, gnewsR, secR] =
    await Promise.allSettled([
      fetchGeneralNews(),
      fetchCompanyNewsBatch(
        topTickers.slice(0, 15).map((t) => t.symbol),
        3,
      ),
      fetchMarketauxNews(),
      fetchAllRssNews(),
      fetchGoogleNewsByTicker(topTickers.slice(0, 25)),
      fetchSecFilings(knownSymbols),
    ]);

  const finnhubItems = finnhubR.status === "fulfilled" ? finnhubR.value : [];
  const finnhubCoItems =
    finnhubCoR.status === "fulfilled" ? finnhubCoR.value : [];
  const marketauxItems =
    marketauxR.status === "fulfilled" ? marketauxR.value : [];
  const rssItems = rssR.status === "fulfilled" ? rssR.value : [];
  const gnewsItems = gnewsR.status === "fulfilled" ? gnewsR.value : [];
  const secItems = secR.status === "fulfilled" ? secR.value : [];
  if (finnhubR.status === "rejected") console.warn("[cron] finnhub failed:", finnhubR.reason);
  if (finnhubCoR.status === "rejected") console.warn("[cron] finnhub-company failed:", finnhubCoR.reason);
  if (marketauxR.status === "rejected") console.warn("[cron] marketaux failed:", marketauxR.reason);
  if (rssR.status === "rejected") console.warn("[cron] rss failed:", rssR.reason);
  if (gnewsR.status === "rejected") console.warn("[cron] gnews-tickers failed:", gnewsR.reason);
  if (secR.status === "rejected") console.warn("[cron] sec-edgar failed:", secR.reason);

  const allItems = [
    ...finnhubItems,
    ...finnhubCoItems,
    ...marketauxItems,
    ...rssItems,
    ...gnewsItems,
    ...secItems,
  ];

  // 2) Dedupe por hash dentro del lote.
  const byHash = new Map<string, NormalizedNewsItem>();
  for (const item of allItems) {
    if (!byHash.has(item.hash)) byHash.set(item.hash, item);
  }
  const deduped = Array.from(byHash.values());

  // 2b) Clamp de fechas futuras. investing.com emite pubDate con timezone
  // roto (~3h adelantado); con orden publishedAt DESC una fecha futura se
  // clava arriba del feed durante horas y entierra lo realmente nuevo.
  // Margen de 2min por clock-skew legítimo entre fuentes.
  const maxPublishedMs = Date.now() + 2 * 60 * 1000;
  let clamped = 0;
  for (const item of deduped) {
    if (item.publishedAt.getTime() > maxPublishedMs) {
      item.publishedAt = new Date();
      clamped++;
    }
  }
  if (clamped) {
    console.warn(`[cron] clamped ${clamped} future-dated publishedAt to now`);
  }

  // 3) Cargar aliases + extraer tickers. knownSymbols ya se cargó arriba
  // (para el filtro SEC) — lo reutilizamos aquí.
  const aliases = await loadAliases();
  const itemsWithTickers: { item: NormalizedNewsItem; tickers: ExtractedTicker[] }[] =
    deduped.map((item) => ({
      item,
      tickers: extractTickers(item, aliases, { knownSymbols }),
    }));

  // 4) Asegurar que todos los símbolos detectados estén en `tickers`.
  const allSymbols = new Set<string>();
  for (const { tickers: ts } of itemsWithTickers) {
    for (const t of ts) allSymbols.add(t.symbol);
  }
  await upsertTickers([...allSymbols], "cron");

  // 5) Insertar noticias nuevas en chunks transaccionales.
  // Antes era un loop secuencial item-a-item (~100-300ms × 400 items =
  // 40-120s, rozando el budget de 60s del cron Hobby). Ahora chunks de 50
  // dentro de una transacción cada uno — fault isolation por chunk, dos
  // INSERTs batched por chunk. Total ~1.6-4s en picos.
  const { inserted: newlyInserted, failures: insertFailures } =
    await insertNewsBatch(itemsWithTickers);
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
  // limpian news_tickers y news_scores automáticamente. Además purga las
  // noticias SIN score de >5 días (ya no vale la pena puntuarlas — recorta
  // el backlog de scoring a lo accionable).
  await deleteOldNews(RETENTION_DAYS);
  await deleteUnscoredOlderThan(UNSCORED_RETENTION_DAYS);

  return {
    fetched: {
      finnhub: finnhubItems.length,
      finnhubCompany: finnhubCoItems.length,
      marketaux: marketauxItems.length,
      rss: rssItems.length,
      gnewsTickers: gnewsItems.length,
      sec: secItems.length,
    },
    inserted: newlyInserted.length,
    scored,
    failedScores,
    enriched,
    durationMs: Date.now() - t0,
  };
}
