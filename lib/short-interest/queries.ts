// Lecturas del short interest. Workers-safe (sólo SELECT sobre nuestra BD:
// la ticker page NO pega a FINRA por pageview, igual que los fundamentales
// no pegan a FMP).

import { sql } from "drizzle-orm";
import { db, unwrapRows } from "@/lib/db";

// (getShortInterest, la lectura de solo-la-última, se retiró el 2026-08-06:
// su único consumidor era la ticker page, que ahora pide la serie entera y
// deriva el snapshot de la última fila.)

/** Un punto de la serie quincenal. La tabla no purga a propósito — la
 *  gracia es la serie histórica — pero hasta ahora solo se leía la última
 *  liquidación y la tendencia se quedaba en la BD sin pintar. */
export type ShortInterestPoint = {
  settlementDate: string;
  currentShortQty: number;
  daysToCover: number | null;
  changePercent: number | null;
};

/** Serie quincenal ASC (la más vieja primero: es para pintar tendencia).
 *  FINRA publica 2 liquidaciones/mes → 13 puntos ≈ medio año. */
export async function getShortInterestSeries(
  symbol: string,
  limit = 13,
): Promise<ShortInterestPoint[]> {
  const rows = unwrapRows<{
    settlement_date: string;
    current_short_qty: string | number;
    days_to_cover: number | null;
    change_percent: number | null;
  }>(
    await db.execute(sql`
      SELECT settlement_date, current_short_qty, days_to_cover, change_percent
      FROM (
        SELECT settlement_date, current_short_qty, days_to_cover, change_percent
        FROM short_interest
        WHERE symbol = ${symbol.toUpperCase()}
        ORDER BY settlement_date DESC
        LIMIT ${limit}
      ) t
      ORDER BY settlement_date ASC
    `),
  );
  return rows.map((r) => ({
    settlementDate: r.settlement_date,
    currentShortQty:
      typeof r.current_short_qty === "number"
        ? r.current_short_qty
        : Number(r.current_short_qty),
    daysToCover: r.days_to_cover,
    changePercent: r.change_percent,
  }));
}
