import { sql } from "drizzle-orm";
import { db, unwrapRows } from "@/lib/db";

// Agregados de la sección Insider & Smart Money. Solo LECTURA de BD —
// Workers-safe (la página /insider los renderiza en el Worker público).
//
// Señal vs ruido: los agregados de flujo usan SOLO operaciones a mercado
// abierto (P = compra, S = venta). Grants (A), ejercicios (M), ventas para
// cubrir impuestos (F)… son plumbing de compensación, no convicción — están
// en la tabla por completitud pero no cuentan como "dónde invierten".

const FLOW_DAYS = 7;

export type InsiderFlowRow = {
  symbol: string;
  name: string | null;
  buy_value: number;
  sell_value: number;
  net_value: number;
  buyers: number;
  sellers: number;
  trades: number;
};

// Flujo neto por símbolo (ventana 7d). Una sola query; el caller particiona
// en net buying / net selling.
export async function getInsiderFlow(
  days = FLOW_DAYS,
  limit = 24,
): Promise<InsiderFlowRow[]> {
  return unwrapRows<InsiderFlowRow>(
    await db.execute(sql`
      SELECT t.symbol, MAX(tk.name) AS name,
        COALESCE(SUM(t.value) FILTER (WHERE t.tx_code = 'P'), 0)::float AS buy_value,
        COALESCE(SUM(t.value) FILTER (WHERE t.tx_code = 'S'), 0)::float AS sell_value,
        (COALESCE(SUM(t.value) FILTER (WHERE t.tx_code = 'P'), 0)
          - COALESCE(SUM(t.value) FILTER (WHERE t.tx_code = 'S'), 0))::float AS net_value,
        COUNT(DISTINCT t.owner_name) FILTER (WHERE t.tx_code = 'P')::int AS buyers,
        COUNT(DISTINCT t.owner_name) FILTER (WHERE t.tx_code = 'S')::int AS sellers,
        COUNT(*)::int AS trades
      FROM insider_trades t
      LEFT JOIN tickers tk ON tk.symbol = t.symbol
      WHERE t.filed_at >= now() - (${days} || ' days')::interval
        AND t.tx_code IN ('P', 'S')
        AND t.value IS NOT NULL
      GROUP BY t.symbol
      ORDER BY ABS(COALESCE(SUM(t.value) FILTER (WHERE t.tx_code = 'P'), 0)
        - COALESCE(SUM(t.value) FILTER (WHERE t.tx_code = 'S'), 0)) DESC
      LIMIT ${limit}
    `),
  );
}

export type ClusterBuyRow = {
  symbol: string;
  name: string | null;
  buyers: number;
  total_value: number;
  owner_names: string;
  last_filed_at: string | Date;
};

// Cluster buys: ≥2 insiders DISTINTOS comprando a mercado abierto el mismo
// valor en la ventana — la señal insider clásica más fuerte.
export async function getClusterBuys(
  days = FLOW_DAYS,
  limit = 8,
): Promise<ClusterBuyRow[]> {
  return unwrapRows<ClusterBuyRow>(
    await db.execute(sql`
      SELECT t.symbol, MAX(tk.name) AS name,
        COUNT(DISTINCT t.owner_name)::int AS buyers,
        COALESCE(SUM(t.value), 0)::float AS total_value,
        STRING_AGG(DISTINCT t.owner_name, ', ') AS owner_names,
        MAX(t.filed_at) AS last_filed_at
      FROM insider_trades t
      LEFT JOIN tickers tk ON tk.symbol = t.symbol
      WHERE t.filed_at >= now() - (${days} || ' days')::interval
        AND t.tx_code = 'P'
      GROUP BY t.symbol
      HAVING COUNT(DISTINCT t.owner_name) >= 2
      ORDER BY COUNT(DISTINCT t.owner_name) DESC, SUM(t.value) DESC NULLS LAST
      LIMIT ${limit}
    `),
  );
}

export type FundStakeRow = {
  id: number;
  symbol: string;
  name: string | null;
  form_type: string;
  filer_name: string | null;
  percent_of_class: number | null;
  filing_url: string;
  filed_at: string | Date;
};

export async function getRecentStakes(limit = 14): Promise<FundStakeRow[]> {
  return unwrapRows<FundStakeRow>(
    await db.execute(sql`
      SELECT s.id, s.symbol, tk.name, s.form_type, s.filer_name,
        s.percent_of_class, s.filing_url, s.filed_at
      FROM fund_stakes s
      LEFT JOIN tickers tk ON tk.symbol = s.symbol
      ORDER BY s.filed_at DESC
      LIMIT ${limit}
    `),
  );
}

export type NotableTradeRow = {
  symbol: string;
  name: string | null;
  owner_name: string;
  owner_title: string | null;
  is_ten_percent: number;
  tx_code: string;
  shares: number;
  price: number | null;
  value: number | null;
  filing_url: string;
  filed_at: string | Date;
};

