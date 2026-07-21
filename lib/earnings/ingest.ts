// Orquesta la lectura de comunicados de resultados. Node-only (cron y
// refresher); el Worker sólo LEE lo guardado.
//
// Ámbito: la WATCHLIST del dueño, como pide el design doc. No es una
// limitación técnica sino de foco — leer el comunicado de las ~10k empresas
// del universo gastaría LLM a espuertas para nombres que nadie mira.
//
// Coste real: un comunicado por empresa y TRIMESTRE, así que en régimen esto
// hace 0 llamadas casi siempre y 1 el día que la empresa presenta.

import { sql } from "drizzle-orm";
import { db, unwrapRows } from "@/lib/db";
import { findLatestEarningsFiling } from "@/lib/earnings/filings";
import {
  earningsReportExists,
  generateEarningsReport,
} from "@/lib/ai/earnings-report";
import { jobRanWithin, markJobRun } from "@/lib/cron/job-state";

export type EarningsIngestResult = {
  checked: number;
  generated: number;
  skipped: "disabled" | "recent" | null;
  durationMs: number;
};

/** Horas entre barridos. El dato cambia como mucho una vez al trimestre por
 *  empresa, así que barrer cada 6h ya es generoso. */
const SWEEP_HOURS = 6;
/** Tope de comunicados NUEVOS leídos por pasada: acota el gasto de LLM si
 *  media watchlist presenta el mismo día (temporada de resultados). El resto
 *  entra en la pasada siguiente. */
const MAX_NEW_PER_SWEEP = 3;
/** SEC pide no pasar de 10 req/s; vamos MUY por debajo. */
const GAP_MS = 200;

/** Horas de espera antes de reintentar un filing que falló (extracción vacía,
 *  JSON del LLM inválido). Sin esta memoria, un filing roto pagaba la cadena
 *  entera de fetches SEC + una llamada LLM en CADA barrido durante los 14
 *  días de su ventana. */
const FAIL_RETRY_HOURS = 24;

/** Símbolos de TODAS las watchlists (en local sólo hay una). */
async function watchlistSymbols(): Promise<string[]> {
  return unwrapRows<{ symbol: string }>(
    await db.execute(sql`
      SELECT DISTINCT symbol FROM watchlist ORDER BY symbol LIMIT 40
    `),
  ).map((r) => r.symbol.toUpperCase());
}

export async function runEarningsReportsIngest(
  opts: { force?: boolean; symbols?: string[] } = {},
): Promise<EarningsIngestResult> {
  const t0 = Date.now();
  const done = (r: Partial<EarningsIngestResult>): EarningsIngestResult => ({
    checked: 0,
    generated: 0,
    skipped: null,
    durationMs: Date.now() - t0,
    ...r,
  });

  if (process.env.EARNINGS_REPORTS_ENABLED === "0") {
    return done({ skipped: "disabled" });
  }
  // Guard por INTENTO (job_state). El anterior miraba MAX(created_at) de
  // earnings_reports, así que mientras no entraba ningún comunicado nuevo
  // (o sea, casi siempre) barría en cada tick de 10 min, no cada 6h.
  if (!opts.force && (await jobRanWithin("earnings-sweep", SWEEP_HOURS))) {
    return done({ skipped: "recent" });
  }
  await markJobRun("earnings-sweep");

  const symbols = opts.symbols?.length
    ? opts.symbols.map((s) => s.toUpperCase())
    : await watchlistSymbols();

  let checked = 0;
  let generated = 0;
  for (const symbol of symbols) {
    if (generated >= MAX_NEW_PER_SWEEP) {
      console.log(
        `[earnings] tope de ${MAX_NEW_PER_SWEEP} comunicados por pasada — el resto en la siguiente`,
      );
      break;
    }
    let failKey: string | null = null;
    try {
      const filing = await findLatestEarningsFiling(symbol);
      checked++;
      if (!filing) continue;
      if (await earningsReportExists(symbol, filing.accession, filing.filingDate))
        continue;
      failKey = `earnings-fail:${symbol}:${filing.accession}`;
      if (await jobRanWithin(failKey, FAIL_RETRY_HOURS)) continue;
      const content = await generateEarningsReport(filing);
      if (content) {
        generated++;
        console.log(
          `[earnings] ${symbol} ${filing.filingDate}: ${content.summary.length} bullets`,
        );
      } else {
        // Exhibit sin texto utilizable: probablemente permanente, pero se
        // reintenta cada FAIL_RETRY_HOURS por si fue transitorio.
        await markJobRun(failKey);
      }
    } catch (err) {
      // Una empresa que falle no puede tumbar el barrido de las demás.
      if (failKey) await markJobRun(failKey).catch(() => {});
      console.warn(
        `[earnings] ${symbol} falló:`,
        err instanceof Error ? err.message.slice(0, 140) : err,
      );
    }
    await new Promise((r) => setTimeout(r, GAP_MS));
  }
  return done({ checked, generated });
}
