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
