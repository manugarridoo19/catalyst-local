import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { getKeyPoolStatus } from "@/lib/providers/openrouter";
import { groqCooldownStatus } from "@/lib/providers/groq";

// Endpoint público de health-check para monitoring. No expone secretos, solo
// agregados que necesita el alerting (GitHub Actions / cron-job.org / etc).

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Función rápida, una sola query — no necesita 60s budget.
export const maxDuration = 10;

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
        (SELECT COUNT(*) FROM news_scores)::int AS scored_total
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

    // Pool + cooldown diagnostic. Sin exponer keys: solo labels + flags.
    // Útil para correlacionar gaps de scoring con saturación de providers
    // antes de mirar logs.
    const openrouterPool = getKeyPoolStatus();
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
      scoring: {
        openrouter: {
          total: openrouterPool.total,
          available: openrouterPool.available,
          pool: openrouterPool.pool,
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
