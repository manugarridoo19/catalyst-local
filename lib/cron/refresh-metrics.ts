import { sql } from "drizzle-orm";
import { db, unwrapRows } from "@/lib/db";
import { getBasicFinancials } from "@/lib/providers/finnhub";
import { deriveMetrics } from "@/lib/metrics/derive";
import { jobRanWithin, markJobRun } from "@/lib/cron/job-state";

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

export async function runRefreshMetricsCron(): Promise<MetricsRefreshResult> {
  const all = unwrapRows<{ symbol: string }>(
    await db.execute(sql`SELECT DISTINCT symbol FROM watchlist ORDER BY symbol`),
  );

  // La frescura se mide con `job_state` (marca de INTENTO) y no con
  // `ticker_metrics.fetched_at`, porque un símbolo sin cobertura en Finnhub
  // no llega a escribir fila: guardarse por la tabla propia lo volvería a
  // preguntar en cada tick. Es la lección de `earnings-cal:` literalmente.
  const stale: string[] = [];
  for (const { symbol } of all) {
    if (!(await jobRanWithin(`metrics:${symbol}`, STALE_HOURS))) {
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

      await db.execute(sql`
        INSERT INTO ticker_metrics (
          symbol, forward_pe, pe_ttm, peg_ttm, forward_peg, ev_ebitda_ttm,
          ps_ttm, pb, p_tbv, ev_fcf, roe_ttm, roic_ttm, gross_margin_ttm,
          operating_margin_ttm, net_margin_ttm, fcf_margin,
          revenue_growth_ttm_yoy, revenue_growth_3y, eps_growth_ttm_yoy,
          eps_growth_3y, total_debt_to_equity, current_ratio,
          dividend_yield_ttm, payout_ratio_ttm, history, discarded, as_of,
          fetched_at
        ) VALUES (
          ${symbol}, ${m.forwardPe}, ${m.peTtm}, ${m.pegTtm}, ${m.forwardPeg},
          ${m.evEbitdaTtm}, ${m.psTtm}, ${m.pb}, ${m.pTbv}, ${m.evFcf},
          ${m.roeTtm}, ${m.roicTtm}, ${m.grossMarginTtm},
          ${m.operatingMarginTtm}, ${m.netMarginTtm}, ${m.fcfMargin},
          ${m.revenueGrowthTtmYoy}, ${m.revenueGrowth3y}, ${m.epsGrowthTtmYoy},
          ${m.epsGrowth3y}, ${m.totalDebtToEquity}, ${m.currentRatio},
          ${m.dividendYieldTtm}, ${m.payoutRatioTtm},
          ${JSON.stringify(m.history)}, ${JSON.stringify(m.discarded)},
          ${m.asOf}, now()
        )
        ON CONFLICT (symbol) DO UPDATE SET
          forward_pe = EXCLUDED.forward_pe, pe_ttm = EXCLUDED.pe_ttm,
          peg_ttm = EXCLUDED.peg_ttm, forward_peg = EXCLUDED.forward_peg,
          ev_ebitda_ttm = EXCLUDED.ev_ebitda_ttm, ps_ttm = EXCLUDED.ps_ttm,
          pb = EXCLUDED.pb, p_tbv = EXCLUDED.p_tbv, ev_fcf = EXCLUDED.ev_fcf,
          roe_ttm = EXCLUDED.roe_ttm, roic_ttm = EXCLUDED.roic_ttm,
          gross_margin_ttm = EXCLUDED.gross_margin_ttm,
          operating_margin_ttm = EXCLUDED.operating_margin_ttm,
          net_margin_ttm = EXCLUDED.net_margin_ttm,
          fcf_margin = EXCLUDED.fcf_margin,
          revenue_growth_ttm_yoy = EXCLUDED.revenue_growth_ttm_yoy,
          revenue_growth_3y = EXCLUDED.revenue_growth_3y,
          eps_growth_ttm_yoy = EXCLUDED.eps_growth_ttm_yoy,
          eps_growth_3y = EXCLUDED.eps_growth_3y,
          total_debt_to_equity = EXCLUDED.total_debt_to_equity,
          current_ratio = EXCLUDED.current_ratio,
          dividend_yield_ttm = EXCLUDED.dividend_yield_ttm,
          payout_ratio_ttm = EXCLUDED.payout_ratio_ttm,
          history = EXCLUDED.history, discarded = EXCLUDED.discarded,
          as_of = EXCLUDED.as_of, fetched_at = now()
      `);
      refreshed++;
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, stale.length) }, worker),
  );

  return { symbols: all.length, refreshed, empty, failed };
}
