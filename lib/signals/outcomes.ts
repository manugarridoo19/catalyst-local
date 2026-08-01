import { sql } from "drizzle-orm";
import { db, unwrapRows } from "@/lib/db";
import { etDateString, etHour, type AdjCloseSeries } from "@/lib/providers/yahoo";
import { getAdjCloseSeries, fmpFallbackUsed } from "@/lib/signals/prices";
import { HORIZONS } from "@/lib/signals/kinds";

// Job que mide las señales contra los precios posteriores. Node-only (pega a
// proveedores de precios); vive en el cron-runner, chunked + resumable como
// score-orphans: cada pasada coge los eventos maduros más antiguos, escribe
// lo que puede y sale dentro del presupuesto de tiempo. Nunca hay "estado a
// medias": cada (evento, horizonte) se rellena una vez y es idempotente.
//
// Cadencia: UNA pasada al día (guard global abajo). El cron corre cada 10min
// porque las noticias son perecederas; un cierre de ayer no lo es.

const BENCHMARK_SYMBOL = "SPY";
// Un símbolo que Yahoo no sirve (deslistado, fusionado, ticker exótico) se
// reintenta 1×/día; tras 10 días sin datos se abandona. Un evento SANO nunca
// llega ahí: el contador se resetea en cuanto se rellena un horizonte.
const MAX_ATTEMPTS = 10;
const RETRY_HOURS = 20;
const DEFAULT_MAX_SYMBOLS = 40;
const DEFAULT_MAX_EVENTS = 300;
const YAHOO_GAP_MS = 150;
const DEFAULT_BUDGET_MS = 150_000;

// Días de calendario a partir de los cuales un horizonte en días HÁBILES
// puede haber madurado (5 sesiones = 7 días naturales, + festivos + margen).
// Es solo un prefiltro barato en SQL para no traer eventos verdes; la
// maduración real la decide la serie de sesiones de Yahoo.
const RIPE_CALENDAR_DAYS: Record<number, number> = { 1: 4, 7: 13, 30: 48 };

export type OutcomesResult = {
  eventsProcessed: number;
  outcomesFilled: number;
  symbols: number;
  abandoned: number;
  fmpCalls: number; // llamadas gastadas en el fallback (cuota free 250/día)
  durationMs: number;
};

type PendingEvent = {
  id: number;
  symbol: string;
  detected_at: string | Date;
  filled: number[] | null;
};

// ─── Semántica de horizontes ─────────────────────────────────────────────

// Primera sesión que sirve de BASE. Si la señal nació antes del cierre de un
// día con sesión, la base es ESE cierre (el usuario pudo actuar ese día). Si
// nació tras las 16:00 ET, en fin de semana o en festivo, la base es la
// siguiente sesión — nunca un cierre que ya era pasado cuando surgió.
export function findBaselineDate(
  series: AdjCloseSeries,
  detectedAtMs: number,
): string | null {
  const day = etDateString(detectedAtMs);
  const afterClose = etHour(detectedAtMs) >= 16;
  for (const d of series.dates) {
    if (afterClose ? d > day : d >= day) return d;
  }
  return null;
}

export type HorizonPoint = {
  baselineDate: string;
  targetDate: string;
  baselineClose: number;
  targetClose: number;
  returnPct: number;
};

// Retorno a N DÍAS HÁBILES. "Días hábiles" = posiciones en la serie de
// sesiones reales de Yahoo, así que los festivos de mercado salen bien sin
// mantener un calendario propio.
export function horizonReturn(
  series: AdjCloseSeries,
  baselineDate: string,
  horizon: number,
  todayEt: string,
): HorizonPoint | null {
  const i = series.dates.indexOf(baselineDate);
  if (i < 0) return null;
  const targetDate = series.dates[i + horizon];
  if (!targetDate) return null; // aún no ha madurado
  // Nunca medir contra la sesión EN CURSO: mientras el mercado está abierto
  // Yahoo devuelve el último precio en el slot de hoy, y eso no es un cierre.
  if (targetDate >= todayEt) return null;
  const baselineClose = series.closes.get(baselineDate);
  const targetClose = series.closes.get(targetDate);
  if (!baselineClose || !targetClose) return null;
  return {
    baselineDate,
    targetDate,
    baselineClose,
    targetClose,
    returnPct: (targetClose / baselineClose - 1) * 100,
  };
}

/**
 * Retorno del benchmark entre las DOS MISMAS fechas del punto medido.
 *
 * Vive aquí y se exporta por el mismo motivo que `horizonReturn`: el job del
 * coach mide las operaciones del usuario con esta aritmética y compararlas
 * con las señales sólo tiene sentido si es literalmente la misma función.
 *
 * `null` = no se puede calcular. El caller NO debe escribir la fila con el
 * exceso a null: `signal_outcomes`/`trade_outcomes` no se revisitan nunca
 * (ON CONFLICT DO NOTHING + el set de horizontes ya rellenos), así que un
 * null aquí es permanente y contamina toda estadística de exceso posterior.
 */
