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

// ─── Quote intradía (fallback de Finnhub) ────────────────────────────────
// Finnhub responde 429 POR IP a los egress de Cloudflare Workers (verificado
// 2026-07-21 con wrangler tail: todos los /quote fallaban en el Worker
// mientras la misma key iba bien desde el Mac). Yahoo es el espejo exacto
// (429 al Mac/GH, normal desde CF — ver lib/signals/prices.ts), así que el
// quote del Worker sale del meta del chart v8, misma fuente que las velas.

export type YahooQuote = {
  price: number;
  change: number;
  changePercent: number;
  prevClose: number;
  high: number | null;
  low: number | null;
  open: number | null;
};

type YahooQuoteMeta = {
  regularMarketPrice?: number;
  chartPreviousClose?: number;
  previousClose?: number;
  regularMarketDayHigh?: number;
  regularMarketDayLow?: number;
};

export async function getYahooQuote(symbol: string): Promise<YahooQuote | null> {
  for (const host of YAHOO_HOSTS) {
    try {
      const url = new URL(
        `https://${host}/v8/finance/chart/${encodeURIComponent(symbol)}`,
      );
      url.searchParams.set("range", "1d");
      url.searchParams.set("interval", "1d");
      url.searchParams.set("includePrePost", "false");
      const res = await fetch(url.toString(), {
        headers: { "User-Agent": BROWSER_UA, Accept: "application/json" },
        signal: AbortSignal.timeout(10_000),
      });
      const ct = res.headers.get("content-type") ?? "";
      if (!res.ok || !ct.includes("json")) continue;
      const json = (await res.json()) as YahooChartResponse & {
        chart: { result?: Array<{ meta?: YahooQuoteMeta }> };
      };
      const result = json.chart.result?.[0];
      const meta = result?.meta;
      const price = meta?.regularMarketPrice;
      const prev = meta?.chartPreviousClose ?? meta?.previousClose;
      if (typeof price !== "number" || typeof prev !== "number" || prev <= 0) {
        continue;
      }
      const day = result?.indicators?.quote?.[0];
      return {
        price,
        change: price - prev,
        changePercent: ((price - prev) / prev) * 100,
        prevClose: prev,
        high: meta?.regularMarketDayHigh ?? day?.high?.[0] ?? null,
        low: meta?.regularMarketDayLow ?? day?.low?.[0] ?? null,
        open: day?.open?.[0] ?? null,
      };
    } catch {
      continue;
    }
  }
  return null;
}

// ─── Serie diaria de cierres AJUSTADOS (Signal Lab) ──────────────────────
// El chart v8 acepta period1/period2 (unix segundos) además de `range`, y con
// interval=1d devuelve `indicators.adjclose` — cierres back-ajustados por
// splits y dividendos. Es lo que necesita el Lab: con `close` crudo, un split
// 2:1 se leería como un -50% de retorno.

export type AdjCloseSeries = {
  // Fechas de SESIÓN REAL en orden ascendente (yyyy-mm-dd, calendario ET).
  // Son las sesiones que de verdad ocurrieron, así que contar "días hábiles"
  // sobre este array maneja festivos de mercado sin calendario propio.
  dates: string[];
  closes: Map<string, number>;
};

// Fecha de calendario de Nueva York para un instante dado. Las barras diarias
// de Yahoo vienen con el timestamp de la APERTURA en ET, así que convertir en
// UTC desplazaría de día las sesiones (09:30 ET = 14:30 UTC va bien, pero el
// borde de fin de mes no perdona).
export function etDateString(ms: number): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(ms));
}

// Hora ET (0-23) — para saber si una señal nació después del cierre (16:00).
export function etHour(ms: number): number {
  return Number(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      hour: "2-digit",
      hour12: false,
    }).format(new Date(ms)),
  );
}

type YahooAdjResponse = {
  chart: {
    result?: Array<{
      timestamp?: number[];
      indicators: {
        quote: Array<{ close: (number | null)[] }>;
        adjclose?: Array<{ adjclose: (number | null)[] }>;
      };
    }>;
    error?: { code: string; description: string };
  };
};

