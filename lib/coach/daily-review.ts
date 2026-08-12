import { sql } from "drizzle-orm";
import { db, unwrapRows } from "@/lib/db";
import { getWatchlist } from "@/lib/db/queries";
import { getQuotesMap } from "@/lib/providers/finnhub";
import { MARKET_REF_SYMBOLS } from "@/lib/portfolio";
import { retrievePortfolio, citationNumberFor } from "@/lib/ask/portfolio";
import { earningsReads } from "@/lib/ask/retrieve";
import { extractForwardLedger } from "@/lib/ai/forward-ledger";
import { reviewPortfolio, type PositionVerdict } from "@/lib/ai/portfolio-review";
import { loadContrasts } from "@/lib/coach/build";
import { getFalsifiers } from "@/lib/coach/falsifiers";
import { claimableSessionIds } from "@/lib/session";

// La revisión de cartera DIARIA.
//
// Corre en el cron y no en la ruta, por el mismo motivo que los falsadores:
// mirar la revisión no puede costar cuota. El cron la redacta una vez al
// día y `/api/portfolio-review` (GET) la sirve gratis tantas veces como se
// pida. El botón de `/ask` sigue existiendo para forzar una fresca.
//
// SOLO PARA SESIONES DEL DUEÑO (`claimableSessionIds`). El Worker público
// acepta escrituras anónimas, así que sin este filtro cualquiera que se
// montara posiciones en su propia sesión tendría un job diario redactando
// gratis con la cuota del proyecto — el mismo razonamiento que ya aísla el
// universo de tickers y el gate de `/api/article`.

export type StoredReview = {
  reviewDate: string;
  verdict: string;
  positions: PositionVerdict[];
  watchNext: string[];
  model: string;
};

/**
 * La revisión guardada más reciente de una sesión.
 *
 * Devuelve la ÚLTIMA aunque no sea de hoy, y con su fecha delante: un panel
 * vacío porque el cron no ha corrido se lee como "no hay nada que decir",
 * que es distinto de "esto es de anteayer". La fecha viaja a la UI para que
 * lo diga.
 */
export async function getLatestReview(
  session: string,
): Promise<StoredReview | null> {
  const rows = unwrapRows<{
    reviewDate: string;
    verdict: string;
    positions: string;
    watchNext: string;
    model: string;
  }>(
    await db.execute(sql`
      SELECT review_date AS "reviewDate", verdict, positions,
             watch_next AS "watchNext", model
        FROM portfolio_reviews
       WHERE user_session = ${session}
       ORDER BY review_date DESC
       LIMIT 1
    `),
  );
  const r = rows[0];
  if (!r) return null;
  try {
    return {
      reviewDate: r.reviewDate,
      verdict: r.verdict,
      positions: JSON.parse(r.positions) as PositionVerdict[],
      watchNext: JSON.parse(r.watchNext) as string[],
      model: r.model,
    };
  } catch {
    // Un JSON corrupto no puede tumbar el panel: se comporta como si no
    // hubiera revisión y el botón de forzar una nueva sigue ahí.
    return null;
  }
}

/** Día natural UTC. La misma convención que `refId` de las ventanas
 *  rodantes del Lab — cambiarla aquí desalinearía las dos series. */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Redacta y guarda la revisión del día para cada sesión del dueño.
 *
 * IDEMPOTENTE POR EL ÍNDICE ÚNICO, no por un guard de tiempo: se comprueba
 * antes para no gastar, pero el `ON CONFLICT DO NOTHING` es lo que garantiza
 * una sola fila aunque dos ticks se solapen. Un guard de tiempo solo habría
 * hecho improbable la carrera, no imposible.
 *
 * Degrada en vez de reventar: si la extracción del libro de futuros falla,
 * la redacción sigue con lo estructural, igual que en la ruta.
 */
export async function runDailyReview(): Promise<{
  written: number;
  skipped: number;
  sessions: number;
}> {
  const sessions = [...claimableSessionIds()];
  const date = today();
  let written = 0;
  let skipped = 0;

  for (const session of sessions) {
    // Comprobar ANTES de trabajar: sin esto, cada tick de 10 minutos
    // pagaría dos llamadas al LLM para que el INSERT las tirara al final.
    const already = unwrapRows<{ n: number }>(
      await db.execute(sql`
        SELECT count(*)::int AS n FROM portfolio_reviews
         WHERE user_session = ${session} AND review_date = ${date}`),
    );
    if ((already[0]?.n ?? 0) > 0) {
      skipped++;
      continue;
    }

    const rows = await getWatchlist(session);
    const live = rows.filter((r) => r.shares !== null && r.shares > 0);
    // Sin posiciones no hay revisión, y NO se escribe una fila vacía: al
    // día siguiente volvería a saltarse el trabajo creyendo que ya corrió.
    if (!live.length) {
      skipped++;
      continue;
    }

    const positions = rows.map((r) => ({
      symbol: r.symbol,
      name: r.name,
      sector: r.sector,
      shares: r.shares,
      avgCost: r.avgCost,
    }));
    const quotes = await getQuotesMap([
      ...live.map((r) => r.symbol),
      ...MARKET_REF_SYMBOLS,
    ]).catch(() => ({}));
    const retrieval = await retrievePortfolio(positions, quotes, {
      harvest: true,
    });

    const ledger = await extractForwardLedger(
      retrieval.forward.candidates,
      citationNumberFor(retrieval),
    )
      .then((x) => x?.items ?? [])
      .catch(() => []);

    const conviction = await Promise.all([
      loadContrasts(session),
      earningsReads(live.map((r) => r.symbol)),
      // Los falsadores que él aprobó. Es una consulta, cero cuota, y es lo
      // único del prompt que autoriza a decir "la tesis está rota".
      getFalsifiers(session),
    ])
      .then(([contrasts, earnings, falsifiers]) => ({
        contrasts,
        earnings,
        falsifiers,
      }))
      .catch(() => undefined);

    // La revisión de AYER (o la última que haya) como ancla de la novedad.
    // Es la misma consulta que sirve el GET, así que cero coste extra.
    const previous = await getLatestReview(session).catch(() => null);
    const review = await reviewPortfolio(retrieval, ledger, conviction, previous);
    // Una revisión sin veredicto es un fallo del redactor, no un día
    // tranquilo. Guardarla dejaría el panel enseñando un hueco y el guard
    // de arriba impediría reintentarlo hasta mañana.
    if (!review.verdict.trim()) {
      skipped++;
      continue;
    }

    await db.execute(sql`
      INSERT INTO portfolio_reviews (
        user_session, review_date, verdict, positions, watch_next, model
      ) VALUES (
        ${session}, ${date}, ${review.verdict},
        ${JSON.stringify(review.positions)},
        ${JSON.stringify(review.watchNext)},
        ${review.model}
      )
      ON CONFLICT (user_session, review_date) DO NOTHING
    `);
    written++;
  }

  return { written, skipped, sessions: sessions.length };
}
