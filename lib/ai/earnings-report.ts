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
import { parseAttributions, type Attribution } from "@/lib/coach/frames";

const SYSTEM_PROMPT = `You are a buy-side analyst reading a company's own earnings press release (SEC 8-K, exhibit 99.1).

Return STRICT JSON:
{
  "headline": "the release's own headline, verbatim, max 140 chars",
  "summary": ["3 to 5 bullets"],
  "readBetweenLines": "2-3 sentences",
  "revenueActual": 1220000000,
  "revenueBasis": "GAAP",
  "epsActual": 0.12,
  "epsBasis": "GAAP",
  "attribution": [
    {"signal": "margen_comprimido", "layer": "inversion",
     "magnitude": "operating margin 38% vs 44% a year ago (-6pp)",
     "quote": "the decline was driven primarily by increased infrastructure investment"}
  ]
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

"attribution": the release's own explanation of WHAT MOVED and WHY. This is
the most important field and the one nobody extracts. A margin falling
because the company is buying infrastructure and a margin falling because the
business is losing steam are the SAME number and the OPPOSITE news. The
release usually says which ("driven by", "primarily reflects", "due to").

  "signal" — exactly one of: margen_comprimido, capex_disparado,
  nucleo_desacelera, guidance_recortada, hito_incumplido, cuota_perdida,
  insider_vendiendo, deuda_creciendo, nucleo_acelera, margen_expandido,
  guidance_elevada. Skip anything that fits none of these.

  The last three are POSITIVE signals and they matter as much as the
  negative ones: a reader tracking whether their thesis is EXECUTING needs
  "cloud revenue accelerated to 26% growth" extracted with the same rigor as
  a margin squeeze. A strong quarter should produce positive entries — an
  empty array claims a QUIET quarter, and reporting only the cracks of an
  exceptional quarter misrepresents the document.

  "nucleo_desacelera" / "nucleo_acelera" refer to the PRIMARY business — the
  main revenue engine, the segment the company leads its own release with. A
  SECONDARY segment declining while the primary engine grows is NOT
  nucleo_desacelera (note it in readBetweenLines instead); the same in
  reverse for nucleo_acelera. If the release reports several segments, ask
  which one the thesis of owning this company rides on — that is the núcleo.

  "layer" — where the movement belongs, exactly one of:
    "nucleo"        the established business: its revenue, its growth, its
                    own margins. Deterioration here is about the business.
    "inversion"     deliberate spending on something being built: capex,
                    R&D, a new segment's losses, hiring for it.
    "no_recurrente" one-offs: legal accruals and settlements, restructuring
                    charges, impairments, FX.

  "magnitude" — what moved, with the release's own figures.
  "quote" — the sentence where the company attributes it, VERBATIM. Use null
  when the release states the movement but never explains it; do NOT invent
  an attribution to fill the field. A null here is a real and useful answer.

THE SIGNAL NAMES SOUND NEGATIVE. THEY ARE NOT ACCUSATIONS. "capex_disparado"
means "the company is spending heavily on building something" — nothing more.
Companies present exactly this as their headline strength ("Cloud and AI
Strength Fuels Results", "record investment in infrastructure"), and a
triumphant release is the MOST likely place to find it. Report it there. A
release that boasts about heavy investment and one that apologises for it get
the same entry; the reader decides what it means, not you.

Look in the financial statements too, not only the prose. Rising "additions to
property and equipment" in the cash flow statement is a capex movement even if
no sentence discusses it — in that case "quote" is null and "magnitude" carries
the two figures being compared.

Report only movements the document actually states, worse OR better. Two to
five entries is normal; an empty array is correct ONLY for a genuinely quiet
quarter — a release with record figures and raised guidance is not one.

DO NOT judge severity, and do not say whether any of this is good or bad for
an investor. Whether a margin squeeze is expected or alarming depends on what
kind of company the reader believes they own, and that is decided elsewhere.
Your job is to report what moved and what the company says caused it.

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
  /** Qué se movió y a qué lo atribuye la EMPRESA. El extractor no juzga si
   *  es bueno o malo: eso depende del marco de quien lo lee y se decide en
   *  `lib/coach/frames.ts`. Ver el prompt. */
  attribution: Attribution[];
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
    // Un array vacío es una respuesta legítima (trimestre tranquilo), así
    // que la atribución NO puede invalidar el comunicado entero como sí
    // hace un `summary` vacío.
    attribution: parseAttributions(o.attribution),
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
  // 24.000 y no el 14.000 por defecto del extractor. MEDIDO 2026-07-30: con
  // 14k, el comunicado de MSFT perdía el 39% del documento y con él la línea
  // "Additions to property and equipment" (char 18.606) — que en un
  // comunicado que no habla de capex en prosa es el ÚNICO sitio donde consta
  // la inversión. Sin ella, `attribution` no puede ver la capa `inversion`,
  // que es justo la que distingue "gasta porque construye" de "gasta porque
  // se deteriora". El corte no daba error: devolvía un array vacío, que se
  // lee igual que un trimestre tranquilo.
  //
  // Coste: ~2.500 tokens más de entrada por filing, una vez por trimestre y
  // empresa. El default de 14k se queda para cualquier otro llamante.
  const text = extractSecExhibitText(await res.text(), 24_000);
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
    // "batch unparseable"). El cap es un tope, no un gasto — subido a 1800
    // al añadir `attribution` (2-4 objetos con cita literal) y a 2600 el
    // 2026-07-31 al ampliar el vocabulario con señales positivas: hasta 5
    // entradas con cita, y el truncado se manifestó como "unparseable" en
    // la primera regeneración de MSFT.
    maxTokens: 2600,
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
    attribution: JSON.stringify(content.attribution),
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
