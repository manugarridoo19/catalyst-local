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
import { db, unwrapRows } from "@/lib/db";
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
  "readBetweenLines": "2-3 sentences",
  "revenueActual": 1220000000,
  "revenueBasis": "GAAP",
  "epsActual": 0.12,
  "epsBasis": "GAAP"
}

"revenueActual" / "epsActual": the headline top-line and bottom-line figures for
THIS quarter, as ABSOLUTE NUMBERS — write 1220000000, never 1.22, "1.22B" or
"$1.22 billion". Releases print "$1.2 billion" or "in thousands" tables; convert
to units. Quarterly figures only, never full-year or cumulative.

"revenueBasis" / "epsBasis": exactly one of "GAAP", "adjusted" or "other",
saying which measure the number you reported IS. Companies print several
(GAAP net revenue, adjusted net revenue, diluted EPS, adjusted EPS) and they
differ. If a release gives both, prefer GAAP and say so.

Use null for any of these four when the release does not state it plainly, and
null for a basis you cannot determine. Never guess a basis to fill the field:
a number whose basis is wrong is worse than no number.

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

export type EarningsBasis = "GAAP" | "adjusted" | "other";

export type EarningsReportContent = {
  headline: string | null;
  summary: string[];
  readBetweenLines: string | null;
  revenueActual: number | null;
  revenueBasis: EarningsBasis | null;
  epsActual: number | null;
  epsBasis: EarningsBasis | null;
};

const BASES: EarningsBasis[] = ["GAAP", "adjusted", "other"];

function basis(v: unknown): EarningsBasis | null {
  if (typeof v !== "string") return null;
  const hit = BASES.find((b) => b.toLowerCase() === v.trim().toLowerCase());
  return hit ?? null;
}

/**
 * Una cifra del comunicado sólo se acepta si es un número finito y REAL.
 *
 * El modelo puede devolver `"1.22B"`, `1.22` (olvidando la escala) o el
 * acumulado del año. Aquí sólo se ataja lo que es comprobable sin contexto:
 * que sea numérico y finito. El error de ESCALA no se puede ver desde aquí
 * —1,22 es un número perfectamente válido para un EPS— así que se caza más
 * abajo, comparando órdenes de magnitud contra el consenso (ver
 * `surprisePct` en lib/ask/retrieve.ts). Dos redes, no una.
 */
function figure(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v.replace(/[^0-9.\-]/g, "")) : NaN;
  return Number.isFinite(n) && n !== 0 ? n : null;
}

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
  // Una cifra sin base declarada se DESCARTA junto con su base: sin saber si
  // es GAAP o ajustada no se puede comparar contra el consenso sin arriesgar
  // un porcentaje falso con pinta de exacto.
  const revenueBasis = basis(o.revenueBasis);
  const epsBasis = basis(o.epsBasis);
  const revenueActual = revenueBasis ? figure(o.revenueActual) : null;
  const epsActual = epsBasis ? figure(o.epsActual) : null;

  return {
    headline,
    summary,
    readBetweenLines,
    revenueActual,
    revenueBasis: revenueActual === null ? null : revenueBasis,
    epsActual,
    epsBasis: epsActual === null ? null : epsBasis,
  };
}

/**
 * Descarga el exhibit, lo lee y guarda el resultado. Idempotente por
 * (symbol, accession): si el filing ya está leído no gasta ni red ni LLM.
 * Devuelve null si el exhibit no da texto suficiente.
 */
export async function generateEarningsReport(
  filing: EarningsFiling,
  /** `overwrite` reescribe un comunicado ya leído en vez de no hacer nada.
   *  Sólo para rellenar campos nuevos sobre filings antiguos (los actuals y
   *  su base llegaron en la migración 0023): el camino normal del barrido
   *  NUNCA debe pasarlo, o cada tick volvería a pagar la llamada LLM del
   *  mismo comunicado — que es justo lo que evita el índice único. */
  opts?: { overwrite?: boolean },
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
    // 900 con cuatro campos más se acercaba al techo, y un JSON truncado no
    // degrada: se pierde el comunicado entero (el repo ya se comió esto con
    // "batch unparseable"). El cap es un tope, no un gasto.
    maxTokens: 1100,
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

  const row = {
    symbol: filing.symbol,
    accession: filing.accession,
    filingDate: filing.filingDate,
    reportDate: filing.reportDate,
    exhibitUrl: filing.exhibitUrl,
    headline: content.headline,
    summary: JSON.stringify(content.summary),
    readBetweenLines: content.readBetweenLines,
    revenueActual: content.revenueActual,
    revenueBasis: content.revenueBasis,
    epsActual: content.epsActual,
    epsBasis: content.epsBasis,
    model: result.model,
  };
  const insert = db.insert(earningsReports).values(row);
  await (opts?.overwrite
    ? insert.onConflictDoUpdate({
        target: [earningsReports.symbol, earningsReports.accession],
        set: row,
      })
    : // Dos escritores (cron y refresher) pueden cruzarse en el mismo filing.
      insert.onConflictDoNothing());

  return content;
}

/**
 * ¿Ya hemos leído este filing — o uno del MISMO trimestre? El dedupe por
 * accession solo no basta: una empresa puede registrar un segundo 8-K con
 * ítem 2.02 en el mismo trimestre (materiales de investor day, comunicado
 * preliminar) y, sin la ventana, ese segundo filing pagaría otra llamada LLM
 * y PISARÍA el resumen bueno (getLatestEarningsReport coge el más reciente).
 * 60 días < al ciclo trimestral de ~90, así que nunca bloquea el trimestre
 * siguiente. Consciente: también excluye correcciones vía 8-K/A (raras); si
 * algún día se soportan, tienen que saltarse ESTA ventana a propósito.
 */
export async function earningsReportExists(
  symbol: string,
  accession: string,
  filingDate?: string,
): Promise<boolean> {
  const rows = unwrapRows(
    await db.execute(sql`
      SELECT 1 FROM earnings_reports
      WHERE symbol = ${symbol}
        AND (accession = ${accession}
             OR (${filingDate ?? null}::date IS NOT NULL
                 AND filing_date::date >= ${filingDate ?? null}::date - interval '60 days'))
      LIMIT 1
    `),
  );
  return rows.length > 0;
}
