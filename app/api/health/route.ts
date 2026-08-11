import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db, unwrapRows } from "@/lib/db";
import { getKeyPoolStatus } from "@/lib/providers/openrouter";
import { getGeminiPoolStatus } from "@/lib/providers/gemini";
import { groqCooldownStatus } from "@/lib/providers/groq";
import { finnhubCooldownMs } from "@/lib/providers/finnhub";
import { isWorkersRuntime, rateLimited } from "@/lib/ask/gate";

// Endpoint público de health-check para monitoring. No expone secretos, solo
// agregados que necesita el alerting (GitHub Actions / cron-job.org / etc).
//
// La consulta NO es barata pese al comentario histórico de "una sola query":
// son ocho agregados, uno de ellos un anti-join sobre `news` entera que
// ningún índice cubre, más `pg_database_size()`. Cubo de rate limit PROPIO
// (30/min) y no el común: el sondeo de monitorización llega cada 2h, así que
// le sobra de largo, y separarlo evita que consuma el presupuesto de las
// preguntas del dueño (o al revés, que un pico de /ask silencie el monitor).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Función rápida, una sola query — no necesita 60s budget.
export const maxDuration = 10;

// 60s de caché de borde: el monitor sondea cada 2h y un humano recargando la
// página de estado no necesita recontar la tabla `news` en cada F5.
const HEALTH_CACHE = "public, s-maxage=60, stale-while-revalidate=120";

/** Plan free de Neon: 0.5 GB de almacenamiento para toda la base. */
const NEON_FREE_MB = 512;

export async function GET(req: Request) {
  if (isWorkersRuntime && rateLimited(req, "health")) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }
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
        (SELECT MAX(created_at) FROM news_embeddings)::timestamptz AS last_embedded_at,
        -- Fase 3: sin estas señales, una rotura silenciosa de FINRA (API sin
        -- contrato de versión) o de un barrido del cron sólo se descubriría
        -- mirando un ticker a mano semanas después.
        (SELECT MAX(fetched_at) FROM short_interest)::timestamptz AS short_interest_fetched_at,
        (SELECT COUNT(*) FROM short_interest)::int AS short_interest_rows,
        (SELECT ran_at FROM job_state WHERE key = 'funds-sweep')::timestamptz AS funds_sweep_at,
        (SELECT ran_at FROM job_state WHERE key = 'earnings-sweep')::timestamptz AS earnings_sweep_at
    `);
    // `unwrapRows` en vez del desempaquetado a mano: es la regla del
    // proyecto para todo `db.execute` crudo, y la versión manual lanzaba un
    // TypeError si la consulta no devolvía filas.
    const row = unwrapRows<Record<string, unknown>>(r)[0];
    if (!row) {
      return NextResponse.json(
        { ok: false, error: "health query returned no rows" },
        { status: 500 },
      );
    }

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
    // Finnhub es UNA key, no un pool, así que `available` es un booleano y no
    // un recuento como en openrouter/gemini. Importa que se vea: con la key
    // enfriada `fh()` ya ni pregunta (lanza FinnhubError 429), así que un
    // enfriamiento largo deja sin quotes al rail de la watchlist y sin precios
    // en vivo a la revisión de cartera — y desde fuera eso se parece a un
    // fallo de la app, no a un límite del proveedor.
    const finnhubCooling = finnhubCooldownMs();

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
      phase3: {
        // FINRA publica cada ~15 días con ~2 semanas de retraso: una edad
        // de hasta ~30 días es normal; >35 días = ingesta rota.
        shortInterestAgeDays: row.short_interest_fetched_at
          ? Math.round(
              (now - new Date(row.short_interest_fetched_at as string).getTime()) /
                86_400_000,
            )
          : null,
        shortInterestRows: row.short_interest_rows,
        fundsSweepAgeMin: row.funds_sweep_at
          ? Math.round((now - new Date(row.funds_sweep_at as string).getTime()) / 60000)
          : null,
        earningsSweepAgeMin: row.earnings_sweep_at
          ? Math.round(
              (now - new Date(row.earnings_sweep_at as string).getTime()) / 60000,
            )
          : null,
      },
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
          // Muertas por autenticación (401/403). Se saca aparte de
          // `available` porque las dos averías piden lo contrario: una se
          // cura esperando, la otra sólo emitiendo una key nueva.
          dead: geminiPool.deadCount,
          primary: geminiPool.primary,
          reserve: geminiPool.reserve,
          pool: geminiPool.pool,
        },
        groq: {
          cooldowns: groqCooldowns,
        },
        finnhub: {
          available: finnhubCooling === 0,
          // Segundos, como los cooldowns de groq — la misma unidad para la
          // misma clase de dato evita tener que mirar el código para saber
          // si un 60 son ms, segundos o minutos.
          secondsRemaining: Math.ceil(finnhubCooling / 1000),
          cooldownUntil:
            finnhubCooling > 0
              ? new Date(now + finnhubCooling).toISOString()
              : null,
        },
      },
    }, { headers: { "Cache-Control": HEALTH_CACHE } });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
