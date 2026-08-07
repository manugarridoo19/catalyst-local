// Lecturas de las carteras 13F. Workers-safe (sólo SELECT).

import { sql } from "drizzle-orm";
import { db, unwrapRows } from "@/lib/db";

export type FundNewPosition = {
  symbol: string;
  issuerName: string;
  fundName: string;
  period: string;
  filingDate: string | null;
  value: number;
};

export type FundConviction = {
  symbol: string;
  issuerName: string;
  funds: number;
  totalValue: number;
  fundNames: string[];
};

/** Aperturas del último trimestre declarado por cada fondo. */
export async function getFundNewPositions(
  limit = 12,
): Promise<FundNewPosition[]> {
  return unwrapRows<{
    symbol: string;
    issuer_name: string;
    fund_name: string;
    period_of_report: string;
    filing_date: string | null;
    value: string | number;
  }>(
    await db.execute(sql`
      WITH ranked AS (
        SELECT fund_cik, period_of_report,
               ROW_NUMBER() OVER (
                 PARTITION BY fund_cik ORDER BY period_of_report DESC
               ) AS rn
        FROM fund_holdings GROUP BY fund_cik, period_of_report
      )
      SELECT h.symbol, h.issuer_name, h.fund_name, h.period_of_report,
             h.filing_date, h.value
      FROM fund_holdings h
      JOIN ranked r ON r.fund_cik = h.fund_cik
        AND r.period_of_report = h.period_of_report AND r.rn = 1
      WHERE h.symbol IS NOT NULL
        AND EXISTS (SELECT 1 FROM ranked r2
                    WHERE r2.fund_cik = h.fund_cik AND r2.rn = 2)
        AND NOT EXISTS (
          SELECT 1 FROM fund_holdings h2
          JOIN ranked r2 ON r2.fund_cik = h2.fund_cik
            AND r2.period_of_report = h2.period_of_report AND r2.rn = 2
          WHERE h2.fund_cik = h.fund_cik AND h2.symbol = h.symbol)
      ORDER BY h.value DESC
      LIMIT ${limit}
    `),
  ).map((r) => ({
    symbol: r.symbol,
    issuerName: r.issuer_name,
    fundName: r.fund_name,
    period: r.period_of_report,
    filingDate: r.filing_date,
    value: Number(r.value),
  }));
}

export type FundPositionChange = {
  symbol: string;
  issuerName: string;
  fundName: string;
  action: "added" | "trimmed" | "exited";
  /** Cambio en ACCIONES entre trimestres, en %. Null en salidas. */
  sharesPct: number | null;
  /** Valor de la posición: el del trimestre nuevo, o el último conocido en
   *  una salida. */
  value: number;
  period: string;
  prevPeriod: string;
};

/** Umbral de materialidad del cambio de acciones entre trimestres. Por
 *  debajo es rebalanceo (aportaciones/reembolsos del fondo), no decisión. */
const MIN_CHANGE_PCT = 25;

/**
 * Cambios trimestre a trimestre en los 13F curados: quién AMPLIÓ, quién
 * RECORTÓ y quién SALIÓ del todo. Las aperturas ya tienen su sección (y su
 * señal en el Lab); esto lee el resto del movimiento, que llevaba en la BD
 * desde la Fase 3 sin ninguna superficie — y una salida completa de un
 * fondo de convicción dice tanto como una entrada.
 *
 * La comparación va por ACCIONES, no por valor: el valor se mueve con el
 * precio aunque el gestor no haga nada. Sin `shares` en ambos trimestres
 * (columna best-effort) el cambio no se clasifica — mejor callar que
 * llamar "recorte" a un dato incompleto. Agregado por (fondo, símbolo)
 * porque un mismo símbolo puede aparecer en varios CUSIP (clases de
 * acciones) y compararlos sueltos inventaría cambios.
 *
 * ⚠️ Hereda la limitación conocida de las enmiendas (backlog Fase 3): un
 * 13F-HR/A que retire una posición deja la fila vieja como holding
 * fantasma; afecta igual a las demás vistas de esta página.
 *
 * ⚠️ EL DATO ES VIEJO POR NATURALEZA. Un 13F declara la foto del cierre de
 * trimestre y se presenta hasta 45 días después: en agosto, "el último
 * trimestre" es el que cerró el 31 de marzo. Por eso `period` viaja en cada
 * fila y todo consumidor tiene que enseñarlo — presentar esto como
 * movimiento reciente sería falso.
 *
 * `symbols` acota a una cartera (2026-08-07): los consumidores de decisión
 * necesitan los cambios de SUS valores, no el top del universo por valor.
 * Se añadió aquí en vez de escribir una consulta paralela porque dos
 * consultas del mismo hecho acaban discrepando — y ésta ya tiene dentro las
 * dos decisiones que cuestan: comparar por ACCIONES y agregar por
 * (fondo, símbolo).
 */
