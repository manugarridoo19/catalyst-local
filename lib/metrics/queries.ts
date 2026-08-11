import { sql } from "drizzle-orm";
import { db, unwrapRows } from "@/lib/db";
import type {
  DiscardNote,
  TickerMetrics,
  ValuationHistory,
} from "@/lib/metrics/derive";

// Lectura de `ticker_metrics`. Workers-safe: sólo SELECT, ninguna llamada a
// proveedor. La escritura vive en `lib/cron/refresh-metrics.ts` porque
// Finnhub 429ea a los egress de Cloudflare — desde el Worker sólo se lee lo
// que el cron dejó.

type Row = {
  symbol: string;
  forward_pe: number | null;
  pe_ttm: number | null;
  peg_ttm: number | null;
  forward_peg: number | null;
  ev_ebitda_ttm: number | null;
  ps_ttm: number | null;
  pb: number | null;
  p_tbv: number | null;
  ev_fcf: number | null;
  roe_ttm: number | null;
  roic_ttm: number | null;
  gross_margin_ttm: number | null;
  operating_margin_ttm: number | null;
  net_margin_ttm: number | null;
  fcf_margin: number | null;
  revenue_growth_ttm_yoy: number | null;
  revenue_growth_3y: number | null;
  eps_growth_ttm_yoy: number | null;
  eps_growth_3y: number | null;
  total_debt_to_equity: number | null;
  current_ratio: number | null;
  dividend_yield_ttm: number | null;
  payout_ratio_ttm: number | null;
  history: string | null;
  discarded: string | null;
  as_of: string | null;
  age_hours: number | null;
};

export type StoredMetrics = TickerMetrics & {
  symbol: string;
  /** Horas desde la descarga. La UI lo necesita para no presentar como
   *  "actual" un múltiplo de hace una semana si el cron estuvo caído. */
  ageHours: number | null;
};

/** JSON guardado como text: un parse fallido devuelve el vacío en vez de
 *  tumbar la lectura. Es carga útil accesoria — perderla degrada la vista,
 *  no la invalida. */
function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function rowToMetrics(r: Row): StoredMetrics {
  return {
    symbol: r.symbol,
    forwardPe: r.forward_pe,
    peTtm: r.pe_ttm,
    pegTtm: r.peg_ttm,
    forwardPeg: r.forward_peg,
    evEbitdaTtm: r.ev_ebitda_ttm,
    psTtm: r.ps_ttm,
    pb: r.pb,
    pTbv: r.p_tbv,
    evFcf: r.ev_fcf,
    roeTtm: r.roe_ttm,
    roicTtm: r.roic_ttm,
    grossMarginTtm: r.gross_margin_ttm,
    operatingMarginTtm: r.operating_margin_ttm,
    netMarginTtm: r.net_margin_ttm,
    fcfMargin: r.fcf_margin,
    revenueGrowthTtmYoy: r.revenue_growth_ttm_yoy,
    revenueGrowth3y: r.revenue_growth_3y,
    epsGrowthTtmYoy: r.eps_growth_ttm_yoy,
    epsGrowth3y: r.eps_growth_3y,
    totalDebtToEquity: r.total_debt_to_equity,
    currentRatio: r.current_ratio,
    dividendYieldTtm: r.dividend_yield_ttm,
    payoutRatioTtm: r.payout_ratio_ttm,
    history: parseJson<ValuationHistory>(r.history, {}),
    discarded: parseJson<DiscardNote[]>(r.discarded, []),
    asOf: r.as_of,
    ageHours: r.age_hours,
  };
}

const SELECT = sql`
  SELECT *, EXTRACT(EPOCH FROM (now() - fetched_at)) / 3600 AS age_hours
  FROM ticker_metrics
`;

export async function getMetrics(symbol: string): Promise<StoredMetrics | null> {
  const rows = unwrapRows<Row>(
    await db.execute(sql`${SELECT} WHERE symbol = ${symbol.toUpperCase()}`),
  );
  return rows[0] ? rowToMetrics(rows[0]) : null;
}

/** Métricas de varios símbolos en UNA query — la cartera entera cuesta lo
 *  mismo que un símbolo. Devuelve un Map para que el llamante no tenga que
 *  reindexar (y no pueda desalinear símbolo y fila, que es el bug de esta
 *  clase de función). */
export async function getMetricsMap(
  symbols: string[],
): Promise<Map<string, StoredMetrics>> {
  const syms = [...new Set(symbols.map((s) => s.toUpperCase()))];
  if (!syms.length) return new Map();
  const rows = unwrapRows<Row>(
    await db.execute(sql`
      ${SELECT} WHERE symbol = ANY(${sql`ARRAY[${sql.join(
        syms.map((s) => sql`${s}`),
        sql`, `,
      )}]::text[]`})
    `),
  );
  return new Map(rows.map((r) => [r.symbol, rowToMetrics(r)]));
}
