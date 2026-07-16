import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { scoreNewsBatch, BATCH_SIZE } from "@/lib/scoring";
import {
  getTickerMetaMap,
  insertScore,
  removeTickersFromNews,
} from "@/lib/db/queries";
import { broadcastNews, type FeedNewsPayload } from "@/lib/pusher/server";
import { UNSCORED_RETENTION_DAYS } from "@/lib/time-windows";

// v4 (2026-07): scoring por LOTES. Antes: 1 noticia = 1 llamada LLM, o sea
// 10 llamadas/tick y un techo de ~3.000 news/día con el pool entero — por
// debajo del inflow (~2.000/día) + backlog. Ahora: ORPHAN_BATCH noticias por
// tick en lotes de BATCH_SIZE (10), mismo rate-limit budget, ×10 throughput.
//
// v4.1 (2026-07-16): pick HÍBRIDO. El picker puro publishedAt DESC tenía
// starvation estructural: con inflow ≈ capacidad, todo lo que perdía su
// ventana (horas de cuota agotada) se hundía y no se volvía a tocar jamás
// — 18k del backlog tenían >7 días. Ahora cada tick coge 2/3 de lo más
// nuevo (el feed sigue viendo scores frescos al momento) + 1/3 del FONDO
// del backlog (oldest-first, garantiza convergencia a cero). Subida 30→60
// (6 llamadas/tick): el pool de Gemini (2026-07-16) absorbe el extra.
const ORPHAN_BATCH = 60;
const BACKLOG_SHARE = ORPHAN_BATCH / 3; // 20 del fondo del backlog
// Items que un batch respondido omite/malforma >= MAX_ATTEMPTS veces se
// abandonan (badge "—" permanente) en vez de reintentar eternamente.
const MAX_ATTEMPTS = 5;

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

  // Pick híbrido: primero lo más reciente (freshness del feed), después el
  // fondo del backlog (anti-starvation). Ambas mitades excluyen items ya
  // abandonados por el cap de intentos.
  const fresh = unwrap(
    await db.execute(sql`
      SELECT n.id, n.headline, n.body, n.source, n.published_at, n.url,
        ARRAY(SELECT ticker FROM news_tickers WHERE news_id = n.id) AS tickers
      FROM news n
      WHERE NOT EXISTS (SELECT 1 FROM news_scores s WHERE s.news_id = n.id)
        AND EXISTS (SELECT 1 FROM news_tickers t WHERE t.news_id = n.id)
        AND n.scoring_attempts < ${MAX_ATTEMPTS}
        AND n.published_at >= now() - make_interval(days => ${UNSCORED_RETENTION_DAYS})
      ORDER BY n.published_at DESC
      LIMIT ${ORPHAN_BATCH - BACKLOG_SHARE}
    `),
  );
  // OJO driver Neon: `= ANY(${jsArray})` llega como escalar y peta con
  // 42809 — hay que interpolar la lista con sql.join.
  const freshIdList = fresh.length
    ? sql.join(
        fresh.map((r) => sql`${r.id}`),
        sql`, `,
      )
    : sql`-1`;
  const backlog = unwrap(
    await db.execute(sql`
      SELECT n.id, n.headline, n.body, n.source, n.published_at, n.url,
        ARRAY(SELECT ticker FROM news_tickers WHERE news_id = n.id) AS tickers
      FROM news n
      WHERE NOT EXISTS (SELECT 1 FROM news_scores s WHERE s.news_id = n.id)
        AND EXISTS (SELECT 1 FROM news_tickers t WHERE t.news_id = n.id)
        AND n.scoring_attempts < ${MAX_ATTEMPTS}
        AND n.published_at >= now() - make_interval(days => ${UNSCORED_RETENTION_DAYS})
        AND n.id NOT IN (${freshIdList})
      ORDER BY n.published_at ASC
      LIMIT ${BACKLOG_SHARE}
    `),
  );
  const rows = [...fresh, ...backlog];

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

    // Cap de intentos: si el batch produjo AL MENOS un score (= el provider
    // respondió), los items que vinieron omitidos/malformados suman intento.
    // Un batch entero a null es fallo de provider (cuota) — no cuenta.
    const chunkScored = results.filter(Boolean).length;
    if (chunkScored > 0) {
      const omittedIds = chunk
        .filter((_, j) => !results[j])
        .map((r) => r.id);
      if (omittedIds.length) {
        await db.execute(sql`
          UPDATE news SET scoring_attempts = scoring_attempts + 1
          WHERE id IN (${sql.join(
            omittedIds.map((id) => sql`${id}`),
            sql`, `,
          )})
        `);
      }
    }

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
