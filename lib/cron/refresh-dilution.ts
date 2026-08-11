import { sql, getTableColumns } from "drizzle-orm";
import { db, unwrapRows } from "@/lib/db";
import { tickerDilution } from "@/lib/db/schema";
import { fetchDilutionFacts } from "@/lib/providers/sec-xbrl";
import { deriveDilution } from "@/lib/metrics/dilution";
import { jobRanWithin, markJobRun } from "@/lib/cron/job-state";

// Refresca `ticker_dilution` para los símbolos de la watchlist desde el XBRL
// de la SEC. Sin clave, sin cuota, cero LLM.
//
// CADENCIA 7 DÍAS, no 20 horas como `ticker_metrics`. Aquélla mezcla precio
// (que se mueve a diario) con contabilidad; aquí NO hay precio: el conteo de
// acciones sólo cambia cuando la empresa presenta. Refrescar a diario sería
// gastar peticiones para reescribir el mismo número 90 veces por trimestre.
//
// DÓNDE CORRE: Node (cron de GH Actions + refresher local). No es que la SEC
// bloquee a Cloudflare — es que el Worker no debe hacer red por pageview, y
// la lectura le sale de Postgres igual que las demás.
//
// FRENO: hasta 3 peticiones por símbolo (6 si hay que caer a IFRS) con un
// hueco de 150 ms. Con una watchlist de ~8 son ~25 peticiones cada 7 días,
// muy por debajo del límite de 10/s de la SEC.

const STALE_HOURS = 7 * 24;
const GAP_MS = 150;

export type DilutionRefreshResult = {
  symbols: number;
  refreshed: number;
  empty: number;
};

/** `SET col = EXCLUDED.col` derivado del esquema. Misma razón que en
 *  `refresh-metrics`: una columna nueva que no aparezca aquí no da error,
 *  deja de refrescarse y conserva para siempre el valor del día que se creó
 *  — un dato congelado con pinta de dato bueno. */
function excludedSet(): Record<string, ReturnType<typeof sql>> {
  const set: Record<string, ReturnType<typeof sql>> = {};
  for (const [prop, col] of Object.entries(getTableColumns(tickerDilution))) {
    if (col.name === "symbol") continue;
    set[prop] = sql.raw(`excluded.${col.name}`);
  }
  return set;
}

export async function runRefreshDilutionCron(options?: {
  force?: boolean;
  symbols?: string[];
}): Promise<DilutionRefreshResult> {
  const all =
    options?.symbols ??
    unwrapRows<{ symbol: string }>(
      await db.execute(sql`SELECT DISTINCT symbol FROM watchlist ORDER BY symbol`),
    ).map((r) => r.symbol);

  // Guard por INTENTO en `job_state`, no por `fetched_at` de la propia tabla:
  // un símbolo sin cobertura en XBRL no llega a escribir fila, y guardarse
  // por la tabla propia lo volvería a preguntar en cada tick. Es la misma
  // lección que `earnings-cal:` y `metrics:`.
  const stale: string[] = [];
  for (const symbol of all) {
    if (options?.force || !(await jobRanWithin(`dilution:${symbol}`, STALE_HOURS))) {
      stale.push(symbol);
    }
  }

  let refreshed = 0;
  let empty = 0;

  for (const symbol of stale) {
    await markJobRun(`dilution:${symbol}`);
    const facts = await fetchDilutionFacts(symbol);
    await new Promise((r) => setTimeout(r, GAP_MS));
    if (!facts) {
      empty++;
      continue;
    }
    const d = deriveDilution(facts);
    // Sin conteo de acciones no hay bloque que enseñar: un SBC suelto sin
    // saber sobre cuántas acciones reparte no dice nada útil.
    if (d.dilutedShares === null) {
      empty++;
      continue;
    }
    await db
      .insert(tickerDilution)
      .values({ symbol, ...d, fetchedAt: new Date() })
      .onConflictDoUpdate({
        target: tickerDilution.symbol,
        set: excludedSet(),
      });
    refreshed++;
  }

  return { symbols: all.length, refreshed, empty };
}
