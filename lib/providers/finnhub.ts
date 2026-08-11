import { sql } from "drizzle-orm";
import type { NormalizedNewsItem } from "@/lib/types";
import { hashUrl } from "@/lib/hash";
import { db } from "@/lib/db";
import { createRateLimiter } from "@/lib/providers/rate-limit";
import { getYahooQuote } from "@/lib/providers/yahoo";

const BASE = "https://finnhub.io/api/v1";

function key() {
  const k = process.env.FINNHUB_API_KEY;
  if (!k) throw new Error("FINNHUB_API_KEY is not set");
  return k;
}

/** Error de transporte/HTTP de Finnhub. Existe para que el llamante pueda
 *  distinguir "la API respondió que no hay dato" de "no pudimos preguntar":
 *  el enricher marcaba `enriched_at` en los dos casos y un 429 dejaba al
 *  ticker sin nombre ni logo PARA SIEMPRE (la query de pendientes es
 *  `enriched_at IS NULL`). */
export class FinnhubError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "FinnhubError";
  }
}

// --- Freno de tasa COMPARTIDO -------------------------------------------
// Finnhub free = 60 req/min para toda la key. Hasta el 2026-08-01 cada
// camino tenía su propia concurrencia local (company-news 8, enricher 4,
// quotes 5, earnings 3) calculada contra un presupuesto que NADIE hacía
// cumplir: el refresher acumuló 7.048 respuestas 429 en 50 ticks, TODAS de
// /quote, porque el Signal Lab pedía ~141 precios de golpe. El freno vive
// aquí porque `fh()` es el único punto por el que pasan los cinco caminos.
//
// Cubo de fichas (`lib/providers/rate-limit.ts`): ráfaga hasta el cupo y
// MAX_RPM sostenidas. El porqué del algoritmo está allí; lo que importa aquí
// es que el cupo es el de la key entera, compartido por los cinco caminos.
//
// El tope de 30 req/s de Finnhub no hace falta acotarlo por separado: ningún
// llamante pasa de 8 peticiones en vuelo (company-news 8, quotes 5, enricher
// 4, earnings 3), así que la ráfaga nunca puede acercarse.
const MAX_RPM = Math.max(1, Number(process.env.FINNHUB_MAX_RPM ?? 55));
const limiter = createRateLimiter({ maxPerMinute: MAX_RPM });

// Enfriamiento tras un 429, mismo patrón que los pools de OpenRouter/Gemini:
// sin esto un 429 se trataba igual que un 500 (throw y a otra cosa) y el
// tick seguía martilleando la API ya saturada durante minutos.
//
// En memoria del módulo, como los demás proveedores hoy: cada proceso lo
// redescubre. Si algún día se activa `lib/providers/cooldown-store.ts` (hoy
// inerte, le falta la tabla), esto entra ahí con scope 'finnhub'.
const DEFAULT_COOLDOWN_MS = 60_000;
let cooldownUntil = 0;

/** Ms que quedan de enfriamiento por 429. 0 = key disponible. Para /api/health. */
export function finnhubCooldownMs(): number {
  return Math.max(0, cooldownUntil - Date.now());
}

function applyRateLimit(res: Response): void {
  // `Retry-After` puede venir en segundos; si no viene, un minuto es la
  // ventana natural del límite de Finnhub (60/min).
  const retryAfter = Number(res.headers.get("retry-after"));
  const ms =
    Number.isFinite(retryAfter) && retryAfter > 0
      ? retryAfter * 1000
      : DEFAULT_COOLDOWN_MS;
  cooldownUntil = Math.max(cooldownUntil, Date.now() + ms);
}

type FinnhubNews = {
  category: string;
  datetime: number; // unix seconds
  headline: string;
  id: number;
  image: string;
  related: string; // CSV de tickers — "AAPL,MSFT"
  source: string;
  summary: string;
  url: string;
};

