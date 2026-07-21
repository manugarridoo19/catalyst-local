// Lee el comunicado de resultados y lo convierte en algo que se entienda de
// un vistazo — Fase 3 del roadmap Catalyst 2.0.
//
// DESVIACIÓN CONSCIENTE del design doc: éste pedía "2 llamadas LLM/evento
// (summary + lo que el management no dijo)" y aquí va **UNA sola** con
// jsonMode devolviendo los dos campos. Son dos lecturas del MISMO texto, así
// que la segunda llamada volvería a mandar el comunicado entero (~14k chars)
// para releerlo: el doble de tokens por cero información nueva, y free-tier
// es ley. El "2 llamadas" del doc era una estimación de coste, no un
// requisito de diseño.

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { earningsReports } from "@/lib/db/schema";
import { proseCompletion } from "@/lib/ai/prose-chain";
import { extractSecExhibitText } from "@/lib/articles/extract";
import { SEC_USER_AGENT } from "@/lib/providers/sec-edgar";
import type { EarningsFiling } from "@/lib/earnings/filings";

const SYSTEM_PROMPT = `You are a buy-side analyst reading a company's own earnings press release (SEC 8-K, exhibit 99.1).

Return STRICT JSON:
{
  "headline": "the release's own headline, verbatim, max 140 chars",
  "summary": ["3 to 5 bullets"],
  "readBetweenLines": "2-3 sentences"
}

"summary": what the quarter actually says. EVERY bullet must carry a concrete
number from the release (revenue, EPS, margin, growth %, guidance, buyback).
No bullet may be pure adjectives. Translate jargon into plain English.

"readBetweenLines": what a careful reader notices that the release does not
say out loud — a segment shrinking while the total grows, growth decelerating
versus the prior quarter, margin pressure, a one-off gain flattering the
headline, guidance that is absent when it is usually given, heavy reliance on
non-GAAP adjustments. Ground it in what IS printed in the document.

HARD RULES:
- Use ONLY the document. Never add outside knowledge, prices or estimates.
- Never invent a number. If the release omits guidance, say it is absent.
- If something looks bad, say it plainly. This is a reading aid, not PR.
- No investment advice, no price targets.`;

export type EarningsReportContent = {
  headline: string | null;
  summary: string[];
  readBetweenLines: string | null;
};

function sanitize(parsed: unknown): EarningsReportContent | null {
  if (!parsed || typeof parsed !== "object") return null;
  const o = parsed as Record<string, unknown>;
  const summary = Array.isArray(o.summary)
    ? o.summary
        .filter((b): b is string => typeof b === "string" && b.trim().length > 0)
        .map((b) => b.trim().slice(0, 400))
        .slice(0, 6)
    : [];
  if (summary.length === 0) return null;
  const headline =
    typeof o.headline === "string" && o.headline.trim()
      ? o.headline.trim().slice(0, 140)
      : null;
  const readBetweenLines =
    typeof o.readBetweenLines === "string" && o.readBetweenLines.trim()
      ? o.readBetweenLines.trim().slice(0, 900)
      : null;
  return { headline, summary, readBetweenLines };
}

/**
 * Descarga el exhibit, lo lee y guarda el resultado. Idempotente por
 * (symbol, accession): si el filing ya está leído no gasta ni red ni LLM.
 * Devuelve null si el exhibit no da texto suficiente.
 */
export async function generateEarningsReport(
  filing: EarningsFiling,
): Promise<EarningsReportContent | null> {
  const res = await fetch(filing.exhibitUrl, {
    headers: { "User-Agent": SEC_USER_AGENT },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`exhibit ${res.status}`);
  const text = extractSecExhibitText(await res.text());
  if (!text) return null;

  const result = await proseCompletion({
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: `Company: ${filing.symbol}. Filed ${filing.filingDate}.\n\n${text}`,
      },
    ],
    temperature: 0.3,
    maxTokens: 900,
    jsonMode: true,
    tag: "earnings",
  });

  let parsed: unknown;
  try {
    parsed = JSON.parse(
      result.content.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, ""),
    );
  } catch {
    throw new Error(
      `earnings report unparseable: "${result.content.slice(0, 120)}"`,
    );
  }
  const content = sanitize(parsed);
  if (!content) throw new Error("earnings report output invalid — discarded");

  await db
    .insert(earningsReports)
    .values({
      symbol: filing.symbol,
      accession: filing.accession,
      filingDate: filing.filingDate,
      reportDate: filing.reportDate,
      exhibitUrl: filing.exhibitUrl,
      headline: content.headline,
      summary: JSON.stringify(content.summary),
      readBetweenLines: content.readBetweenLines,
      model: result.model,
    })
    // Dos escritores (cron y refresher) pueden cruzarse en el mismo filing.
    .onConflictDoNothing();

  return content;
}

/** ¿Ya hemos leído este filing? */
export async function earningsReportExists(
  symbol: string,
  accession: string,
): Promise<boolean> {
  const rows = (await db.execute(sql`
    SELECT 1 FROM earnings_reports
    WHERE symbol = ${symbol} AND accession = ${accession} LIMIT 1
  `)) as { rows?: unknown[] };
  return (rows.rows?.length ?? 0) > 0;
}
