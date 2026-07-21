// Lecturas de los comunicados leídos. Workers-safe (sólo SELECT).

import { sql } from "drizzle-orm";
import { db, unwrapRows } from "@/lib/db";

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
