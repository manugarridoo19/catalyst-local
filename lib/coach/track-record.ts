import { sql } from "drizzle-orm";
import { db, unwrapRows } from "@/lib/db";
import {
  judgeTrade,
  verdictLabel,
  type JudgedTrade,
} from "@/lib/coach/measure";
import {
  isTradeHorizon,
  verdictHorizonsFor,
  type TradeHorizon,
} from "@/lib/coach/horizon";

// El track record de TUS operaciones — la lectura que faltaba de
// `trade_outcomes`, que hasta ahora era una tabla de solo escritura: el cron
// medía cada operación a diario y ninguna superficie lo enseñaba.
//
// La agregación vive en TS y no en SQL a propósito: el veredicto de una
// operación depende del lado, del plazo declarado y del horizonte
// (`judgeTrade`), y duplicar esa convención en una query crearía la segunda
// definición que measure.ts existe para impedir. El diario es de un solo
// usuario real: traer las filas y juzgar en código es más barato que
// mantener dos criterios que pueden divergir (mismo argumento que
// `getJournalCash`).
//
// Workers-safe: solo lecturas por el driver HTTP, cero LLM, cero red.

export type TrackRecordOutcomeRow = {
  trade_id: number;
  symbol: string;
  side: string;
  horizon: string | null;
  annotated_later: boolean;
  created_at: string;
  at_horizon: number;
  return_pct: number;
  benchmark_return_pct: number | null;
};

export type JudgedJournalTrade = {
  tradeId: number;
  symbol: string;
  side: "buy" | "sell";
  plazo: TradeHorizon | null;
  annotatedLater: boolean;
  createdAt: string; // yyyy-mm-dd
  /** Retorno CRUDO del valor por horizonte medido (1|7|30|90|180), en %.
   *  Contexto siempre legítimo, veredicto solo donde el plazo lo admite. */
  returns: Partial<Record<number, number>>;
  /** El veredicto al horizonte de veredicto más largo YA medido — el juicio
   *  más maduro disponible, no el primero que llegó. */
  verdict: {
    atHorizon: number;
    edgePct: number;
    basis: "benchmark" | "mercado";
    label: "acierto" | "error" | "neutro";
  } | null;
  /** Por qué no hay veredicto, cuando no lo hay. `madurando` = el plazo
   *  admite veredicto pero sus horizontes aún no tienen precio; `nunca` =
   *  este plazo no se juzga por precio (largo / sin clasificar). */
  pendingVerdict: { kind: "madurando" | "nunca"; reason: string } | null;
};

export type TrackRecordStatRow = {
  horizon: number;
  n: number;
  avgEdge: number;
  aciertos: number;
  errores: number;
  neutros: number;
};

export type TrackRecord = {
  trades: JudgedJournalTrade[];
  stats: TrackRecordStatRow[];
  totals: {
    /** Decisiones en el diario (buy/sell; los adjust no se juzgan). */
    decisions: number;
    measured: number;
    withVerdict: number;
    /** Decisiones sin ninguna medición todavía (horizonte sin madurar). */
    awaitingPrice: number;
  };
};

/** Exceso medio de las SEÑALES de Catalyst en los mismos horizontes, como
 *  referencia. Comparable porque `trade_outcomes` reutiliza la aritmética
 *  del Lab; la diferencia de convención (aquí el edge lleva el signo de tu
 *  decisión, allí todo es "lado compra") se dice en la UI, no se oculta. */
export type LabReference = Partial<
  Record<number, { n: number; avgExcess: number }>
>;

const NEVER_REASON: Record<string, string> = {
  sin_plazo_declarado: "sin plazo declarado — clasifícala en el diario",
  plazo_largo_no_se_juzga_por_precio:
    "plazo largo — se vigila la tesis, no el precio",
};

/** Agregación pura (sin BD): filas de outcomes YA medidas + decisiones sin
 *  medir → track record. Separada para poder testearla contra casos
 *  fabricados sin tocar Neon. */