export function benchmarkReturn(
  benchmark: AdjCloseSeries,
  point: { baselineDate: string; targetDate: string },
): number | null {
  const base = benchmark.closes.get(point.baselineDate);
  const target = benchmark.closes.get(point.targetDate);
  if (!base || !target) return null;
  return (target / base - 1) * 100;
}

// ─── Job ─────────────────────────────────────────────────────────────────

function ripeCondition() {
  // Un evento entra si le falta ALGÚN horizonte que ya pueda estar maduro.
  // Sin este filtro, un evento recién nacido se reintentaría cada día
  // durante un mes esperando al horizonte de 30d y agotaría MAX_ATTEMPTS
  // antes de poder rellenarlo.
  const parts = HORIZONS.map(
    (h) => sql`(NOT (${h} = ANY(COALESCE(array_agg(o.horizon)
      FILTER (WHERE o.horizon IS NOT NULL), '{}'::smallint[])))
      AND e.detected_at < now() - (${RIPE_CALENDAR_DAYS[h]} || ' days')::interval)`,
  );
  return sql.join(parts, sql` OR `);
}

async function loadPending(maxEvents: number): Promise<PendingEvent[]> {
  return unwrapRows<PendingEvent>(
    await db.execute(sql`
      SELECT e.id, e.symbol, e.detected_at,
        COALESCE(array_agg(o.horizon) FILTER (WHERE o.horizon IS NOT NULL),
          '{}'::smallint[]) AS filled
      FROM signal_events e
      LEFT JOIN signal_outcomes o ON o.event_id = e.id
      WHERE e.outcome_attempts < ${MAX_ATTEMPTS}
        AND (e.last_outcome_at IS NULL
          OR e.last_outcome_at < now() - (${RETRY_HOURS} || ' hours')::interval)
      GROUP BY e.id
      HAVING ${ripeCondition()}
      ORDER BY e.detected_at ASC
      LIMIT ${maxEvents}
    `),
  );
}

