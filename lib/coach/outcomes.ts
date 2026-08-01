import { sql } from "drizzle-orm";
import { db, unwrapRows } from "@/lib/db";
import { etDateString } from "@/lib/providers/yahoo";
import { getAdjCloseSeries, fmpFallbackUsed } from "@/lib/signals/prices";
import {
  benchmarkReturn,
  findBaselineDate,
  horizonReturn,
} from "@/lib/signals/outcomes";
import { MEASURED_HORIZONS, RIPE_CALENDAR_DAYS } from "@/lib/coach/horizon";

// Mide TUS operaciones contra los precios posteriores. Node-only (pega a
// proveedores de precios), corre en el cron-runner junto al job gemelo del
// Signal Lab.
//
// POR QUÉ REUTILIZA `findBaselineDate` Y `horizonReturn` EN VEZ DE
// REIMPLEMENTARLAS: el valor de este panel es poder comparar tus decisiones
// con las señales de Catalyst, y dos series de números sólo son comparables
// si salen de la misma aritmética. La semántica de retorno del Lab está
// CONGELADA a propósito (close-to-close sobre cierres ajustados, horizontes
// en días hábiles contados como posiciones en la serie real de sesiones,
// benchmark SPY entre las dos mismas fechas); copiarla a mano aquí sería
// crear una segunda definición que se desviaría en la primera corrección
// que alguien aplicara sólo a una de las dos.
//
// Y `findBaselineDate` encaja sin adaptarla porque la pregunta resulta ser
// la misma: cuál es el primer cierre observable DESPUÉS del momento. Para
// una señal es el primer cierre en que habrías podido actuar; para una
// operación es el primer cierre después de que actuaras. Si vendiste a las
// 13:39 ET, la base es el cierre de ESE día; si vendiste tras las 16:00, el
// de la sesión siguiente.
//
// Lo que este job NO hace: decidir si la operación salió bien. Escribe el
// movimiento del mercado sin signo. La lectura vive en `measure.ts`.

const BENCHMARK_SYMBOL = "SPY";
const MAX_ATTEMPTS = 10;
const RETRY_HOURS = 20;
const DEFAULT_MAX_SYMBOLS = 12;
const DEFAULT_MAX_TRADES = 300;
const YAHOO_GAP_MS = 150;
const DEFAULT_BUDGET_MS = 60_000;

export type TradeOutcomesResult = {
  tradesProcessed: number;
  outcomesFilled: number;
  symbols: number;
  abandoned: number;
  fmpCalls: number;
  durationMs: number;
};

type PendingTrade = {
  id: number;
  symbol: string;
  created_at: string | Date;
  filled: number[] | null;
};

function ripeCondition() {
  const parts = MEASURED_HORIZONS.map(
    (h) => sql`(NOT (${h} = ANY(COALESCE(array_agg(o.horizon)
      FILTER (WHERE o.horizon IS NOT NULL), '{}'::smallint[])))
      AND t.created_at < now() - (${RIPE_CALENDAR_DAYS[h]} || ' days')::interval)`,
  );
  return sql.join(parts, sql` OR `);
}

async function loadPending(maxTrades: number): Promise<PendingTrade[]> {
  return unwrapRows<PendingTrade>(
    await db.execute(sql`
      SELECT t.id, t.symbol, t.created_at,
        COALESCE(array_agg(o.horizon) FILTER (WHERE o.horizon IS NOT NULL),
          '{}'::smallint[]) AS filled
      FROM position_trades t
      LEFT JOIN trade_outcomes o ON o.trade_id = t.id
      -- Los 'adjust' quedan FUERA por definición: una corrección a mano no
      -- es una decisión de mercado, así que medirla contra el precio
      -- posterior fabricaría aciertos y errores que nadie tomó.
      WHERE t.side <> 'adjust'
        -- Sólo lo que se sigue vigilando. position_trades es append-only y
        -- no tiene FK contra watchlist (el diario sobrevive a propósito a
        -- que quites el valor de la lista), así que sin esto se seguían
        -- pidiendo precios a Yahoo por símbolos que el usuario ya no tiene ni
        -- mira — y el resultado no se pinta en ningún sitio, porque el panel
        -- del coach sólo lee posiciones con shares > 0.
        AND EXISTS (
          SELECT 1 FROM watchlist w
           WHERE w.user_session = t.user_session AND w.symbol = t.symbol
        )
        AND t.outcome_attempts < ${MAX_ATTEMPTS}
        AND (t.last_outcome_at IS NULL
          OR t.last_outcome_at < now() - (${RETRY_HOURS} || ' hours')::interval)
      GROUP BY t.id
      HAVING ${ripeCondition()}
      ORDER BY t.created_at ASC
      LIMIT ${maxTrades}
    `),
  );
}

