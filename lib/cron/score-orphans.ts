import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { scoreNewsItem } from "@/lib/scoring";
import { getTickerMetaMap, insertScore } from "@/lib/db/queries";
import { broadcastNews, type FeedNewsPayload } from "@/lib/pusher/server";

// Batch + concurrencia calibradas para 60s Vercel Hobby. 50 × ~2s / 5 = 20s
// margen para enriquecimiento y broadcast.
// Con Groq 70b en producción salimos ~250-400ms/call. BATCH=10 corrió en
// 15.7s — margen enorme dentro de los 60s. Subimos a 25 para drenar el
// backlog mucho más rápido: 25 × 0.4s ≈ 10s + DB/broadcast ≈ 15-20s total.
// Drainage 25/tick × 12 ticks/hora = 300 news scoreadas/hora.
const ORPHAN_BATCH = 25;
const ORPHAN_CONCURRENCY = 1;

export type OrphanResult = {
  picked: number;
  scored: number;
  failed: number;
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
  const broadcast: FeedNewsPayload[] = [];

  let cursor = 0;
  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= rows.length) return;
      const r = rows[i];
      try {
        const score = await scoreNewsItem({
          headline: r.headline,
          body: r.body ?? undefined,
          tickers: r.tickers ?? [],
          source: r.source,
        });
        if (score) {
          await insertScore(r.id, score);
          scored++;
          broadcast.push({
            id: r.id,
            headline: r.headline,
            body: r.body,
            source: r.source,
            publishedAt: new Date(r.published_at).toISOString(),
            url: r.url,
            tickers: r.tickers ?? [],
            primarySymbol: r.tickers?.[0] ?? null,
            impact: score.impact,
            sentiment: score.sentiment,
            rationale: score.rationale,
          });
        } else {
          failed++;
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
  await Promise.all(
    Array.from({ length: ORPHAN_CONCURRENCY }, () => worker()),
  );

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
    durationMs: Date.now() - t0,
  };
}
