import { sql, getTableColumns } from "drizzle-orm";
import { db, unwrapRows } from "@/lib/db";
import { tickerMetrics } from "@/lib/db/schema";
import { getBasicFinancials } from "@/lib/providers/finnhub";
import { deriveMetrics } from "@/lib/metrics/derive";
import { jobRanWithin, markJobRun } from "@/lib/cron/job-state";

/**
 * `SET col = EXCLUDED.col` para TODAS las columnas menos la clave.
 *
 * Se deriva del esquema en vez de escribirse: una columna nueva que no
 * aparezca aquí no da error, simplemente deja de refrescarse — la fila
 * conserva para siempre el valor del día que se creó, que es peor que un
 * NULL porque parece un dato.
 */
function excludedSet(): Record<string, ReturnType<typeof sql>> {
  const set: Record<string, ReturnType<typeof sql>> = {};
  for (const [prop, col] of Object.entries(getTableColumns(tickerMetrics))) {
    if (col.name === "symbol") continue;
    set[prop] = sql.raw(`excluded.${col.name}`);
  }
  return set;
}

// Refresca `ticker_metrics` para los símbolos de la watchlist. Una llamada a
// Finnhub por símbolo, cero LLM.
//
// DÓNDE CORRE, y no es un detalle: **nunca en el Worker**. Finnhub devuelve
// 429 a los egress de Cloudflare (lo mismo que obligó a `getQuote` a caer a
// Yahoo), así que la ingesta vive en el cron de GH Actions y en el refresher
// local, y el Worker sólo LEE de Postgres. Es el mismo reparto que
// `ticker_fundamentals`.
//
// Cadencia: 20h por símbolo. Los ratios TTM se mueven con el precio a diario,
// pero el numerador contable sólo cambia una vez por trimestre — refrescar
// más a menudo gastaría llamadas para reescribir el mismo número. Con una
// watchlist de ~8 valores son ~8 llamadas/día sobre un cupo de 60/minuto.

const STALE_HOURS = 20;
const CONCURRENCY = 3;

export type MetricsRefreshResult = {
  symbols: number;
  refreshed: number;
  empty: number;
  failed: number;
};

export async function runRefreshMetricsCron(options?: {
  force?: boolean;
  /** Símbolos concretos en vez de la watchlist. Lo usa el fetch-on-miss del
   *  daemon local para un ticker visitado que no está en cartera. */
  symbols?: string[];
}): Promise<MetricsRefreshResult> {
  const all =
    options?.symbols?.map((s) => s.toUpperCase()) ??
    unwrapRows<{ symbol: string }>(
      await db.execute(sql`SELECT DISTINCT symbol FROM watchlist ORDER BY symbol`),
    ).map((r) => r.symbol);

  // La frescura se mide con `job_state` (marca de INTENTO) y no con
  // `ticker_metrics.fetched_at`, porque un símbolo sin cobertura en Finnhub
  // no llega a escribir fila: guardarse por la tabla propia lo volvería a
  // preguntar en cada tick. Es la lección de `earnings-cal:` literalmente.
  const stale: string[] = [];
  for (const symbol of all) {
    if (options?.force || !(await jobRanWithin(`metrics:${symbol}`, STALE_HOURS))) {
      stale.push(symbol);
    }
  }

  let refreshed = 0;
  let empty = 0;
  let failed = 0;
  let cursor = 0;

  async function worker() {
    while (cursor < stale.length) {
      const symbol = stale[cursor++];
      const raw = await getBasicFinancials(symbol);
      // null = el fetch falló (429/red). NO se marca el intento ni se toca la
      // fila: se conserva lo bueno y se reintenta en el tick siguiente.
      if (raw === null) {
        failed++;
        continue;
      }
      // A partir de aquí Finnhub RESPONDIÓ, así que el intento se marca pase
      // lo que pase — incluida la respuesta vacía de un símbolo sin cobertura.
      await markJobRun(`metrics:${symbol}`);

      const m = deriveMetrics(raw);
      // Un objeto entero a null no es un dato: es "Finnhub no cubre este
      // símbolo". Escribir la fila haría que la UI pintara un bloque de
      // guiones y que `/portfolio` ordenara por columnas vacías.
      if (m.forwardPe == null && m.peTtm == null && m.psTtm == null) {
        empty++;
        continue;
      }

      // ─── POR QUÉ ESTO NO ES UN `INSERT` A MANO ──────────────────────
      //
      // Lo era, con las 28 columnas escritas tres veces (lista, VALUES y el
      // SET del ON CONFLICT). El 2026-08-11 se añadieron `revenue_growth_5y`
      // y `fcf_cagr_5y` al esquema y al derivador, y NO LLEGARON A LA BD:
      // typecheck en verde, migración aplicada, el refresco informando
      // "7/7 refrescados · 0 fallidos" y las dos columnas a NULL. Ningún
      // error en ninguna capa — el escritor simplemente no las nombraba.
      //
      // Una lista de columnas a mano es un tercer sitio donde el esquema
      // tiene que repetirse, y el fallo por olvido es SILENCIOSO y aprueba
      // los guards. Con el constructor de Drizzle las columnas salen del
      // propio objeto de esquema, así que añadir una es un solo cambio.
      await db
        .insert(tickerMetrics)
        .values({
          symbol,
          ...m,
          // Las dos únicas que no van tal cual: la columna es `text` y el
          // campo es un objeto.
          history: JSON.stringify(m.history),
          discarded: JSON.stringify(m.discarded),
          fetchedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: tickerMetrics.symbol,
          // El SET se construye a partir de las columnas del esquema, no a
          // mano: es la mitad del ON CONFLICT donde el olvido no da error
          // sino un dato que deja de actualizarse.
          set: excludedSet(),
        });
      refreshed++;
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, stale.length) }, worker),
  );

  return { symbols: all.length, refreshed, empty, failed };
}
