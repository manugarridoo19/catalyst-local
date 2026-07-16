import { sql } from "drizzle-orm";
import { db, unwrapRows } from "@/lib/db";
import { getEarningsCalendar } from "@/lib/providers/finnhub";

// Refresca la cache de próximos earnings (tabla earnings_events) para los
// símbolos en watchlist. Un símbolo se considera fresco 20h — con el
// refresher cada 10min y el cron GH, la cadencia real es ~1 fetch/símbolo/
// día (~4-8 llamadas Finnhub/día con una watchlist típica). Cero LLM.

const STALE_HOURS = 20;
const HORIZON_DAYS = 90;
const CONCURRENCY = 3;

export type EarningsRefreshResult = {
  symbols: number;
  refreshed: number;
  events: number;
};

export async function runRefreshEarningsCron(): Promise<EarningsRefreshResult> {
  // Símbolos de watchlist cuya cache falta o está rancia.
  const stale = unwrapRows<{ symbol: string }>(
    await db.execute(sql`
      SELECT DISTINCT w.symbol
      FROM watchlist w
      WHERE NOT EXISTS (
        SELECT 1 FROM earnings_events e
        WHERE e.symbol = w.symbol
          AND e.fetched_at >= now() - make_interval(hours => ${STALE_HOURS})
      )
      ORDER BY w.symbol
    `),
  );
  const totalRows = unwrapRows<{ c: number }>(
    await db.execute(sql`SELECT COUNT(DISTINCT symbol)::int AS c FROM watchlist`),
  );

  let refreshed = 0;
  let events = 0;
  let cursor = 0;
  async function worker() {
    while (cursor < stale.length) {
      const { symbol } = stale[cursor++];
      const cal = await getEarningsCalendar(symbol, HORIZON_DAYS);
      // null = el fetch falló (429/red). NO tocamos la cache: conservamos
      // las filas buenas y reintentamos el símbolo el próximo tick.
      if (cal === null) continue;
      // Reemplazo completo por símbolo: borra fechas pasadas/movidas y
      // marca frescura aunque el símbolo no tenga earnings en el horizonte
      // (fila sentinel no — usamos fetched_at de las filas; si no hay
      // filas, el símbolo se re-consulta cada tick, aceptable: la llamada
      // es barata y el caso "sin earnings en 90d" es raro en equities).
      await db.execute(sql`DELETE FROM earnings_events WHERE symbol = ${symbol}`);
      for (const e of cal) {
        await db.execute(sql`
          INSERT INTO earnings_events
            (symbol, date, hour, quarter, year, eps_estimate, revenue_estimate, fetched_at)
          VALUES (${symbol}, ${e.date}, ${e.hour}, ${e.quarter}, ${e.year},
            ${e.epsEstimate != null ? String(e.epsEstimate) : null},
            ${e.revenueEstimate != null ? String(e.revenueEstimate) : null},
            now())
          ON CONFLICT (symbol, date) DO UPDATE SET
            hour = EXCLUDED.hour, quarter = EXCLUDED.quarter,
            year = EXCLUDED.year, eps_estimate = EXCLUDED.eps_estimate,
            revenue_estimate = EXCLUDED.revenue_estimate, fetched_at = now()
        `);
        events++;
      }
      refreshed++;
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, stale.length) }, () => worker()),
  );

  return { symbols: totalRows[0]?.c ?? 0, refreshed, events };
}

export type UpcomingEarning = {
  symbol: string;
  date: string;
  hour: string | null;
  epsEstimate: string | null;
};

// Próximos earnings de la watchlist para la UI (lee SOLO de la cache).
export async function getUpcomingEarnings(
  limit = 10,
): Promise<UpcomingEarning[]> {
  return unwrapRows<UpcomingEarning>(
    await db.execute(sql`
      SELECT e.symbol, e.date, e.hour, e.eps_estimate AS "epsEstimate"
      FROM earnings_events e
      WHERE e.date >= to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD')
        AND EXISTS (SELECT 1 FROM watchlist w WHERE w.symbol = e.symbol)
      ORDER BY e.date ASC, e.symbol ASC
      LIMIT ${limit}
    `),
  );
}