export async function runTradeOutcomesCron(opts?: {
  maxSymbols?: number;
  maxTrades?: number;
  budgetMs?: number;
  force?: boolean;
}): Promise<TradeOutcomesResult> {
  const t0 = Date.now();
  const maxSymbols = opts?.maxSymbols ?? DEFAULT_MAX_SYMBOLS;
  const maxTrades = opts?.maxTrades ?? DEFAULT_MAX_TRADES;
  const budgetMs = opts?.budgetMs ?? DEFAULT_BUDGET_MS;

  const empty = (): TradeOutcomesResult => ({
    tradesProcessed: 0,
    outcomesFilled: 0,
    symbols: 0,
    abandoned: 0,
    fmpCalls: fmpFallbackUsed(),
    durationMs: Date.now() - t0,
  });

  // Guard global de UNA pasada al día, por el mismo motivo que en el Lab: el
  // cron corre ~144 veces al día y un horizonte que vence hoy da el mismo
  // número a las 04:00 que a las 23:00. Yahoo limita por IP y el fallback
  // FMP gasta de una cuota de 250/día compartida.
  if (!opts?.force) {
    const recent = unwrapRows<{ recent: boolean | null }>(
      await db.execute(sql`
        SELECT (MAX(last_outcome_at) > now()
          - (${RETRY_HOURS} || ' hours')::interval) AS recent
        FROM position_trades
      `),
    )[0]?.recent;
    if (recent) return empty();
  }

  const pending = await loadPending(maxTrades);
  if (!pending.length) return empty();

  // Agrupado por símbolo: una llamada de precios sirve a TODAS las
  // operaciones de ese valor y a todos sus horizontes. Con una cartera de 7
  // nombres y varias compras por nombre, la diferencia es 7 llamadas frente
  // a decenas.
  const bySymbol = new Map<string, PendingTrade[]>();
  for (const tr of pending) {
    const list = bySymbol.get(tr.symbol) ?? [];
    list.push(tr);
    bySymbol.set(tr.symbol, list);
  }
  const symbols = Array.from(bySymbol.keys()).slice(0, maxSymbols);

  const todayEt = etDateString(Date.now());
  const oldest = Math.min(
    ...symbols.flatMap((s) =>
      bySymbol.get(s)!.map((tr) => new Date(tr.created_at).getTime()),
    ),
  );

  // Mismo criterio que el job gemelo del Lab: sin benchmark no se mide, y la
  // pasada se aborta entera en vez de escribir el exceso a null. Aquí pesa
  // incluso más que allí porque `judgeTrade` degrada `basis` de "benchmark"
  // a "mercado" cuando falta, y eso cambia el VEREDICTO que se le enseña al
  // usuario: vender antes de una caída del 6% no es puntería si el mercado
  // entero cayó un 6% esa semana. No tocar `outcome_attempts` ni
  // `last_outcome_at` deja las operaciones pendientes y el siguiente tick
  // reintenta.
  const benchmark = await getAdjCloseSeries(BENCHMARK_SYMBOL, oldest);
  if (!benchmark.dates.length) {
    console.warn(
      "[coach] benchmark SPY no disponible — pasada abortada SIN medir nada; reintento en el próximo tick",
    );
    return empty();
  }

  let outcomesFilled = 0;
  let tradesProcessed = 0;
  let abandoned = 0;

  for (const symbol of symbols) {
    if (Date.now() - t0 > budgetMs) break; // resumable
    const trades = bySymbol.get(symbol)!;
    const from = Math.min(
      ...trades.map((tr) => new Date(tr.created_at).getTime()),
    );
    const series = await getAdjCloseSeries(symbol, from);
    await new Promise((r) => setTimeout(r, YAHOO_GAP_MS));

    for (const tr of trades) {
      tradesProcessed++;
      const executedMs = new Date(tr.created_at).getTime();
      const already = new Set(tr.filled ?? []);
      let filledNow = 0;

      if (series.dates.length) {
        const base = findBaselineDate(series, executedMs);
        if (base) {
          for (const h of MEASURED_HORIZONS) {
            if (already.has(h)) continue;
            const point = horizonReturn(series, base, h, todayEt);
            if (!point) continue;
            // Misma función que el Lab, no una copia: comparar tus decisiones
            // con las señales exige que el exceso salga de la misma aritmética.
            const bench = benchmarkReturn(benchmark, point);
            if (bench === null) {
              console.warn(
                `[coach] operación ${tr.id}/${h}d: SPY sin cierre en ${point.baselineDate}→${point.targetDate} — horizonte NO medido`,
              );
              continue;
            }
            try {
              await db.execute(sql`
                INSERT INTO trade_outcomes (trade_id, horizon, baseline_date,
                  target_date, baseline_close, target_close, return_pct,
                  benchmark_return_pct)
                VALUES (${tr.id}, ${h}, ${point.baselineDate}, ${point.targetDate},
                  ${point.baselineClose}, ${point.targetClose}, ${point.returnPct},
                  ${bench})
                ON CONFLICT (trade_id, horizon) DO NOTHING
              `);
              filledNow++;
            } catch (err) {
              console.warn(
                `[coach] outcome insert ${tr.id}/${h}d falló:`,
                err instanceof Error ? err.message : err,
              );
            }
          }
        }
      }

      outcomesFilled += filledNow;
      // Éxito → resetea el contador, para que una operación sana nunca se
      // abandone esperando su horizonte de 30d.
      if (filledNow > 0) {
        await db.execute(sql`
          UPDATE position_trades
          SET outcome_attempts = 0, last_outcome_at = now()
          WHERE id = ${tr.id}
        `);
      } else {
        const res = await db.execute(sql`
          UPDATE position_trades
          SET outcome_attempts = outcome_attempts + 1, last_outcome_at = now()
          WHERE id = ${tr.id}
          RETURNING outcome_attempts
        `);
        const attempts = unwrapRows<{ outcome_attempts: number }>(res)[0]
          ?.outcome_attempts;
        if (attempts != null && attempts >= MAX_ATTEMPTS) abandoned++;
      }
    }
  }

  return {
    tradesProcessed,
    outcomesFilled,
    symbols: symbols.length,
    abandoned,
    fmpCalls: fmpFallbackUsed(),
    durationMs: Date.now() - t0,
  };
}
