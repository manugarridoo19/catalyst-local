// Lecturas del short interest. Workers-safe (sólo SELECT sobre nuestra BD:
// la ticker page NO pega a FINRA por pageview, igual que los fundamentales
// no pegan a FMP).

import { sql } from "drizzle-orm";
import { db, unwrapRows } from "@/lib/db";

export type ShortInterestSnapshot = {
  symbol: string;
  settlementDate: string;
  currentShortQty: number;
  previousShortQty: number | null;
  avgDailyVolume: number | null;
  daysToCover: number | null;
  changePercent: number | null;
};

/** Última quincena publicada para un símbolo, o null si no la seguimos. */
export async function getShortInterest(
  symbol: string,
): Promise<ShortInterestSnapshot | null> {
  const rows = unwrapRows<{
    symbol: string;
    settlement_date: string;
    current_short_qty: string | number;
    previous_short_qty: string | number | null;
    avg_daily_volume: string | number | null;
    days_to_cover: number | null;
    change_percent: number | null;
  }>(
    await db.execute(sql`
      SELECT symbol, settlement_date, current_short_qty, previous_short_qty,
             avg_daily_volume, days_to_cover, change_percent
      FROM short_interest
      WHERE symbol = ${symbol.toUpperCase()}
      ORDER BY settlement_date DESC
      LIMIT 1
    `),
  );
  const r = rows[0];
  if (!r) return null;
  // bigint llega como STRING por el driver: normalizar o los formatos de la
  // UI harían concatenación de texto en vez de aritmética.
  const n = (v: string | number | null): number | null =>
    v === null ? null : typeof v === "number" ? v : Number(v);
  return {
    symbol: r.symbol,
    settlementDate: r.settlement_date,
    currentShortQty: n(r.current_short_qty) ?? 0,
    previousShortQty: n(r.previous_short_qty),
    avgDailyVolume: n(r.avg_daily_volume),
    daysToCover: r.days_to_cover,
    changePercent: r.change_percent,
  };
}
