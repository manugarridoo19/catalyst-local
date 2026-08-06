// Lecturas de los comunicados leídos. Workers-safe (sólo SELECT).

import { sql } from "drizzle-orm";
import { db, unwrapRows } from "@/lib/db";
import { surprisePct } from "@/lib/ask/retrieve";

/**
 * Consenso más cercano (±5 días) en `earnings_events` a la fecha de un
 * comunicado. Lo llama el generador AL INGERIR para snapshotearlo en
 * `earnings_reports`: el refresh del calendario borra las fechas pasadas
 * (~20h por símbolo), así que este dato deja de existir a los pocos días y
 * cualquier join en vivo posterior devuelve nada.
 */
export type ConsensusSnapshot = {
  revenue: number | null;
  eps: number | null;
};

export async function consensusNear(
  symbol: string,
  date: string,
): Promise<ConsensusSnapshot> {
  const r = unwrapRows<{ eps: number | null; revenue: number | null }>(
    await db.execute(sql`
      SELECT NULLIF(regexp_replace(COALESCE(eps_estimate,''),'[^0-9.\\-]','','g'),'')::float8 AS eps,
             NULLIF(regexp_replace(COALESCE(revenue_estimate,''),'[^0-9.\\-]','','g'),'')::float8 AS revenue
      FROM earnings_events
      WHERE symbol = ${symbol}
        AND ABS(date::date - ${date}::date) <= 5
      ORDER BY ABS(date::date - ${date}::date) ASC
      LIMIT 1
    `),
  )[0];
  return { revenue: r?.revenue ?? null, eps: r?.eps ?? null };
}

/** Un trimestre del historial de sorpresas: real contra consenso archivado,
 *  con el % calculado por `surprisePct` (nunca por un modelo) y null en los
 *  tres casos en que comparar sería mentir. */
export type SurpriseHistoryRow = {
  filingDate: string;
  reportDate: string | null;
  exhibitUrl: string;
  revenueActual: number | null;
  revenueEstimate: number | null;
  revenueBasis: string | null;
  revenuePct: number | null;
  epsActual: number | null;
  epsEstimate: number | null;
  epsBasis: string | null;
  epsPct: number | null;
};

/**
 * La serie de sorpresas de un símbolo, un trimestre por fila. Crece sola:
 * `earnings_reports` no purga y el barrido lee cada 8-K una vez. La pregunta
 * que responde —¿esta empresa bate sistemáticamente o no?— no la responde
 * ningún trimestre suelto.
 */
export async function getSurpriseHistory(
  symbol: string,
  limit = 12,
): Promise<SurpriseHistoryRow[]> {
  const rows = unwrapRows<{
    filing_date: string;
    report_date: string | null;
    exhibit_url: string;
    revenue_actual: number | null;
    revenue_estimate: number | null;
    revenue_basis: string | null;
    eps_actual: number | null;
    eps_estimate: number | null;
    eps_basis: string | null;
  }>(
    await db.execute(sql`
      SELECT filing_date, report_date, exhibit_url,
             revenue_actual, revenue_estimate, revenue_basis,
             eps_actual, eps_estimate, eps_basis
      FROM earnings_reports
      WHERE symbol = ${symbol.toUpperCase()}
      ORDER BY filing_date DESC, id DESC
      LIMIT ${limit}
    `),
  );
  return rows.map((r) => ({
    filingDate: r.filing_date,
    reportDate: r.report_date,
    exhibitUrl: r.exhibit_url,
    revenueActual: r.revenue_actual,
    revenueEstimate: r.revenue_estimate,
    revenueBasis: r.revenue_basis,
    revenuePct: surprisePct(r.revenue_actual, r.revenue_estimate, r.revenue_basis),
    epsActual: r.eps_actual,
    epsEstimate: r.eps_estimate,
    epsBasis: r.eps_basis,
    epsPct: surprisePct(r.eps_actual, r.eps_estimate, r.eps_basis),
  }));
}

export type EarningsReport = {
  symbol: string;
  filingDate: string;
  exhibitUrl: string;
  headline: string | null;
  summary: string[];
  readBetweenLines: string | null;
  model: string;
};

/** Último comunicado leído de un símbolo, o null. */
export async function getLatestEarningsReport(
  symbol: string,
): Promise<EarningsReport | null> {
  const r = unwrapRows<{
    symbol: string;
    filing_date: string;
    exhibit_url: string;
    headline: string | null;
    summary: string;
    read_between_lines: string | null;
    model: string;
  }>(
    await db.execute(sql`
      SELECT symbol, filing_date, exhibit_url, headline, summary,
             read_between_lines, model
      FROM earnings_reports
      WHERE symbol = ${symbol.toUpperCase()}
      ORDER BY filing_date DESC, id DESC
      LIMIT 1
    `),
  )[0];
  if (!r) return null;
  let summary: string[] = [];
  try {
    const parsed = JSON.parse(r.summary);
    if (Array.isArray(parsed)) summary = parsed.filter((b) => typeof b === "string");
  } catch {
    return null;
  }
  if (summary.length === 0) return null;
  return {
    symbol: r.symbol,
    filingDate: r.filing_date,
    exhibitUrl: r.exhibit_url,
    headline: r.headline,
    summary,
    readBetweenLines: r.read_between_lines,
    model: r.model,
  };
}