export async function runSignalOutcomesCron(opts?: {
  maxSymbols?: number;
  maxEvents?: number;
  budgetMs?: number;
  force?: boolean;
}): Promise<OutcomesResult> {
  const t0 = Date.now();
  const maxSymbols = opts?.maxSymbols ?? DEFAULT_MAX_SYMBOLS;
  const maxEvents = opts?.maxEvents ?? DEFAULT_MAX_EVENTS;
  const budgetMs = opts?.budgetMs ?? DEFAULT_BUDGET_MS;

  // Guard global de UNA pasada al día. El cron corre ~144 veces al día, y
  // los precios ya NO son gratis e ilimitados: Yahoo limita por IP (429 a
  // todo, también desde los runners de GitHub) y el fallback FMP gasta de
  // una cuota de 250/día. Un horizonte que vence hoy da exactamente el mismo
  // número si se mide a las 04:00 o a las 23:00, así que medir 144 veces no
  // aporta nada y sí quema cuota. Los guards por-evento (20h) siguen ahí;
  // éste evita además el coste fijo del benchmark en cada tick.
  if (!opts?.force) {
    const recent = unwrapRows<{ recent: boolean | null }>(
      await db.execute(sql`
        SELECT (MAX(last_outcome_at) > now()
          - (${RETRY_HOURS} || ' hours')::interval) AS recent
        FROM signal_events
      `),
    )[0]?.recent;
    if (recent) {
      return {
        eventsProcessed: 0,
        outcomesFilled: 0,
        symbols: 0,
        abandoned: 0,
        fmpCalls: fmpFallbackUsed(),
        durationMs: Date.now() - t0,
      };
    }
  }

  const pending = await loadPending(maxEvents);
  if (!pending.length) {
    return {
      eventsProcessed: 0,
      outcomesFilled: 0,
      symbols: 0,
      abandoned: 0,
      fmpCalls: fmpFallbackUsed(),
      durationMs: Date.now() - t0,
    };
  }

  // Agrupar por símbolo: una sola llamada a Yahoo sirve a TODOS los eventos
  // de ese símbolo y a todos sus horizontes. Es lo que hace el backfill de
  // mayo barato (~1 request por símbolo, no por evento×horizonte).
  const bySymbol = new Map<string, PendingEvent[]>();
  for (const ev of pending) {
    const list = bySymbol.get(ev.symbol) ?? [];
    list.push(ev);
    bySymbol.set(ev.symbol, list);
  }
  const symbols = Array.from(bySymbol.keys()).slice(0, maxSymbols);

  const todayEt = etDateString(Date.now());
  const oldest = Math.min(
    ...symbols.flatMap((s) =>
      bySymbol.get(s)!.map((e) => new Date(e.detected_at).getTime()),
    ),
  );

  // SPY una sola vez por pasada — el benchmark de todos los eventos.
  //
  // SIN BENCHMARK NO SE MIDE NADA, y la pasada se aborta entera. Antes se
  // seguía adelante escribiendo `benchmark_return_pct = null`, y esa fila ya
  // no se revisitaba jamás: el `ON CONFLICT DO NOTHING` de más abajo y el
  // `already.has(h)` la daban por hecha para siempre. El resultado era una
  // pérdida SILENCIOSA — `getSignalStats` calcula `avg_excess` con AVG (que
  // ignora NULLs) pero reporta `n = COUNT(*)` sobre todas las filas, así que
  // los priors que calibran PICKS_SYSTEM_PROMPT afirmaban un exceso sobre
  // SPY con una muestra que no era la suya. El exceso es la cifra que de
  // verdad importa (un +2% a 30d con el mercado subiendo 3% no es señal, es
  // beta): una medición a medias no es media medición, es una medición mala.
  //
  // Abortar y no medir sin benchmark deja el horizonte PENDIENTE y no toca
  // `outcome_attempts`, así que ni se abandona un evento sano por una caída
  // de Yahoo ni se marca `last_outcome_at` — el guard global de 20h no se
  // arma y el siguiente tick (10 min) reintenta. Los eventos vuelven solos.
  const benchmark = await getAdjCloseSeries(BENCHMARK_SYMBOL, oldest);
  if (!benchmark.dates.length) {
    console.warn(
      "[signals] benchmark SPY no disponible — pasada abortada SIN medir nada (el exceso vs SPY es parte de la semántica congelada); reintento en el próximo tick",
    );
    return {
      eventsProcessed: 0,
      outcomesFilled: 0,
      symbols: 0,
      abandoned: 0,
      fmpCalls: fmpFallbackUsed(),
      durationMs: Date.now() - t0,
    };
  }

  let outcomesFilled = 0;
  let eventsProcessed = 0;
  let abandoned = 0;

  for (const symbol of symbols) {
    if (Date.now() - t0 > budgetMs) break; // resumable: sigue el próximo tick
    const events = bySymbol.get(symbol)!;
    const from = Math.min(
      ...events.map((e) => new Date(e.detected_at).getTime()),
    );
    const series = await getAdjCloseSeries(symbol, from);
    await new Promise((r) => setTimeout(r, YAHOO_GAP_MS));

    for (const ev of events) {
      eventsProcessed++;
      const detectedMs = new Date(ev.detected_at).getTime();
      const already = new Set(ev.filled ?? []);
      let filledNow = 0;

      if (series.dates.length) {
        const base = findBaselineDate(series, detectedMs);
        if (base) {
          for (const h of HORIZONS) {
            if (already.has(h)) continue;
            const point = horizonReturn(series, base, h, todayEt);
            if (!point) continue;
            // Las DOS fechas exactas, o no se escribe la fila. La serie de
            // SPY cubre todo el rango (se pidió desde el evento más antiguo
            // de la pasada), así que un hueco aquí es un día en que SPY no
            // cotizó y el símbolo sí — no se arregla reintentando, y el
            // horizonte se queda pendiente hasta agotar los 10 intentos.
            // Lo que NO se hace es escribirlo con el exceso a null: sería
            // dar por medido lo que no lo está.
            const bench = benchmarkReturn(benchmark, point);
            if (bench === null) {
              console.warn(
                `[signals] evento ${ev.id}/${h}d: SPY sin cierre en ${point.baselineDate}→${point.targetDate} — horizonte NO medido`,
              );
              continue;
            }
            try {
              await db.execute(sql`
                INSERT INTO signal_outcomes (event_id, horizon, baseline_date,
                  target_date, baseline_close, target_close, return_pct,
                  benchmark_return_pct)
                VALUES (${ev.id}, ${h}, ${point.baselineDate}, ${point.targetDate},
                  ${point.baselineClose}, ${point.targetClose}, ${point.returnPct},
                  ${bench})
                ON CONFLICT (event_id, horizon) DO NOTHING
              `);
              filledNow++;
            } catch (err) {
              console.warn(
                `[signals] outcome insert ${ev.id}/${h}d failed:`,
                err instanceof Error ? err.message : err,
              );
            }
          }
        }
      }

      outcomesFilled += filledNow;
      // Éxito → resetea el contador (un evento vivo nunca se abandona
      // esperando su horizonte de 30d). Fracaso → suma un intento; a los 10
      // días sin datos el símbolo se da por muerto.
      if (filledNow > 0) {
        await db.execute(sql`
          UPDATE signal_events
          SET outcome_attempts = 0, last_outcome_at = now()
          WHERE id = ${ev.id}
        `);
      } else {
        const res = await db.execute(sql`
          UPDATE signal_events
          SET outcome_attempts = outcome_attempts + 1, last_outcome_at = now()
          WHERE id = ${ev.id}
          RETURNING outcome_attempts
        `);
        const attempts = unwrapRows<{ outcome_attempts: number }>(res)[0]
          ?.outcome_attempts;
        if (attempts != null && attempts >= MAX_ATTEMPTS) abandoned++;
      }
    }
  }

  return {
    eventsProcessed,
    outcomesFilled,
    symbols: symbols.length,
    abandoned,
    fmpCalls: fmpFallbackUsed(),
    durationMs: Date.now() - t0,
  };
}