async function fetchAdjClosesFromHost(
  host: string,
  symbol: string,
  fromMs: number,
): Promise<AdjCloseSeries> {
  const url = new URL(
    `https://${host}/v8/finance/chart/${encodeURIComponent(symbol)}`,
  );
  // Margen hacia atrás: la baseline puede caer en un festivo largo y hay que
  // tener sesiones anteriores en la serie para localizarla.
  url.searchParams.set(
    "period1",
    String(Math.floor(fromMs / 1000) - 10 * 86_400),
  );
  url.searchParams.set("period2", String(Math.floor(Date.now() / 1000)));
  url.searchParams.set("interval", "1d");
  url.searchParams.set("events", "div,split");
  url.searchParams.set("includeAdjustedClose", "true");

  const res = await fetch(url.toString(), {
    headers: { "User-Agent": BROWSER_UA, Accept: "application/json" },
    signal: AbortSignal.timeout(12_000),
  });
  const ct = res.headers.get("content-type") ?? "";
  if (!res.ok || !ct.includes("json")) {
    throw new Error(`Yahoo ${host} ${res.status} (ct: ${ct.slice(0, 30)})`);
  }
  const json = (await res.json()) as YahooAdjResponse;
  if (json.chart.error) throw new Error(`Yahoo: ${json.chart.error.description}`);
  const result = json.chart.result?.[0];
  if (!result) return { dates: [], closes: new Map() };

  const ts = result.timestamp ?? [];
  const adj = result.indicators.adjclose?.[0]?.adjclose;
  const raw = result.indicators.quote[0]?.close;
  const dates: string[] = [];
  const closes = new Map<string, number>();
  for (let i = 0; i < ts.length; i++) {
    // adjclose es lo correcto; si Yahoo no lo manda (pasa en algún símbolo
    // exótico) caemos a close crudo — mejor un dato que ninguno, y el
    // sesgo por split es raro y visible.
    const c = adj?.[i] ?? raw?.[i];
    if (c == null || !Number.isFinite(c)) continue;
    const day = etDateString(ts[i] * 1000);
    if (!closes.has(day)) dates.push(day);
    closes.set(day, c);
  }
  return { dates, closes };
}

// Cierres ajustados diarios desde `fromMs` hasta hoy. Devuelve series vacía
// (no lanza) si el símbolo no existe o Yahoo bloquea — el caller cuenta el
// intento y reintenta mañana.
export async function getDailyAdjCloses(
  symbol: string,
  fromMs: number,
): Promise<AdjCloseSeries> {
  const variants = symbol.includes(".")
    ? [symbol, symbol.replace(/\./g, "-")]
    : [symbol];
  let lastErr: unknown = null;
  for (const sym of variants) {
    for (const host of YAHOO_HOSTS) {
      try {
        const series = await fetchAdjClosesFromHost(host, sym, fromMs);
        if (series.dates.length > 0) return series;
      } catch (err) {
        lastErr = err;
      }
    }
  }
  if (lastErr) {
    console.warn(
      `[yahoo] adjcloses ${symbol} failed:`,
      lastErr instanceof Error ? lastErr.message : lastErr,
    );
  }
  return { dates: [], closes: new Map() };
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

  // 3) El mismo Yahoo, pero desde una IP que no esté limitada. El límite de
  // Yahoo es POR IP y asimétrico: 429 a todo desde la IP del usuario (chart
  // Y rss) mientras responde normal desde Cloudflare. Sin esto, el daemon
  // local —que es el que se usa a diario vía Catalyst.app— pinta los
  // gráficos vacíos aunque el Worker público los tenga.
  const bars = await fetchBarsViaProxy(symbol, period);
  return bars;
}

// Proxy al /api/bars de nuestro propio Worker. DOBLE guard anti-recursión:
// la env var no se sube nunca al Worker Y se detecta el runtime workerd —
// sin esto, el Worker se llamaría a sí mismo en bucle.
async function fetchBarsViaProxy(
  symbol: string,
  period: Period,
): Promise<DailyBar[]> {
  const base = process.env.LAB_PRICE_PROXY_URL;
  if (!base) return [];
  if (typeof (globalThis as { WebSocketPair?: unknown }).WebSocketPair !== "undefined") {
    return [];
  }
  try {
    const url = `${base.replace(/\/$/, "")}/api/bars?symbol=${encodeURIComponent(symbol)}&period=${period}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(12_000) });
    if (!res.ok) throw new Error(`proxy ${res.status}`);
    const json = (await res.json()) as { bars?: DailyBar[] };
    return json.bars ?? [];
  } catch (err) {
    console.warn(
      `[yahoo] ${symbol}/${period} proxy falló:`,
      err instanceof Error ? err.message : err,
    );
    return [];
  }
}

