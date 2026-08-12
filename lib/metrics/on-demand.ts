import {
  getMetrics,
  getDilution,
  type StoredMetrics,
  type StoredDilution,
} from "@/lib/metrics/queries";
import { runRefreshMetricsCron } from "@/lib/cron/refresh-metrics";
import { runRefreshDilutionCron } from "@/lib/cron/refresh-dilution";

// Fetch-on-miss para tickers FUERA de la watchlist. Los crons solo ingieren
// la cartera, así que /ticker/NVDA enseñaba el panel de fundamentales
// directamente VACÍO — sin fila no se pinta el bloque, y no había manera de
// que la fila llegara a existir.
//
// SOLO en el daemon local (`LOCAL_MODE=1`): Finnhub 429ea a los egress de
// Cloudflare, y el Worker no debe hacer red por pageview — ahí se degrada a
// leer lo que haya, que es el comportamiento de siempre. Es el mismo reparto
// que `getOrFetchFundamentals` (FMP): fetch-on-miss con caché, nunca una
// llamada por vista.
//
// El coste está acotado por el guard de `job_state` que ya llevan los crons
// (20h metrics / 7d dilución, marcado también cuando el símbolo no tiene
// cobertura): el primer vistazo a un ticker nuevo paga 1 llamada a Finnhub
// (y ~2-6 a la SEC), y las visitas siguientes leen de Postgres aunque el
// símbolo no exista.

function localMode(): boolean {
  return process.env.LOCAL_MODE === "1";
}

export async function getMetricsOnDemand(
  symbol: string,
): Promise<StoredMetrics | null> {
  const stored = await getMetrics(symbol);
  if (stored || !localMode()) return stored;
  await runRefreshMetricsCron({ symbols: [symbol] }).catch(() => null);
  return getMetrics(symbol);
}

export async function getDilutionOnDemand(
  symbol: string,
): Promise<StoredDilution | null> {
  const stored = await getDilution(symbol);
  if (stored || !localMode()) return stored;
  await runRefreshDilutionCron({ symbols: [symbol] }).catch(() => null);
  return getDilution(symbol);
}
