import { sql } from "drizzle-orm";
import { db, unwrapRows } from "@/lib/db";

// Lecturas del Signal Lab. SOLO lectura de BD → Workers-safe (la página /lab
// las renderiza en el Worker público, cero LLM y cero llamadas externas).

export type SignalStatRow = {
  kind: string;
  horizon: number;
  n: number;
  avg_return: number;
  median_return: number;
  hit_rate: number; // % de señales con retorno > 0
  avg_excess: number | null; // media de (retorno - SPY) en los mismos días
  beat_rate: number | null; // % de señales que baten a SPY
};

// Estadística por kind × horizonte. El excess vs SPY es la cifra que de
// verdad importa: un +2% a 30d en un mercado que subió 3% no es una señal,
// es beta.
export async function getSignalStats(): Promise<SignalStatRow[]> {
  return unwrapRows<SignalStatRow>(
    await db.execute(sql`
      SELECT e.kind, o.horizon::int AS horizon,
        COUNT(*)::int AS n,
        ROUND(AVG(o.return_pct)::numeric, 2)::float AS avg_return,
        ROUND(percentile_cont(0.5) WITHIN GROUP (ORDER BY o.return_pct)::numeric,
          2)::float AS median_return,
        ROUND((COUNT(*) FILTER (WHERE o.return_pct > 0)::numeric
          / COUNT(*) * 100), 1)::float AS hit_rate,
        ROUND(AVG(o.return_pct - o.benchmark_return_pct)::numeric, 2)::float
          AS avg_excess,
        ROUND((COUNT(*) FILTER (WHERE o.return_pct > o.benchmark_return_pct)::numeric
          / NULLIF(COUNT(*) FILTER (WHERE o.benchmark_return_pct IS NOT NULL), 0)
          * 100), 1)::float AS beat_rate
      FROM signal_events e
      JOIN signal_outcomes o ON o.event_id = e.id
      GROUP BY e.kind, o.horizon
      ORDER BY e.kind, o.horizon
    `),
  );
}

export type LabTotals = {
  events: number;
  outcomes: number;
  measured_events: number;
  pending_events: number;
  first_detected_at: string | Date | null;
  last_filled_at: string | Date | null;
};

export async function getLabTotals(): Promise<LabTotals> {
  const rows = unwrapRows<LabTotals>(
    await db.execute(sql`
      SELECT
        (SELECT COUNT(*)::int FROM signal_events) AS events,
        (SELECT COUNT(*)::int FROM signal_outcomes) AS outcomes,
        (SELECT COUNT(DISTINCT event_id)::int FROM signal_outcomes)
          AS measured_events,
        (SELECT COUNT(*)::int FROM signal_events e
          WHERE NOT EXISTS (SELECT 1 FROM signal_outcomes o
            WHERE o.event_id = e.id)) AS pending_events,
        (SELECT MIN(detected_at) FROM signal_events) AS first_detected_at,
        (SELECT MAX(filled_at) FROM signal_outcomes) AS last_filled_at
    `),
  );
  return (
    rows[0] ?? {
      events: 0,
      outcomes: 0,
      measured_events: 0,
      pending_events: 0,
      first_detected_at: null,
      last_filled_at: null,
    }
  );
}

export type RecentSignalRow = {
  id: number;
  kind: string;
  symbol: string;
  name: string | null;
  detected_at: string | Date;
  meta: string | null;
  r1: number | null;
  r7: number | null;
  r30: number | null;
  b7: number | null;
};

// Últimas señales YA medidas (al menos un horizonte relleno), con los
// retornos pivotados a columnas para pintarlas en una fila.
export async function getRecentSignals(
  limit = 14,
  kind?: string,
): Promise<RecentSignalRow[]> {
  const kindClause = kind ? sql`WHERE e.kind = ${kind}` : sql``;
  return unwrapRows<RecentSignalRow>(
    await db.execute(sql`
      SELECT e.id, e.kind, e.symbol, tk.name, e.detected_at, e.meta,
        MAX(o.return_pct) FILTER (WHERE o.horizon = 1)::float AS r1,
        MAX(o.return_pct) FILTER (WHERE o.horizon = 7)::float AS r7,
        MAX(o.return_pct) FILTER (WHERE o.horizon = 30)::float AS r30,
        MAX(o.benchmark_return_pct) FILTER (WHERE o.horizon = 7)::float AS b7
      FROM signal_events e
      JOIN signal_outcomes o ON o.event_id = e.id
      LEFT JOIN tickers tk ON tk.symbol = e.symbol
      ${kindClause}
      GROUP BY e.id, tk.name
      ORDER BY e.detected_at DESC
      LIMIT ${limit}
    `),
  );
}
