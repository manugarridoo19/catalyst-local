// Capa fina sobre yahoo-finance2 — la usamos como fallback para datos que
// Finnhub free no cubre (histórico de precios para charts, fundamentales
// extras). NO la usamos en el cron principal de noticias.
//
// La librería tiene una API tipada compleja; usamos `any` localmente para
// no acoplar nuestro código a internos que cambian entre versiones.

import yahooFinance from "yahoo-finance2";

export type DailyBar = {
  date: Date;
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

export async function getDailyBars(
  symbol: string,
  days = 90,
): Promise<DailyBar[]> {
  const period2 = new Date();
  const period1 = new Date(period2.getTime() - days * 24 * 60 * 60 * 1000);
  const result = (await (yahooFinance as unknown as {
    chart: (s: string, o: { period1: Date; period2: Date; interval: string }) => Promise<{ quotes?: ChartQuote[] }>;
  }).chart(symbol, {
    period1,
    period2,
    interval: "1d",
  })) || { quotes: [] };

  const out: DailyBar[] = [];
  for (const q of result.quotes ?? []) {
    if (
      q.date == null ||
      q.open == null ||
      q.high == null ||
      q.low == null ||
      q.close == null ||
      q.volume == null
    )
      continue;
    out.push({
      date: q.date,
      open: q.open,
      high: q.high,
      low: q.low,
      close: q.close,
      volume: q.volume,
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
