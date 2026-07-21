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

async function sweptRecently(): Promise<boolean> {
  return (
    unwrapRows<{ recent: boolean | null }>(
      await db.execute(sql`
        SELECT (MAX(created_at) > now() - (${SWEEP_HOURS} || ' hours')::interval)
          AS recent
        FROM earnings_reports
      `),
    )[0]?.recent === true
  );
}

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
  // El guard mira la última LECTURA guardada, no un reloj aparte. Efecto
  // secundario querido: mientras no haya ningún comunicado nuevo la tabla no
  // crece y el barrido se repite cada 6h; en cuanto entra uno, el siguiente
  // barrido espera esas 6h.
  if (!opts.force && (await sweptRecently())) return done({ skipped: "recent" });

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
    try {
      const filing = await findLatestEarningsFiling(symbol);
      checked++;
      if (!filing) continue;
      if (await earningsReportExists(symbol, filing.accession)) continue;
      const content = await generateEarningsReport(filing);
      if (content) {
        generated++;
        console.log(
          `[earnings] ${symbol} ${filing.filingDate}: ${content.summary.length} bullets`,
        );
      }
    } catch (err) {
      // Una empresa que falle no puede tumbar el barrido de las demás.
      console.warn(
        `[earnings] ${symbol} falló:`,
        err instanceof Error ? err.message.slice(0, 140) : err,
      );
    }
    await new Promise((r) => setTimeout(r, GAP_MS));
  }
  return done({ checked, generated });
}
