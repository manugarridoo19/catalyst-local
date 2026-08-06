import { sql } from "drizzle-orm";
import { db, unwrapRows } from "@/lib/db";

// Nombres NUEVOS en el universo. `tickers.first_seen_at` existía desde el
// principio y no lo leía nadie: el universo es dinámico (un símbolo entra
// cuando un proveedor lo menciona) y ese momento de entrada es
// descubrimiento gratis — "¿qué nombres acaban de empezar a sonar?".
//
// FILTRADO A impacto≥3, y no por estética: medido 2026-08-06, el universo
// crece ~134 símbolos/semana y la mayoría son menciones de relleno; con
// noticia puntuada de impacto quedan ~37. Sin el filtro esto sería una
// lista de chicharros, no una sección de descubrimiento.

export type NewUniverseName = {
  symbol: string;
  name: string | null;
  firstSeen: string;
  /** El titular de MÁS impacto que lo trajo al archivo. */
  headline: string;
  impact: number;
};

export async function getNewUniverseNames(
  days = 7,
  limit = 10,
): Promise<NewUniverseName[]> {
  return unwrapRows<{
    symbol: string;
    name: string | null;
    first_seen: string;
    headline: string;
    impact: number;
  }>(
    await db.execute(sql`
      SELECT t.symbol, t.name,
        to_char(t.first_seen_at at time zone 'UTC','YYYY-MM-DD') AS first_seen,
        h.headline, h.impact
      FROM tickers t
      JOIN LATERAL (
        SELECT n.headline, s.impact
        FROM news_tickers nt
        JOIN news n ON n.id = nt.news_id
        JOIN news_scores s ON s.news_id = n.id
        WHERE nt.ticker = t.symbol AND s.impact >= 3
        ORDER BY s.impact DESC, n.published_at ASC
        LIMIT 1
      ) h ON true
      WHERE t.first_seen_at >= now() - (${days} || ' days')::interval
      ORDER BY h.impact DESC, t.first_seen_at DESC
      LIMIT ${limit}
    `),
  ).map((r) => ({
    symbol: r.symbol,
    name: r.name,
    firstSeen: r.first_seen,
    headline: r.headline,
    impact: r.impact,
  }));
}
