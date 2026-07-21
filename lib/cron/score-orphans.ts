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
import { enrichTopStories } from "@/lib/articles/enrich";
import { runEmbedIngest } from "@/lib/embeddings/ingest";

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
// Overridable por env: el cron de GH Actions (única capacidad con el Mac
// dormido, cadencia real 1-4h por throttling) necesita ticks más grandes
// que el scorer local de cada 15min. Cap 300 = 30 llamadas/tick.
const ORPHAN_BATCH = Math.min(
  Math.max(parseInt(process.env.ORPHAN_BATCH ?? "", 10) || 60, 10),
  300,
);
const BACKLOG_SHARE = Math.floor(ORPHAN_BATCH / 3);
// Claim TTL: un item elegido por otro picker hace <10min no se re-elige
// (evita doble gasto LLM); si aquel proceso murió, el claim expira solo.
const CLAIM_TTL_MIN = 10;
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
  // v4.2 (2026-07-17): pick + claim en UNA sentencia atómica. GH cron,
  // scorer local y drains manuales corren contra la misma BD; sin claim,
  // dos pickers simultáneos elegían los mismos items y duplicaban gasto de
  // cuota LLM. El re-check de claimed_at en el WHERE del UPDATE hace que,
  // bajo carrera, el segundo picker simplemente reciba menos filas (READ
  // COMMITTED re-evalúa la condición sobre la fila bloqueada).
  //
  // Mitad backlog: antes oldest-first (ASC) — gastaba 1/3 de capacidad en
  // items a horas de la purga de 5 días y la banda media (1-4d) no la
  // cubría nadie. Ahora banda >24h por recencia DESC (recency-first
  // también en scoring); la cola que no dé tiempo a puntuar la libera la
  // purga, no el picker.
  const claimable = sql`
    NOT EXISTS (SELECT 1 FROM news_scores s WHERE s.news_id = n.id)
    AND EXISTS (SELECT 1 FROM news_tickers t WHERE t.news_id = n.id)
    AND n.scoring_attempts < ${MAX_ATTEMPTS}
    AND n.published_at >= now() - make_interval(days => ${UNSCORED_RETENTION_DAYS})
    AND (n.claimed_at IS NULL OR n.claimed_at < now() - make_interval(mins => ${CLAIM_TTL_MIN}))
  `;
  const rows = unwrap(
    await db.execute(sql`
      WITH fresh AS (
        SELECT n.id FROM news n
        WHERE ${claimable}
        ORDER BY n.published_at DESC
        LIMIT ${ORPHAN_BATCH - BACKLOG_SHARE}
      ),
      mid AS (
        SELECT n.id FROM news n
        WHERE ${claimable}
          AND n.published_at < now() - make_interval(hours => 24)
          AND n.id NOT IN (SELECT id FROM fresh)
        ORDER BY n.published_at DESC
        LIMIT ${BACKLOG_SHARE}
      )
      UPDATE news SET claimed_at = now()
      WHERE news.id IN (SELECT id FROM fresh UNION ALL SELECT id FROM mid)
        AND (news.claimed_at IS NULL OR news.claimed_at < now() - make_interval(mins => ${CLAIM_TTL_MIN}))
      RETURNING news.id, news.headline, news.body, news.source,
        news.published_at, news.url,
        ARRAY(SELECT ticker FROM news_tickers WHERE news_id = news.id) AS tickers
    `),
  );
  // RETURNING no conserva orden — los lotes se procesan newest-first para
  // que los scores frescos lleguen al feed cuanto antes.
  rows.sort(
    (a, b) =>
      new Date(b.published_at).getTime() - new Date(a.published_at).getTime(),
  );

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
        // (requireTicker) y no la anunciamos. removeTickersFromNews protege
        // los links api-confidence (devuelve solo los borrados de verdad) —
        // esos siguen vigentes y deben seguir en el broadcast.
        let actuallyRemoved: string[] = [];
        if (score.wrongTickers.length) {
          actuallyRemoved = await removeTickersFromNews(
            r.id,
            score.wrongTickers,
          );
          unlinked += actuallyRemoved.length;
        }
        const removedSet = new Set(actuallyRemoved.map((t) => t.toUpperCase()));
        const remaining = (r.tickers ?? []).filter(
          (t) => !removedSet.has(t.toUpperCase()),
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
            summary: score.summary,
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

  // Pre-enrich de los high-impact recién puntuados (extracción + resumen
  // IA en article_extracts) para que el click del usuario sea instantáneo.
  // Best-effort y con cap corto — el endpoint on-demand cubre el resto.
  // Solo corre en Node (cron/daemon); el Worker nunca llega aquí.
  const highImpact = broadcast
    .filter((b) => (b.impact ?? 0) >= 4)
    .map((b) => b.id);
  if (highImpact.length) {
    const cap = Number(process.env.ENRICH_BATCH ?? 4);
    try {
      const done = await enrichTopStories(highImpact, cap);
      if (done) console.log(`[score-orphans] pre-enriched ${done} high-impact articles`);
    } catch (err) {
      console.warn(
        "[score-orphans] pre-enrich failed:",
        err instanceof Error ? err.message.slice(0, 140) : err,
      );
    }
  }

  // Embeddings del archivo (Ask Catalyst). Va aquí y no en un job aparte
  // para que lo recién puntuado con impact>=3 entre en el índice en la
  // MISMA pasada: el archivo consultable queda a minutos del feed. Es una
  // sola llamada HTTP por tick y no gasta cuota LLM (métrica distinta), así
  // que no compite con el scoring. Best-effort: si falla, el siguiente tick
  // recoge lo mismo (la selección es "lo que no tiene embedding").
  try {
    const emb = await runEmbedIngest();
    if (emb.embedded || emb.purged || emb.skipped) {
      console.log(
        `[score-orphans] embeddings: +${emb.embedded} -${emb.purged}` +
          (emb.skipped ? ` (skipped: ${emb.skipped})` : "") +
          ` db=${emb.dbMb.toFixed(0)}MB`,
      );
    }
  } catch (err) {
    console.warn(
      "[score-orphans] embed ingest failed:",
      err instanceof Error ? err.message.slice(0, 140) : err,
    );
  }

  return {
    picked: rows.length,
    scored,
    failed,
    unlinked,
    durationMs: Date.now() - t0,
  };
}