export async function getFundPositionChanges(
  limit = 14,
  symbols?: string[],
): Promise<FundPositionChange[]> {
  return unwrapRows<{
    symbol: string;
    issuer_name: string;
    fund_name: string;
    action: "added" | "trimmed" | "exited";
    shares_pct: number | null;
    value: string | number;
    period: string;
    prev_period: string;
  }>(
    await db.execute(sql`
      WITH periodos AS (
        -- Los DOS trimestres vigentes del UNIVERSO, no los de cada fondo.
        --
        -- El ranking era PARTITION BY fund_cik sin más, así que un fondo
        -- del que sólo tenemos datos viejos producía un "cambio" con la forma
        -- de uno fresco: medido el 2026-08-07, Scion Asset Management
        -- aparecía SALIENDO de META comparando 2025-06-30 contra 2025-09-30
        -- —hace un año— y no porque vendiera, sino porque nuestra ingesta no
        -- tiene sus trimestres siguientes. Una salida inventada por el
        -- ranking es peor que un hueco: se lee como la decisión de un gestor
        -- de convicción y ahora, además, alimenta posturas de cartera.
        SELECT DISTINCT period_of_report AS p
        FROM fund_holdings
        ORDER BY p DESC LIMIT 2
      ),
      ranked AS (
        SELECT fund_cik, period_of_report,
               ROW_NUMBER() OVER (
                 PARTITION BY fund_cik ORDER BY period_of_report DESC
               ) AS rn
        FROM fund_holdings
        WHERE period_of_report IN (SELECT p FROM periodos)
        GROUP BY fund_cik, period_of_report
      ),
      latest AS (
        SELECT h.fund_cik, MIN(h.fund_name) AS fund_name, h.symbol,
               MIN(h.issuer_name) AS issuer_name, MIN(h.period_of_report) AS period,
               SUM(h.shares) AS shares, SUM(h.value) AS value
        FROM fund_holdings h
        JOIN ranked r ON r.fund_cik = h.fund_cik
          AND r.period_of_report = h.period_of_report AND r.rn = 1
        WHERE h.symbol IS NOT NULL
        GROUP BY h.fund_cik, h.symbol
      ),
      prev AS (
        SELECT h.fund_cik, MIN(h.fund_name) AS fund_name, h.symbol,
               MIN(h.issuer_name) AS issuer_name, MIN(h.period_of_report) AS period,
               SUM(h.shares) AS shares, SUM(h.value) AS value
        FROM fund_holdings h
        JOIN ranked r ON r.fund_cik = h.fund_cik
          AND r.period_of_report = h.period_of_report AND r.rn = 2
        WHERE h.symbol IS NOT NULL
        GROUP BY h.fund_cik, h.symbol
      )
      SELECT * FROM (
        -- Ampliaciones y recortes: el símbolo está en los DOS trimestres y
        -- las acciones cambiaron de forma material.
        SELECT l.symbol, l.issuer_name, l.fund_name,
               CASE WHEN l.shares > p.shares THEN 'added' ELSE 'trimmed' END AS action,
               ROUND(((l.shares - p.shares)::numeric / p.shares) * 100, 1)::float
                 AS shares_pct,
               l.value, l.period, p.period AS prev_period
        FROM latest l
        JOIN prev p ON p.fund_cik = l.fund_cik AND p.symbol = l.symbol
        WHERE l.shares IS NOT NULL AND p.shares IS NOT NULL AND p.shares > 0
          AND ABS(((l.shares - p.shares)::numeric / p.shares) * 100)
            >= ${MIN_CHANGE_PCT}
        UNION ALL
        -- Salidas: estaba el trimestre pasado y no está en el nuevo.
        SELECT p.symbol, p.issuer_name, p.fund_name, 'exited' AS action,
               NULL::float AS shares_pct, p.value,
               (SELECT MIN(l2.period) FROM latest l2
                 WHERE l2.fund_cik = p.fund_cik) AS period,
               p.period AS prev_period
        FROM prev p
        WHERE NOT EXISTS (
          SELECT 1 FROM latest l WHERE l.fund_cik = p.fund_cik
            AND l.symbol = p.symbol
        )
      ) changes
      ${
        symbols?.length
          ? sql`WHERE symbol IN (${sql.join(
              symbols.map((s) => sql`${s.toUpperCase()}`),
              sql`, `,
            )})`
          : sql``
      }
      ORDER BY value DESC
      LIMIT ${limit}
    `),
  ).map((r) => ({
    symbol: r.symbol,
    issuerName: r.issuer_name,
    fundName: r.fund_name,
    action: r.action,
    sharesPct: r.shares_pct,
    value: Number(r.value),
    period: r.period,
    prevPeriod: r.prev_period,
  }));
}

/** Dónde COINCIDEN los fondos curados: el valor que más gestoras distintas
 *  tienen en cartera en el último trimestre de cada una. */
export async function getFundConviction(
  limit = 10,
): Promise<FundConviction[]> {
  return unwrapRows<{
    symbol: string;
    issuer_name: string;
    funds: number;
    total_value: string | number;
    fund_names: string[];
  }>(
    await db.execute(sql`
      WITH ranked AS (
        SELECT fund_cik, period_of_report,
               ROW_NUMBER() OVER (
                 PARTITION BY fund_cik ORDER BY period_of_report DESC
               ) AS rn
        FROM fund_holdings GROUP BY fund_cik, period_of_report
      ),
      latest AS (
        SELECT h.* FROM fund_holdings h
        JOIN ranked r ON r.fund_cik = h.fund_cik
          AND r.period_of_report = h.period_of_report AND r.rn = 1
        WHERE h.symbol IS NOT NULL
      )
      SELECT symbol, MIN(issuer_name) AS issuer_name,
             COUNT(DISTINCT fund_cik)::int AS funds,
             SUM(value) AS total_value,
             ARRAY_AGG(DISTINCT fund_name) AS fund_names
      FROM latest
      GROUP BY symbol
      HAVING COUNT(DISTINCT fund_cik) >= 2
      ORDER BY COUNT(DISTINCT fund_cik) DESC, SUM(value) DESC
      LIMIT ${limit}
    `),
  ).map((r) => ({
    symbol: r.symbol,
    issuerName: r.issuer_name,
    funds: r.funds,
    totalValue: Number(r.total_value),
    fundNames: r.fund_names,
  }));
}