// Trades individuales más grandes (por $) de la ventana — open market only.
export async function getNotableTrades(
  days = FLOW_DAYS,
  limit = 20,
): Promise<NotableTradeRow[]> {
  return unwrapRows<NotableTradeRow>(
    await db.execute(sql`
      SELECT t.symbol, tk.name, t.owner_name, t.owner_title, t.is_ten_percent,
        t.tx_code, t.shares, t.price, t.value, t.filing_url, t.filed_at
      FROM insider_trades t
      LEFT JOIN tickers tk ON tk.symbol = t.symbol
      WHERE t.filed_at >= now() - (${days} || ' days')::interval
        AND t.tx_code IN ('P', 'S')
        AND t.value IS NOT NULL
      ORDER BY t.value DESC
      LIMIT ${limit}
    `),
  );
}

export type ExerciseActivityRow = {
  symbol: string;
  name: string | null;
  ownerName: string;
  ownerTitle: string | null;
  /** Acciones adquiridas ejercitando opciones (M) en el filing. */
  exercised: number;
  /** Vendidas (S) + retenidas para impuestos (F) en el MISMO filing. */
  disposed: number;
  /** % de lo ejercitado que el insider SE QUEDÓ. La cifra con señal:
   *  quedárselo todo es pagar strike e impuestos por tener más acciones —
   *  dinero propio detrás de la posición —; venderlo todo el mismo día es
   *  compensación cobrándose, no una opinión sobre la empresa. */
  keptPct: number;
  filingUrl: string;
  filedAt: string | Date;
};

/**
 * Ejercicios de opciones recientes, con qué hizo el insider con las
 * acciones. Los tx_code A/M/F se ALMACENAN desde el día uno pero todos los
 * agregados los excluyen (correcto para el flujo open-market): este dataset
 * completo no tenía ninguna superficie. La agregación va por FILING, que es
 * como llegan emparejados el ejercicio y su venta del mismo día.
 */
export async function getExerciseActivity(
  days = 30,
  limit = 12,
): Promise<ExerciseActivityRow[]> {
  return unwrapRows<{
    symbol: string;
    name: string | null;
    owner_name: string;
    owner_title: string | null;
    exercised: number;
    disposed: number;
    filing_url: string;
    filed_at: string | Date;
  }>(
    await db.execute(sql`
      SELECT t.symbol, MIN(tk.name) AS name, t.owner_name,
        MIN(t.owner_title) AS owner_title,
        SUM(t.shares) FILTER (WHERE t.tx_code = 'M')::float AS exercised,
        COALESCE(SUM(t.shares) FILTER (WHERE t.tx_code IN ('S','F')), 0)::float
          AS disposed,
        t.filing_url, MAX(t.filed_at) AS filed_at
      FROM insider_trades t
      LEFT JOIN tickers tk ON tk.symbol = t.symbol
      WHERE t.filed_at >= now() - (${days} || ' days')::interval
      GROUP BY t.symbol, t.owner_name, t.filing_url
      HAVING SUM(t.shares) FILTER (WHERE t.tx_code = 'M') > 0
      ORDER BY SUM(t.shares) FILTER (WHERE t.tx_code = 'M') DESC
      LIMIT ${limit}
    `),
  ).map((r) => ({
    symbol: r.symbol,
    name: r.name,
    ownerName: r.owner_name,
    ownerTitle: r.owner_title,
    exercised: r.exercised,
    disposed: r.disposed,
    // Vender más de lo ejercitado (posición previa) trunca a 0: "se quedó
    // menos que nada" no es un porcentaje.
    keptPct: Math.max(
      0,
      Math.round(((r.exercised - r.disposed) / r.exercised) * 100),
    ),
    filingUrl: r.filing_url,
    filedAt: r.filed_at,
  }));
}

// Net buying insider por símbolo para un set concreto — lo consume AI Picks
// v2 como señal extra de convicción. Map symbol → net $ (P - S, 7d).
export async function getInsiderNetBySymbols(
  symbols: string[],
  days = FLOW_DAYS,
): Promise<Map<string, number>> {
  if (!symbols.length) return new Map();
  const list = sql.join(
    symbols.map((s) => sql`${s}`),
    sql`, `,
  );
  const rows = unwrapRows<{ symbol: string; net_value: number }>(
    await db.execute(sql`
      SELECT symbol,
        (COALESCE(SUM(value) FILTER (WHERE tx_code = 'P'), 0)
          - COALESCE(SUM(value) FILTER (WHERE tx_code = 'S'), 0))::float AS net_value
      FROM insider_trades
      WHERE filed_at >= now() - (${days} || ' days')::interval
        AND tx_code IN ('P', 'S')
        AND symbol IN (${list})
      GROUP BY symbol
    `),
  );
  return new Map(rows.map((r) => [r.symbol, Number(r.net_value)]));
}
