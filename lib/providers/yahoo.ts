// Capa fina sobre yahoo-finance2 — la usamos como fallback para datos que
// Finnhub free no cubre (histórico de precios para charts, fundamentales
// extras). NO la usamos en el cron principal de noticias.

import yahooFinance from "yahoo-finance2";

export type DailyBar = {
  time: number; // unix seconds (lightweight-charts compatible)
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

type ChartQuote = {
  date?: Date;
  open?: number | null;
  high?: number | null;
  low?: number | null;
  close?: number | null;
  volume?: number | null;
};

export type Period = "1d" | "1w" | "1m" | "3m" | "1y";

const PERIOD_CONFIG: Record<
  Period,
  { days: number; interval: "1m" | "5m" | "15m" | "1h" | "1d" }
> = {
  "1d": { days: 1, interval: "5m" },
  "1w": { days: 7, interval: "15m" },
  "1m": { days: 31, interval: "1h" },
  "3m": { days: 93, interval: "1d" },
  "1y": { days: 365, interval: "1d" },
};

export async function getBars(
  symbol: string,
  period: Period,
): Promise<DailyBar[]> {
  const cfg = PERIOD_CONFIG[period];
  const period2 = new Date();
  const period1 = new Date(period2.getTime() - cfg.days * 24 * 60 * 60 * 1000);

  const result = (await (yahooFinance as unknown as {
    chart: (
      s: string,
      o: { period1: Date; period2: Date; interval: string },
    ) => Promise<{ quotes?: ChartQuote[] }>;
  }).chart(symbol, {
    period1,
    period2,
    interval: cfg.interval,
  })) || { quotes: [] };

  const out: DailyBar[] = [];
  for (const q of result.quotes ?? []) {
    if (
      q.date == null ||
      q.open == null ||
      q.high == null ||
      q.low == null ||
      q.close == null
    )
      continue;
    out.push({
      time: Math.floor(q.date.getTime() / 1000),
      open: q.open,
      high: q.high,
      low: q.low,
      close: q.close,
      volume: q.volume ?? 0,
    });
  }
  return out;
}

export async function getQuoteSnapshot(symbol: string) {
  try {
    return await (yahooFinance as unknown as {
      quote: (s: string) => Promise<unknown>;
    }).quote(symbol);
  } catch {
    return null;
  }
}
