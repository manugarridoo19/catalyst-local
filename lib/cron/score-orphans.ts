import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { scoreNewsBatch, BATCH_SIZE } from "@/lib/scoring";
import {
  getTickerMetaMap,
  insertScore,
  removeTickersFromNews,
} from "@/lib/db/queries";
import { broadcastNews, type FeedNewsPayload } from "@/lib/pusher/server";

// v4 (2026-07): scoring por LOTES. Antes: 1 noticia = 1 llamada LLM, o sea
// 10 llamadas/tick y un techo de ~3.000 news/día con el pool entero — por
// debajo del inflow (~2.000/día) + backlog. Ahora: ORPHAN_BATCH noticias por
// tick en lotes de BATCH_SIZE (10) → 3 llamadas/tick, mismo rate-limit
// budget, ×10 throughput. La prioridad publishedAt DESC se mantiene: las
// noticias más recientes SIEMPRE entran en el primer lote.
const ORPHAN_BATCH = 30;

export type OrphanResult = {
  picked: number;
  scored: number;
  failed: number;
  unlinked: number;
  durationMs: number;
};

type OrphanRow = {
  id: number;
  headline: string;
  body: string | null;
  source: string;
  published_at: Date;
  url: string;
  tickers: string[];
};

function unwrap(r: unknown): OrphanRow[] {
  const w = r as { rows?: OrphanRow[] };
  return (w.rows ?? (r as OrphanRow[])) as OrphanRow[];
}

export async function runScoreOrphansCron(): Promise<OrphanResult> {
  const t0 = Date.now();

  // Cogemos las noticias con ticker SIN score, priorizando las más recientes
  // para que el feed siempre vea las nuevas con score primero.
  const raw = await db.execute(sql`
    SELECT n.id, n.headline, n.body, n.source, n.published_at, n.url,
      ARRAY(SELECT ticker FROM news_tickers WHERE news_id = n.id) AS tickers
    FROM news n
    WHERE NOT EXISTS (SELECT 1 FROM news_scores s WHERE s.news_id = n.id)
      AND EXISTS (SELECT 1 FROM news_tickers t WHERE t.news_id = n.id)
    ORDER BY n.published_at DESC
    LIMIT ${ORPHAN_BATCH}
  `);
  const rows = unwrap(raw);

  let scored = 0;
  let failed = 0;
  let unlinked = 0;
  const broadcast: FeedNewsPayload[] = [];

  // Lotes secuenciales — cada lote es UNA llamada LLM; la concurrencia ya
  // no aporta (el rate limit es por llamada, no por item).
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const chunk = rows.slice(i, i + BATCH_SIZE);
    const results = await scoreNewsBatch(
      chunk.map((r) => ({
        headline: r.headline,
        body: r.body ?? undefined,
        tickers: r.tickers ?? [],
        source: r.source,
      })),
    );

    for (let j = 0; j < chunk.length; j++) {
      const r = chunk[j];
      const score = results[j];
      if (!score) {
        failed++;
        continue;
      }
      try {
        // 1) Desvincular mislinks detectados por el LLM ANTES de decidir el
        // broadcast — si la noticia se queda sin tickers, sale del live feed
        // (requireTicker) y no la anunciamos.
        const wrong = new Set(score.wrongTickers);
        if (wrong.size) {
          await removeTickersFromNews(r.id, [...wrong]);
          unlinked += wrong.size;
        }
        const remaining = (r.tickers ?? []).filter(
          (t) => !wrong.has(t.toUpperCase()),
        );

        await insertScore(r.id, score);
        scored++;

        if (remaining.length) {
          broadcast.push({
            id: r.id,
            headline: r.headline,
            body: r.body,
            source: r.source,
            publishedAt: new Date(r.published_at).toISOString(),
            url: r.url,
            tickers: remaining,
            primarySymbol: remaining[0] ?? null,
            impact: score.impact,
            sentiment: score.sentiment,
            rationale: score.rationale,
          });
        }
      } catch (err) {
        failed++;
        console.warn(
          `[score-orphans] failed news ${r.id}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  }

  // Enriquecer y empujar a Pusher para que el cliente vea los nuevos scores
  // sin recargar. Mismo patrón que refresh-news.
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

  return {
    picked: rows.length,
    scored,
    failed,
    unlinked,
    durationMs: Date.now() - t0,
  };
}
