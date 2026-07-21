import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { getKeyPoolStatus } from "@/lib/providers/openrouter";
import { getGeminiPoolStatus } from "@/lib/providers/gemini";
import { groqCooldownStatus } from "@/lib/providers/groq";

// Endpoint público de health-check para monitoring. No expone secretos, solo
// agregados que necesita el alerting (GitHub Actions / cron-job.org / etc).

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Función rápida, una sola query — no necesita 60s budget.
export const maxDuration = 10;

/** Plan free de Neon: 0.5 GB de almacenamiento para toda la base. */
const NEON_FREE_MB = 512;

export async function GET() {
  try {
    const r = await db.execute(sql`
      SELECT
        (SELECT MAX(published_at) FROM news)::timestamptz AS last_published_at,
        (SELECT MAX(created_at)   FROM news)::timestamptz AS last_inserted_at,
        (SELECT COUNT(*) FROM news WHERE created_at > NOW() - INTERVAL '1 hour')::int AS inserted_last_hour,
        (SELECT COUNT(*) FROM news n
           WHERE NOT EXISTS (SELECT 1 FROM news_scores s WHERE s.news_id = n.id)
             AND EXISTS (SELECT 1 FROM news_tickers t WHERE t.news_id = n.id))::int AS unscored_with_tickers,
        (SELECT COUNT(*) FROM news_scores)::int AS scored_total,
        (SELECT MAX(scored_at) FROM news_scores)::timestamptz AS last_scored_at,
        (SELECT COUNT(*) FROM news_scores WHERE scored_at > NOW() - INTERVAL '1 hour')::int AS scored_last_hour,
        (SELECT MAX(generated_at) FROM author_briefs)::timestamptz AS last_author_brief_at,
        -- Almacenamiento: Neon free son 0.5 GB para TODA la base y los
        -- embeddings son lo primero que puede comérselos. Sin este número
        -- el techo se descubre cuando la BD deja de aceptar escrituras,
        -- que se parecería a una caída del feed.
        (pg_database_size(current_database()) / 1048576.0)::float8 AS db_mb,
        (SELECT COUNT(*) FROM news_embeddings)::int AS embeddings_total,
        (SELECT MAX(created_at) FROM news_embeddings)::timestamptz AS last_embedded_at
    `);
    const row = ((r as { rows?: Record<string, unknown>[] }).rows ?? (r as unknown as Record<string, unknown>[]))[0];

    const lastPublished = row.last_published_at ? new Date(row.last_published_at as string) : null;
    const lastInserted = row.last_inserted_at ? new Date(row.last_inserted_at as string) : null;
    const now = Date.now();
    const publishedAgeMin = lastPublished
      ? Math.round((now - lastPublished.getTime()) / 60000)
      : null;
    const insertedAgeMin = lastInserted
      ? Math.round((now - lastInserted.getTime()) / 60000)
      : null;
    // Edad del último score — la señal que faltaba el 2026-07-17, cuando
    // el cron llevaba horas cancelado y nada lo detectó. La vigila el
    // workflow catalyst-health-monitor.
    const lastScored = row.last_scored_at ? new Date(row.last_scored_at as string) : null;
    const scoredAgeMin = lastScored
      ? Math.round((now - lastScored.getTime()) / 60000)
      : null;
    // Edad del último author brief. El agente sale con 0 SIEMPRE (por
    // diseño anti-popup), así que sin esta señal unas cookies de Brave
    // caducadas dejarían el Author Watch rancio en silencio — la misma
    // clase de fallo mudo que el incidente de scoring del 2026-07-17.
    const lastAuthorBrief = row.last_author_brief_at
      ? new Date(row.last_author_brief_at as string)
      : null;
    const authorBriefAgeMin = lastAuthorBrief
      ? Math.round((now - lastAuthorBrief.getTime()) / 60000)
      : null;

    const lastEmbedded = row.last_embedded_at
      ? new Date(row.last_embedded_at as string)
      : null;
    const embedAgeMin = lastEmbedded
      ? Math.round((now - lastEmbedded.getTime()) / 60000)
      : null;

    // Pool + cooldown diagnostic. Sin exponer keys: solo labels + flags.
    // Útil para correlacionar gaps de scoring con saturación de providers
    // antes de mirar logs.
    const openrouterPool = getKeyPoolStatus();
    const geminiPool = getGeminiPoolStatus();
    const groqCooldowns = groqCooldownStatus();

    return NextResponse.json({
      ok: true,
      now: new Date(now).toISOString(),
      lastPublishedAt: lastPublished?.toISOString() ?? null,
      lastInsertedAt: lastInserted?.toISOString() ?? null,
      publishedAgeMin,
      insertedAgeMin,
      insertedLastHour: row.inserted_last_hour,
      unscoredWithTickers: row.unscored_with_tickers,
      scoredTotal: row.scored_total,
      lastScoredAt: lastScored?.toISOString() ?? null,
      scoredAgeMin,
      scoredLastHour: row.scored_last_hour,
      lastAuthorBriefAt: lastAuthorBrief?.toISOString() ?? null,
      authorBriefAgeMin,
      storage: {
        dbMb: Math.round(Number(row.db_mb ?? 0)),
        freeTierMb: NEON_FREE_MB,
        pctUsed: Math.round((Number(row.db_mb ?? 0) / NEON_FREE_MB) * 100),
        // Umbral con el que la ingesta de embeddings se pausa sola. Si
        // dbMb lo supera, el archivo consultable deja de crecer (a
        // propósito) pero el feed sigue.
        embedPauseAtMb: Number(process.env.EMBED_MAX_DB_MB ?? 380),
        embeddingsTotal: row.embeddings_total,
        lastEmbeddedAt: lastEmbedded?.toISOString() ?? null,
        embedAgeMin: embedAgeMin,
      },
      scoring: {
        openrouter: {
          total: openrouterPool.total,
          available: openrouterPool.available,
          pool: openrouterPool.pool,
        },
        gemini: {
          total: geminiPool.total,
          available: geminiPool.available,
          primary: geminiPool.primary,
          reserve: geminiPool.reserve,
          pool: geminiPool.pool,
        },
        groq: {
          cooldowns: groqCooldowns,
        },
      },
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