export function buildTrackRecord(
  rows: TrackRecordOutcomeRow[],
  awaitingPrice: number,
  decisions: number,
): TrackRecord {
  const byTrade = new Map<number, TrackRecordOutcomeRow[]>();
  for (const r of rows) {
    const list = byTrade.get(r.trade_id) ?? [];
    list.push(r);
    byTrade.set(r.trade_id, list);
  }

  const trades: JudgedJournalTrade[] = [];
  const perHorizon = new Map<
    number,
    { edges: number[]; aciertos: number; errores: number; neutros: number }
  >();

  for (const [tradeId, list] of byTrade) {
    const head = list[0];
    if (head.side !== "buy" && head.side !== "sell") continue; // adjust: sin outcomes por diseño
    const plazo = isTradeHorizon(head.horizon) ? head.horizon : null;

    const returns: Partial<Record<number, number>> = {};
    let verdict: JudgedJournalTrade["verdict"] = null;

    for (const r of [...list].sort((a, b) => a.at_horizon - b.at_horizon)) {
      returns[r.at_horizon] = r.return_pct;
      const judged: JudgedTrade = {
        side: head.side,
        horizon: plazo,
        atHorizon: r.at_horizon,
        returnPct: r.return_pct,
        benchmarkReturnPct: r.benchmark_return_pct,
      };
      const v = judgeTrade(judged);
      const label = verdictLabel(v);
      if (v.edgePct === null || v.basis === null || label === null) continue;
      // `edge = −exceso` en una venta produce −0 cuando el exceso es
      // exactamente cero; se normaliza para no pintar nunca un «−0.0pp».
      const edgePct = v.edgePct === 0 ? 0 : v.edgePct;
      // Orden ascendente → el último que entra es el horizonte más largo.
      verdict = { atHorizon: r.at_horizon, edgePct, basis: v.basis, label };
      const agg =
        perHorizon.get(r.at_horizon) ??
        { edges: [], aciertos: 0, errores: 0, neutros: 0 };
      agg.edges.push(edgePct);
      if (label === "acierto") agg.aciertos++;
      else if (label === "error") agg.errores++;
      else agg.neutros++;
      perHorizon.set(r.at_horizon, agg);
    }

    let pendingVerdict: JudgedJournalTrade["pendingVerdict"] = null;
    if (!verdict) {
      const eligible = verdictHorizonsFor(plazo);
      if (!eligible.length) {
        const probe = judgeTrade({
          side: head.side,
          horizon: plazo,
          atHorizon: 1,
          returnPct: 0,
          benchmarkReturnPct: 0,
        });
        pendingVerdict = {
          kind: "nunca",
          reason:
            (probe.noVerdict && NEVER_REASON[probe.noVerdict]) ??
            "no se juzga por precio",
        };
      } else {
        pendingVerdict = {
          kind: "madurando",
          reason: `veredicto a ${eligible.join("/")} sesiones cuando maduren`,
        };
      }
    }

    trades.push({
      tradeId,
      symbol: head.symbol,
      side: head.side,
      plazo,
      annotatedLater: head.annotated_later,
      createdAt: head.created_at,
      returns,
      verdict,
      pendingVerdict,
    });
  }

  trades.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));

  const stats: TrackRecordStatRow[] = Array.from(perHorizon.entries())
    .map(([horizon, agg]) => ({
      horizon,
      n: agg.edges.length,
      avgEdge:
        Math.round(
          (agg.edges.reduce((s, e) => s + e, 0) / agg.edges.length) * 100,
        ) / 100,
      aciertos: agg.aciertos,
      errores: agg.errores,
      neutros: agg.neutros,
    }))
    .sort((a, b) => a.horizon - b.horizon);

  return {
    trades,
    stats,
    totals: {
      decisions,
      measured: byTrade.size,
      withVerdict: trades.filter((t) => t.verdict).length,
      awaitingPrice,
    },
  };
}

export async function getTrackRecord(session: string): Promise<TrackRecord> {
  const [rowsRes, totalsRes] = await Promise.all([
    db.execute(sql`
      SELECT t.id AS trade_id, t.symbol, t.side, t.horizon,
        t.annotated_later,
        to_char(t.created_at at time zone 'UTC', 'YYYY-MM-DD') AS created_at,
        o.horizon::int AS at_horizon, o.return_pct, o.benchmark_return_pct
      FROM position_trades t
      JOIN trade_outcomes o ON o.trade_id = t.id
      WHERE t.user_session = ${session}
      ORDER BY t.created_at DESC, t.id DESC, o.horizon ASC
    `),
    db.execute(sql`
      SELECT
        COUNT(*) FILTER (WHERE side <> 'adjust')::int AS decisions,
        COUNT(*) FILTER (WHERE side <> 'adjust' AND NOT EXISTS (
          SELECT 1 FROM trade_outcomes o WHERE o.trade_id = position_trades.id
        ))::int AS awaiting
      FROM position_trades
      WHERE user_session = ${session}
    `),
  ]);
  const rows = unwrapRows<TrackRecordOutcomeRow>(rowsRes);
  const totals = unwrapRows<{ decisions: number; awaiting: number }>(
    totalsRes,
  )[0] ?? { decisions: 0, awaiting: 0 };

  return buildTrackRecord(rows, totals.awaiting, totals.decisions);
}

/** Referencia del Signal Lab en los horizontes que comparte con el diario
 *  (1/7/30). Global a propósito: las señales no son de ninguna sesión. */
export async function getLabReference(): Promise<LabReference> {
  const rows = unwrapRows<{ horizon: number; n: number; avg_excess: number }>(
    await db.execute(sql`
      SELECT o.horizon::int AS horizon, COUNT(*)::int AS n,
        ROUND(AVG(o.return_pct - o.benchmark_return_pct)::numeric, 2)::float
          AS avg_excess
      FROM signal_outcomes o
      WHERE o.benchmark_return_pct IS NOT NULL
      GROUP BY o.horizon
    `),
  );
  const ref: LabReference = {};
  for (const r of rows) ref[r.horizon] = { n: r.n, avgExcess: r.avg_excess };
  return ref;
}