async function fh<T>(
  path: string,
  params: Record<string, string> = {},
  timeoutMs = 10_000,
): Promise<T> {
  const url = new URL(`${BASE}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set("token", key());
  // Con la key enfriada ni se pregunta: seguir pidiendo durante un 429 es lo
  // que convertía una ráfaga en miles de líneas de log y cero datos.
  const cooling = finnhubCooldownMs();
  if (cooling > 0) {
    throw new FinnhubError(
      `Finnhub ${path} skipped: key enfriada ${Math.ceil(cooling / 1000)}s por 429`,
      429,
    );
  }
  await limiter.reserve();
  const res = await fetch(url.toString(), {
    headers: { "User-Agent": "catalyst-local/0.1" },
    // Sin timeout, una conexión colgada retiene el tick del cron entero
    // hasta el wall-clock del runner.
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    if (res.status === 429) applyRateLimit(res);
    throw new FinnhubError(
      `Finnhub ${path} failed: ${res.status} ${res.statusText}`,
      res.status,
    );
  }
  return res.json() as Promise<T>;
}

// Noticias generales (motor del feed). Solo categorías de equities — el
// usuario pidió excluir crypto y forex.
const CATEGORIES = ["general", "merger"] as const;

export async function fetchGeneralNews(): Promise<NormalizedNewsItem[]> {
  const results = await Promise.allSettled(
    CATEGORIES.map((cat) => fh<FinnhubNews[]>("/news", { category: cat })),
  );
  const out: NormalizedNewsItem[] = [];
  results.forEach((r, i) => {
    if (r.status === "fulfilled") {
      out.push(...r.value.map(toNormalized));
    } else {
      // Sin este log el motor del feed podía morir entero en silencio: la
      // promesa sale `fulfilled` con `[]`, así que el warn de refresh-news
      // no dispara y `fetched.finnhub: 0` es indistinguible de "hoy no hubo
      // noticias generales".
      console.warn(
        `[finnhub] general/${CATEGORIES[i]} failed:`,
        r.reason instanceof Error ? r.reason.message : r.reason,
      );
    }
  });
  return out;
}

// Noticias específicas de un ticker en los últimos N días.
export async function fetchCompanyNews(
  symbol: string,
  days = 7,
): Promise<NormalizedNewsItem[]> {
  const to = new Date();
  const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);
  const items = await fh<FinnhubNews[]>("/company-news", {
    symbol,
    from: from.toISOString().slice(0, 10),
    to: to.toISOString().slice(0, 10),
  });
  return items.map(toNormalized);
}

// Log throttle por símbolo (audit 2026-05-12 #8): antes el catch desnudo
// enmascaraba 403/500 globales — el cron salía con "fetched.finnhubCompany=0"
// sin pista de la causa. Con TTL 5min por símbolo evitamos spam si Finnhub
// está caído (5min × ~60 símbolos = log cap razonable).
const lastErrorLog = new Map<string, number>();
const ERROR_LOG_TTL_MS = 5 * 60 * 1000;
function maybeLogFinnhubError(symbol: string, err: unknown) {
  const now = Date.now();
  const prev = lastErrorLog.get(symbol);
  if (prev && now - prev < ERROR_LOG_TTL_MS) return;
  lastErrorLog.set(symbol, now);
  const msg = err instanceof Error ? err.message : String(err);
  console.warn(`[finnhub] ${symbol} failed: ${msg.slice(0, 200)}`);
}

// Bulk: noticias para varios tickers a la vez. Respeta el rate-limit de
// Finnhub (60 req/min) usando un semáforo de concurrencia 8 con 100ms de
// espaciado entre requests dentro del mismo "slot".
export async function fetchCompanyNewsBatch(
  symbols: string[],
  days = 3,
): Promise<NormalizedNewsItem[]> {
  const out: NormalizedNewsItem[] = [];
  const queue = [...symbols];
  const concurrency = 8;
  const workers = Array.from({ length: concurrency }, async () => {
    while (queue.length) {
      const sym = queue.shift();
      if (!sym) break;
      try {
        const items = await fetchCompanyNews(sym, days);
        out.push(...items);
      } catch (err) {
        maybeLogFinnhubError(`company-news:${sym}`, err);
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  });
  await Promise.all(workers);
  return out;
}

function toNormalized(n: FinnhubNews): NormalizedNewsItem {
  const apiTickers = (n.related || "")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  return {
    url: n.url,
    hash: hashUrl(n.url),
    headline: n.headline,
    source: `finnhub:${n.source}`.slice(0, 64),
    publishedAt: new Date(n.datetime * 1000),
    body: n.summary || undefined,
    imageUrl: n.image || undefined,
    apiTickers,
  };
}

// --- Search & enrichment -------------------------------------------------

export type FinnhubSearchResult = {
  symbol: string;
  description: string;
  type: string;
  displaySymbol: string;
};

export async function searchSymbols(
  query: string,
): Promise<FinnhubSearchResult[]> {
  const data = await fh<{ count: number; result: FinnhubSearchResult[] }>(
    "/search",
    { q: query, exchange: "US" },
  );
  return data.result || [];
}

export type FinnhubProfile = {
  ticker: string;
  name: string;
  finnhubIndustry: string;
  marketCapitalization: number; // millones
  exchange: string;
  country: string;
  currency: string;
  weburl: string;
  logo: string;
};

/**
 * `null` = Finnhub respondió y NO tiene perfil de ese símbolo (foreign, OTC).
 * LANZA si la petición falló (429, red, timeout): son cosas distintas y el
 * enricher necesita distinguirlas — marcar `enriched_at` tras un 429 deja al
 * ticker sin nombre, sin logo y sin alias para siempre. Los llamantes que no
 * puedan reintentar ya traen su propio `.catch(() => null)`.
 */
export async function getProfile(symbol: string): Promise<FinnhubProfile | null> {
  const p = await fh<FinnhubProfile>("/stock/profile2", { symbol });
  if (!p || !p.ticker) return null;
  return p;
}

export type FinnhubQuote = {
  c: number; // current
  d: number; // change
  dp: number; // change percent
  h: number; // high
  l: number; // low
  o: number; // open
  pc: number; // previous close
  t: number; // unix
};

export async function getQuote(symbol: string): Promise<FinnhubQuote | null> {
  try {
    // 3s y no los 10 genéricos: /quote está en el camino del SSR y tiene
    // fallback vivo (Yahoo) — con Finnhub caído (2026-08-06: timeouts+503 en
    // serie), cada símbolo pagaba el timeout entero ANTES del fallback y la
    // home tardaba 17-21s. Un quote que tarda >3s no vale para pintar precio.
    return await fh<FinnhubQuote>("/quote", { symbol }, 3_000);
  } catch (err) {
    // Mismo throttle que company-news: sin esto un fallo de /quote (p.ej.
    // TODOS los quotes a null en el Worker) era invisible — la watchlist
    // se quedaba en "—" sin una sola línea de log en ningún sitio.
    maybeLogFinnhubError(`quote:${symbol}`, err);
    // Fallback Yahoo: Finnhub responde 429 POR IP a los egress de Cloudflare
    // (todos los quotes del Worker morían), y Yahoo es su espejo exacto —
    // funciona desde CF y ratelimita al Mac/GH, donde a cambio Finnhub va
    // bien. Entre los dos, cada contexto tiene siempre una fuente viva.
    const y = await getYahooQuote(symbol).catch(() => null);
    if (!y) return null;
    return {
      c: y.price,
      d: y.change,
      dp: y.changePercent,
      h: y.high ?? y.price,
      l: y.low ?? y.price,
      o: y.open ?? y.prevClose,
      pc: y.prevClose,
      t: Math.floor(Date.now() / 1000),
    };
  }
}

export type FinnhubEarningsEvent = {
  symbol: string;
  date: string; // yyyy-mm-dd
  hour: string; // bmo | amc | dmh | ""
  quarter: number | null;
  year: number | null;
  epsEstimate: number | null;
  revenueEstimate: number | null;
};

// Próximos earnings de un símbolo (horizonte `days`). Free tier incluye
// /calendar/earnings. Devuelve `[]` = "Finnhub respondió, sin earnings en el
// horizonte" (resultado real) vs `null` = "el fetch falló" — el caller de la
// cache NO debe borrar filas buenas por un 429/red transitorio.
export async function getEarningsCalendar(
  symbol: string,
  days = 90,
): Promise<FinnhubEarningsEvent[] | null> {
  const from = new Date().toISOString().slice(0, 10);
  const to = new Date(Date.now() + days * 86400_000).toISOString().slice(0, 10);
  return getEarningsCalendarRange(symbol, from, to);
}

/** Calendario en un rango ARBITRARIO — el pasado incluido: Finnhub sirve
 *  las estimaciones históricas, que es lo que usa el backfill de snapshots
 *  de consenso (`scripts/backfill-earnings-estimates.ts`). */
export async function getEarningsCalendarRange(
  symbol: string,
  from: string,
  to: string,
): Promise<FinnhubEarningsEvent[] | null> {
  try {
    const data = await fh<{
      earningsCalendar?: Array<{
        symbol: string;
        date: string;
        hour?: string;
        quarter?: number;
        year?: number;
        epsEstimate?: number | null;
        revenueEstimate?: number | null;
      }>;
    }>("/calendar/earnings", { from, to, symbol });
    return (data.earningsCalendar ?? []).map((e) => ({
      symbol: e.symbol,
      date: e.date,
      hour: e.hour ?? "",
      quarter: e.quarter ?? null,
      year: e.year ?? null,
      epsEstimate: e.epsEstimate ?? null,
      revenueEstimate: e.revenueEstimate ?? null,
    }));
  } catch {
    return null; // fetch falló — distinto de "sin earnings"
  }
}

/** Punto de una serie histórica de `/stock/metric`. Finnhub los devuelve
 *  del MÁS RECIENTE al más antiguo (medido 2026-08-11: MSFT trimestral va de
 *  2026-06-30 a 1990-03-31) — quien consuma esto no debe asumir orden
 *  ascendente. */
export type MetricPoint = { period: string; v: number };

/** Respuesta cruda de `/stock/metric?metric=all`. Se tipa laxo a propósito:
 *  son 133 claves cuyo conjunto cambia por empresa (un banco no trae
 *  `grossMarginTTM`), así que un tipo cerrado mentiría. La forma se impone
 *  en `lib/metrics/derive.ts`, que es quien decide qué se lee y qué se tira. */
export type FinnhubBasicFinancials = {
  metric: Record<string, unknown>;
  series: {
    annual?: Record<string, MetricPoint[]>;
    quarterly?: Record<string, MetricPoint[]>;
  };
};

/** Fundamentales completos de un símbolo — UNA llamada del free tier que trae
 *  133 ratios (forward P/E, PEG, EV/EBITDA, ROIC, márgenes, crecimiento) MÁS
 *  las series anual y trimestral de ~40 de ellos. Verificado en free tier el
 *  2026-08-11; sus vecinos `price-target`, `eps-estimate` y `revenue-estimate`
 *  responden 403 en el mismo plan, así que el consenso PROSPECTIVO que
 *  tenemos es el que ya viene embebido aquí (`forwardPE`, `forwardPEG`).
 *
 *  Ojo con el tamaño: ~240 kB por símbolo (la serie trimestral de MSFT son
 *  146 puntos × 41 métricas). Por eso el timeout sube a 15s y por eso NUNCA
 *  se guarda cruda — ver `lib/metrics/derive.ts`.
 *
 *  `null` = el fetch falló (429/red), igual que el calendario: el caller de
 *  la cache no debe borrar una fila buena por un corte transitorio. */
export async function getBasicFinancials(
  symbol: string,
): Promise<FinnhubBasicFinancials | null> {
  try {
    const data = await fh<Partial<FinnhubBasicFinancials>>(
      "/stock/metric",
      { symbol: symbol.toUpperCase(), metric: "all" },
      15_000,
    );
    // Símbolo sin cobertura: Finnhub responde 200 con `{"metric":{},"series":{}}`
    // o directamente sin las claves. Es una respuesta REAL ("no hay dato"),
    // no un fallo, así que devuelve un objeto vacío y no `null` — el caller
    // marca el intento y no lo re-pregunta en cada tick.
    return {
      metric: (data.metric ?? {}) as Record<string, unknown>,
      series: data.series ?? {},
    };
  } catch {
    return null;
  }
}

export type CompactQuote = {
  price: number;
  change: number;
  changePercent: number;
  prevClose: number;
};

// Fetch concurrente de quotes para múltiples símbolos respetando la cuota
// free de Finnhub (60/min). Concurrencia=5 mantiene latencia ~1s para 10
// símbolos. Inválidos / vacíos vuelven como null (Finnhub devuelve c=0).
// Reutilizado por /api/quotes y por SSR de páginas con watchlist.
export async function getQuotesMap(
  symbols: string[],
): Promise<Record<string, CompactQuote | null>> {
  const unique = Array.from(new Set(symbols.map((s) => s.toUpperCase()))).filter(
    (s) => /^[A-Z0-9.\-]{1,10}$/.test(s),
  );
  const out: Record<string, CompactQuote | null> = {};
  const CONCURRENCY = 5;
  let cursor = 0;
  async function worker() {
    while (cursor < unique.length) {
      const i = cursor++;
      const sym = unique[i];
      const q = await getQuote(sym);
      out[sym] = q && q.c > 0
        ? { price: q.c, change: q.d, changePercent: q.dp, prevClose: q.pc }
        : null;
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  await writeQuotesCache(out);
  return out;
}

/**
 * Vuelca lo cotizado a `quotes_cache`. Esta función es el ÚNICO embudo de
 * quotes del proyecto, así que es el sitio donde la caché se puede llenar.
 *
 * Hasta el 2026-08-01 la tabla no la escribía NADIE (lo decía ya un
 * comentario en /api/portfolio-review), así que la lectura con frescura de
 * 15min de `lib/signals/detect.ts` fallaba siempre y el 100% de los
 * candidatos caía al fetch — la otra mitad de la tormenta de 429.
 *
 * Best-effort a propósito: `symbol` tiene FK a `tickers` y aquí entran
 * símbolos de watchlist que pueden no estar en el universo todavía. Un fallo
 * al cachear no puede tumbar la respuesta de precios de nadie.
 */
async function writeQuotesCache(
  quotes: Record<string, CompactQuote | null>,
): Promise<void> {
  const rows = Object.entries(quotes).filter(
    (e): e is [string, CompactQuote] => e[1] !== null,
  );
  if (!rows.length) return;
  try {
    const values = sql.join(
      rows.map(
        ([sym, q]) =>
          sql`(${sym}::text, ${String(q.price)}::text, ${String(q.changePercent)}::text)`,
      ),
      sql`, `,
    );
    await db.execute(sql`
      INSERT INTO quotes_cache (symbol, last_price, change_pct, updated_at)
      SELECT v.symbol, v.last_price, v.change_pct, now()
      FROM (VALUES ${values}) AS v(symbol, last_price, change_pct)
      WHERE EXISTS (SELECT 1 FROM tickers t WHERE t.symbol = v.symbol)
      ON CONFLICT (symbol) DO UPDATE SET
        last_price = EXCLUDED.last_price,
        change_pct = EXCLUDED.change_pct,
        updated_at = now()
    `);
  } catch (err) {
    console.warn(
      "[finnhub] quotes_cache write failed:",
      err instanceof Error ? err.message.slice(0, 140) : err,
    );
  }
}
