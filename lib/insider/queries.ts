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
