// Yahoo Finance + Stooq fallback. Usamos los endpoints JSON públicos de
// Yahoo directamente (v8/finance/chart) — más fiable que yahoo-finance2
// desde server-side. Si Yahoo bloquea o el símbolo no existe, caemos a
// Stooq (CSV gratuito sin API key).

export type DailyBar = {
  time: number; // unix seconds (lightweight-charts compatible)
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export type Period = "1d" | "1w" | "1m" | "3m" | "1y";

const PERIOD_TO_YAHOO: Record<
  Period,
  { range: string; interval: string }
> = {
  "1d": { range: "1d", interval: "5m" },
  "1w": { range: "5d", interval: "30m" },
  "1m": { range: "1mo", interval: "1d" },
  "3m": { range: "3mo", interval: "1d" },
  "1y": { range: "1y", interval: "1d" },
};

const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";

type YahooChartResponse = {
  chart: {
    result?: Array<{
      timestamp?: number[];
      indicators: {
        quote: Array<{
          open: (number | null)[];
          high: (number | null)[];
          low: (number | null)[];
          close: (number | null)[];
          volume: (number | null)[];
        }>;
      };
    }>;
    error?: { code: string; description: string };
  };
};

async function fetchYahooChartFromHost(
  host: string,
  symbol: string,
  period: Period,
): Promise<DailyBar[]> {
  const cfg = PERIOD_TO_YAHOO[period];
  const url = new URL(
    `https://${host}/v8/finance/chart/${encodeURIComponent(symbol)}`,
  );
  url.searchParams.set("range", cfg.range);
  url.searchParams.set("interval", cfg.interval);
  url.searchParams.set("includePrePost", "false");

  const res = await fetch(url.toString(), {
    headers: { "User-Agent": BROWSER_UA, Accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  // Yahoo a veces responde 200 con texto plano "Too Many Requests" — chequea
  // content-type además del status.
  const ct = res.headers.get("content-type") ?? "";
  if (!res.ok || !ct.includes("json")) {
    throw new Error(`Yahoo ${host} ${res.status} (ct: ${ct.slice(0, 30)})`);
  }
  const json = (await res.json()) as YahooChartResponse;
  if (json.chart.error)
    throw new Error(`Yahoo error: ${json.chart.error.description}`);
  const result = json.chart.result?.[0];
  if (!result) return [];

  const ts = result.timestamp ?? [];
  const q = result.indicators.quote[0];
  const out: DailyBar[] = [];
  for (let i = 0; i < ts.length; i++) {
    const o = q.open[i],
      h = q.high[i],
      l = q.low[i],
      c = q.close[i],
      v = q.volume[i];
    if (o == null || h == null || l == null || c == null) continue;
    out.push({
      time: ts[i],
      open: o,
      high: h,
      low: l,
      close: c,
      volume: v ?? 0,
    });
  }
  return out;
}

const YAHOO_HOSTS = [
  "query2.finance.yahoo.com",
  "query1.finance.yahoo.com",
];

async function fetchYahooChart(
  symbol: string,
  period: Period,
): Promise<DailyBar[]> {
  let lastErr: unknown = null;
  for (const host of YAHOO_HOSTS) {
    try {
      const bars = await fetchYahooChartFromHost(host, symbol, period);
      if (bars.length > 0) return bars;
    } catch (err) {
      lastErr = err;
    }
  }
  if (lastErr) throw lastErr;
  return [];
}

export async function getBars(
  symbol: string,
  period: Period,
): Promise<DailyBar[]> {
  // 1) Yahoo (query2 → query1 fallback, ambos hosts).
  try {
    const bars = await fetchYahooChart(symbol, period);
    if (bars.length > 0) return bars;
  } catch (err) {
    console.warn(
      `[yahoo] ${symbol}/${period} failed:`,
      err instanceof Error ? err.message : err,
    );
  }

  // 2) Variante con dot → dash (BRK.B → BRK-B, BF.B → BF-B).
  if (symbol.includes(".")) {
    try {
      const alt = symbol.replace(/\./g, "-");
      const bars = await fetchYahooChart(alt, period);
      if (bars.length > 0) return bars;
    } catch {
      /* swallow */
    }
  }

  return [];
}

