import { sql } from "drizzle-orm";
import { db, unwrapRows } from "@/lib/db";
import { KIND_SPECS, type SignalKind } from "@/lib/signals/kinds";
import { getQuotesMap } from "@/lib/providers/finnhub";

// Detección de señales — corre en CADA tick del cron (Node y Worker-safe en
// lectura, pero solo se invoca desde el cron/refresher).
//
// La regla que gobierna todo el módulo: el registro es PROSPECTIVO. Una señal
// se escribe cuando Catalyst la habría enseñado, con el timestamp de ese
// momento, y jamás se reescribe. De ahí sale la limpieza metodológica del
// Lab: no hay forma de "elegir" a posteriori qué señales cuentan.
//
// Doble idempotencia (ver KIND_SPECS.cooldownDays): UNIQUE(kind,symbol,refId)
// para la señal exacta + cooldown por kind para la misma historia contada con
// otro refId.

export type SignalCandidate = {
  kind: SignalKind;
  symbol: string;
  refId: string;
  detectedAt: Date;
  meta?: Record<string, unknown>;
};

export type DetectResult = {
  inserted: number;
  byKind: Record<string, number>;
  durationMs: number;
};

// Ventanas de escaneo. Cortas a propósito: el tick corre cada 10min, así que
// mirar más atrás solo re-evalúa lo ya evaluado. El backfill histórico usa
// su propio camino (scripts/backfill-signals.ts).
const NEWS_LOOKBACK_HOURS = 24;
const STAKE_LOOKBACK_DAYS = 7;
const INSIDER_WINDOW_DAYS = 7;
const NET_BUY_MIN_USD = 1_000_000;
// Umbrales v1 del squeeze setup (el design doc los marca como "tuning TODO":
// el propio Lab dirá si hay que moverlos).
const SQUEEZE_MIN_DTC = 5;
const SQUEEZE_MIN_NEWS = 2;
const SQUEEZE_NEWS_DAYS = 7;
// Tope por tick. Holgado a propósito: el 2026-06-30 cualificaban 71 símbolos
// y con la quincena entera cabiendo en una pasada el registro no depende de
// cuántos ticks hayan corrido.
const SQUEEZE_MAX_PER_TICK = 200;
// Solo pedimos precio intradía a una señal que acaba de nacer: para un evento
// fechado horas atrás, el precio de AHORA no es "el precio al detectar".
const PRICE_FRESHNESS_MIN = 30;

function toDate(v: string | Date): Date {
  // El driver Neon devuelve los timestamps de `db.execute` crudo como STRING
  // (el query builder sí los mapea a Date) — normalizar siempre al leer.
  return v instanceof Date ? v : new Date(v);
}

// ─── Detectores por kind ─────────────────────────────────────────────────

// AI Picks: los símbolos del último lote generado. refId = id de la fila,
// así el mismo lote no se re-registra en cada tick; el cooldown de 3d evita
// que las ~6 regeneraciones diarias multipliquen la misma tesis.
async function detectAiPicks(): Promise<SignalCandidate[]> {
  const rows = unwrapRows<{
    id: number;
    content: string;
    generated_at: string | Date;
  }>(
    await db.execute(sql`
      SELECT id, content, generated_at FROM ai_picks
      WHERE generated_at >= now() - interval '24 hours'
      ORDER BY generated_at DESC LIMIT 1
    `),
  );
  const row = rows[0];
  if (!row) return [];
  let picks: Array<{ symbol?: string; thesis?: string }> = [];
  try {
    const parsed = JSON.parse(row.content);
    if (Array.isArray(parsed)) picks = parsed;
  } catch {
    return [];
  }
  const detectedAt = toDate(row.generated_at);
  return picks
    .filter((p) => typeof p.symbol === "string" && p.symbol.length > 0)
    .map((p) => ({
      kind: "ai_pick" as const,
      symbol: p.symbol!.toUpperCase(),
      refId: String(row.id),
      detectedAt,
      meta: { thesis: p.thesis?.slice(0, 240) },
    }));
}

// Upgrades/notas de analista con peso real. detectedAt = scored_at, no
// published_at: la señal existe cuando NOSOTROS la puntuamos y la mostramos.
// Con backlog de scoring eso puede ser horas después de publicarse — medir
// desde el scoring es lo honesto (es cuando el usuario pudo verla).
async function detectAnalystUpgrades(): Promise<SignalCandidate[]> {
  const rows = unwrapRows<{
    news_id: number;
    ticker: string;
    headline: string;
    impact: number;
    sentiment: number;
    scored_at: string | Date;
  }>(
    await db.execute(sql`
      SELECT n.id AS news_id, nt.ticker, n.headline, s.impact, s.sentiment,
        s.scored_at
      FROM news n
      JOIN news_scores s ON s.news_id = n.id
      JOIN news_tickers nt ON nt.news_id = n.id
      WHERE n.category = 'ANALYST'
        AND s.impact >= 4 AND s.sentiment >= 2
        AND s.scored_at >= now() - (${NEWS_LOOKBACK_HOURS} || ' hours')::interval
      ORDER BY s.scored_at DESC
      LIMIT 200
    `),
  );
  return rows.map((r) => ({
    kind: "analyst_upgrade" as const,
    symbol: r.ticker.toUpperCase(),
    refId: String(r.news_id),
    detectedAt: toDate(r.scored_at),
    meta: {
      headline: r.headline.slice(0, 200),
      impact: r.impact,
      sentiment: r.sentiment,
    },
  }));
}

// Nuevas participaciones activistas. Solo 13D (intención de influir); los
// 13G son pasivos y mucho más rutinarios — meterlos diluiría el kind.
async function detectStakes(): Promise<SignalCandidate[]> {
  const rows = unwrapRows<{
    symbol: string;
    filing_url: string;
    filer_name: string | null;
    percent_of_class: number | null;
    filed_at: string | Date;
  }>(
    await db.execute(sql`
      SELECT symbol, filing_url, filer_name, percent_of_class, filed_at
      FROM fund_stakes
      WHERE form_type LIKE 'SC 13D%'
        AND filed_at >= now() - (${STAKE_LOOKBACK_DAYS} || ' days')::interval
      ORDER BY filed_at DESC
      LIMIT 100
    `),
  );
  return rows.map((r) => ({
    kind: "stake_13d" as const,
    symbol: r.symbol.toUpperCase(),
    refId: r.filing_url,
    detectedAt: toDate(r.filed_at),
    meta: { filer: r.filer_name, percent: r.percent_of_class },
  }));
}

// Kinds de ventana RODANTE (cluster_buy, insider_net_buy): no hay un filing
// que sea "el evento" — la señal es el estado agregado de 7 días cruzando un
// umbral. refId = symbol:fecha del cruce, y el cooldown de 14d impide que un
// mismo episodio de compras se re-registre cada día que sigue cruzando.
async function detectInsiderWindows(): Promise<SignalCandidate[]> {
  const rows = unwrapRows<{
    symbol: string;
    buyers: number;
    buy_value: number;
    net_value: number;
    last_filed_at: string | Date;
  }>(
    await db.execute(sql`
      SELECT t.symbol,
        COUNT(DISTINCT t.owner_name) FILTER (WHERE t.tx_code = 'P')::int AS buyers,
        COALESCE(SUM(t.value) FILTER (WHERE t.tx_code = 'P'), 0)::float AS buy_value,
        (COALESCE(SUM(t.value) FILTER (WHERE t.tx_code = 'P'), 0)
          - COALESCE(SUM(t.value) FILTER (WHERE t.tx_code = 'S'), 0))::float AS net_value,
        MAX(t.filed_at) AS last_filed_at
      FROM insider_trades t
      WHERE t.filed_at >= now() - (${INSIDER_WINDOW_DAYS} || ' days')::interval
        AND t.tx_code IN ('P', 'S')
      GROUP BY t.symbol
      HAVING COUNT(DISTINCT t.owner_name) FILTER (WHERE t.tx_code = 'P') >= 2
        OR (COALESCE(SUM(t.value) FILTER (WHERE t.tx_code = 'P'), 0)
            - COALESCE(SUM(t.value) FILTER (WHERE t.tx_code = 'S'), 0)) >= ${NET_BUY_MIN_USD}
    `),
  );
  const out: SignalCandidate[] = [];
  for (const r of rows) {
    const detectedAt = toDate(r.last_filed_at);
    const day = detectedAt.toISOString().slice(0, 10);
    const symbol = r.symbol.toUpperCase();
    if (r.buyers >= 2) {
      out.push({
        kind: "cluster_buy",
        symbol,
        refId: `${symbol}:${day}`,
        detectedAt,
        meta: { buyers: r.buyers, buyValue: r.buy_value },
      });
    }
    if (r.net_value >= NET_BUY_MIN_USD) {
      out.push({
        kind: "insider_net_buy",
        symbol,
        refId: `${symbol}:${day}`,
        detectedAt,
        meta: { netValue: r.net_value },
      });
    }
  }
  return out;
}

// Author Watch: los valores del último brief diario del autor seguido.
async function detectAuthorCalls(): Promise<SignalCandidate[]> {
  const rows = unwrapRows<{
    id: number;
    content: string;
    generated_at: string | Date;
  }>(
    await db.execute(sql`
      SELECT id, content, generated_at FROM author_briefs
      WHERE generated_at >= now() - interval '48 hours'
      ORDER BY generated_at DESC LIMIT 1
    `),
  );
  const row = rows[0];
  if (!row) return [];
  let stocks: Array<{ symbol?: string; authorTake?: string }> = [];
  try {
    const parsed = JSON.parse(row.content) as { stocks?: unknown };
    if (Array.isArray(parsed.stocks)) stocks = parsed.stocks as typeof stocks;
  } catch {
    return [];
  }
  const detectedAt = toDate(row.generated_at);
  return stocks
    .filter((s) => typeof s.symbol === "string" && s.symbol.length > 0)
    .map((s) => ({
      kind: "author_call" as const,
      symbol: s.symbol!.toUpperCase(),
      refId: String(row.id),
      detectedAt,
      meta: { take: s.authorTake?.slice(0, 240) },
    }));
}

// ─── Escritura ───────────────────────────────────────────────────────────

// Precio intradía SOLO para candidatos recién nacidos. quotes_cache si está
// fresca (≤15min, gratis), si no un batch de Finnhub. Nunca bloquea: si no
// hay precio se guarda null — el campo es informativo y el retorno del Lab
// se calcula close-to-close, así que perderlo no degrada ninguna métrica.
async function resolvePrices(
  candidates: SignalCandidate[],
): Promise<Map<string, number>> {
  const fresh = candidates.filter(
    (c) =>
      Date.now() - c.detectedAt.getTime() < PRICE_FRESHNESS_MIN * 60_000,
  );
  const symbols = Array.from(new Set(fresh.map((c) => c.symbol)));
  const out = new Map<string, number>();
  if (!symbols.length) return out;

  const list = sql.join(
    symbols.map((s) => sql`${s}`),
    sql`, `,
  );
  try {
    const cached = unwrapRows<{ symbol: string; last_price: string | null }>(
      await db.execute(sql`
        SELECT symbol, last_price FROM quotes_cache
        WHERE symbol IN (${list})
          AND updated_at >= now() - interval '15 minutes'
      `),
    );
    for (const r of cached) {
      const p = Number(r.last_price);
      if (Number.isFinite(p) && p > 0) out.set(r.symbol.toUpperCase(), p);
    }
  } catch {
    /* cache miss no es un error — seguimos a Finnhub */
  }

  const missing = symbols.filter((s) => !out.has(s));
  if (missing.length) {
    try {
      const quotes = await getQuotesMap(missing);
      for (const [sym, q] of Object.entries(quotes)) {
        if (q && q.price > 0) out.set(sym.toUpperCase(), q.price);
      }
    } catch {
      /* sin precio: el evento se registra igual con null */
    }
  }
  return out;
}

// Insert-if-absent en UNA sentencia: el NOT EXISTS del cooldown va dentro del
// propio INSERT en vez de un check previo en JS, porque el cron GH y el
// refresher local corren a la vez contra la misma BD — un check-then-insert
// en dos viajes deja hueco para que ambos inserten el mismo episodio.
export async function insertSignalEvent(
  c: SignalCandidate,
  price: number | null,
): Promise<boolean> {
  const cooldownDays = KIND_SPECS[c.kind]?.cooldownDays ?? 0;
  const meta = c.meta ? JSON.stringify(c.meta) : null;
  // cooldown 0 = cada refId es un evento discreto real (un filing nuevo):
  // solo aplica la unicidad por refId.
  const cooldownClause =
    cooldownDays > 0
      ? sql`OR e.detected_at > ${c.detectedAt.toISOString()}::timestamptz
              - (${cooldownDays} || ' days')::interval`
      : sql``;
  const res = await db.execute(sql`
    INSERT INTO signal_events (kind, symbol, ref_id, detected_at, price_at_detection, meta)
    SELECT ${c.kind}, ${c.symbol}, ${c.refId},
      ${c.detectedAt.toISOString()}::timestamptz, ${price}, ${meta}
    WHERE EXISTS (SELECT 1 FROM tickers WHERE symbol = ${c.symbol})
      AND NOT EXISTS (
        SELECT 1 FROM signal_events e
        WHERE e.kind = ${c.kind} AND e.symbol = ${c.symbol}
          AND (e.ref_id = ${c.refId} ${cooldownClause})
      )
    ON CONFLICT DO NOTHING
    RETURNING id
  `);
  return unwrapRows<{ id: number }>(res).length > 0;
}

// Short squeeze setup: mucha posición corta que tardaría en deshacerse
// (days-to-cover de FINRA) + catalizadores alcistas recientes en NUESTRO tape.
//
// Por qué days-to-cover y no "% del float", que es la métrica de manual: el
// dataset de FINRA no trae free float y no tenemos fuente gratis fiable para
// todo el universo, así que el % del float exigiría inventarse el denominador
// (usar shares outstanding lo subestima y haría saltar la señal menos de lo
// debido, en silencio). DTC viene calculado por la propia FINRA y responde a
// la pregunta que importa: cuántas sesiones de volumen medio necesitarían los
// cortos para salir.
//
// detectedAt = ahora, NO la fecha de liquidación: el squeeze setup nace
// cuando se cumplen las dos patas, y la pata de noticias es de esta semana.
// Fechar la señal quincenas atrás sería lookahead puro (mediríamos el retorno
// desde antes de que la señal existiera).
async function detectShortSqueezeSetups(): Promise<SignalCandidate[]> {
  const rows = unwrapRows<{
    symbol: string;
    settlement_date: string;
    days_to_cover: number;
    current_short_qty: number;
    bullish: number;
  }>(
    await db.execute(sql`
      WITH latest AS (
        SELECT DISTINCT ON (symbol) symbol, settlement_date, days_to_cover,
               current_short_qty, market_class
        FROM short_interest
        ORDER BY symbol, settlement_date DESC
      )
      SELECT l.symbol, l.settlement_date, l.days_to_cover, l.current_short_qty,
             count(DISTINCT n.id)::int AS bullish
      FROM latest l
      JOIN news_tickers nt ON nt.ticker = l.symbol
      JOIN news n ON n.id = nt.news_id
      JOIN news_scores s ON s.news_id = n.id
      WHERE l.days_to_cover >= ${SQUEEZE_MIN_DTC}
        -- Fuera el OTC: los tickers *F son foreign ordinaries cuya negociación
        -- ocurre en su bolsa de origen, así que el volumen de aquí es una
        -- astilla del total y su days-to-cover sale disparado por artefacto,
        -- no por cortos apretados (IVPAF 146d, PEYUF 88d...). El Lab no
        -- reescribe nunca lo registrado: si esto entra, contamina para siempre.
        AND coalesce(l.market_class, '') <> 'OTC'
        AND s.sentiment >= 2 AND s.impact >= 3
        AND s.scored_at >= now() - (${SQUEEZE_NEWS_DAYS} || ' days')::interval
      GROUP BY l.symbol, l.settlement_date, l.days_to_cover, l.current_short_qty
      HAVING count(DISTINCT n.id) >= ${SQUEEZE_MIN_NEWS}
      -- ORDER BY explícito: con un LIMIT sin orden, qué símbolos entran es
      -- indeterminado y el registro del Lab dependería del plan de Postgres.
      ORDER BY l.days_to_cover DESC
      LIMIT ${SQUEEZE_MAX_PER_TICK}
    `),
  );
  if (rows.length === SQUEEZE_MAX_PER_TICK) {
    console.warn(
      `[signals] short_squeeze_setup tocó el tope de ${SQUEEZE_MAX_PER_TICK} candidatos — el resto entra en el siguiente tick`,
    );
  }
  const detectedAt = new Date();
  return rows.map((r) => ({
    kind: "short_squeeze_setup" as const,
    symbol: r.symbol.toUpperCase(),
    // refId = símbolo + quincena: dentro de la misma foto de FINRA la señal
    // es la MISMA observación por mucho que sigan entrando noticias.
    refId: `${r.symbol}:${r.settlement_date}`,
    detectedAt,
    meta: {
      settlementDate: r.settlement_date,
      daysToCover: r.days_to_cover,
      shortQty: r.current_short_qty,
      bullishStories: r.bullish,
    },
  }));
}

export async function runDetectSignalsCron(): Promise<DetectResult> {
  const t0 = Date.now();
  const byKind: Record<string, number> = {};
  let inserted = 0;

  // Una fuente caída no puede tumbar las demás (misma regla que el fan-out
  // de providers en refresh-news).
  const settled = await Promise.allSettled([
    detectAiPicks(),
    detectAnalystUpgrades(),
    detectStakes(),
    detectInsiderWindows(),
    detectAuthorCalls(),
    detectShortSqueezeSetups(),
  ]);
  const candidates: SignalCandidate[] = [];
  for (const s of settled) {
    if (s.status === "fulfilled") candidates.push(...s.value);
    else console.warn("[signals] detector failed:", s.reason);
  }
  if (!candidates.length) {
    return { inserted: 0, byKind, durationMs: Date.now() - t0 };
  }

  const prices = await resolvePrices(candidates);

  // Orden cronológico: con cooldown, el primer evento del episodio debe ser
  // el más antiguo (si insertáramos el reciente primero, el viejo quedaría
  // suprimido y el track record empezaría a contar tarde).
  candidates.sort((a, b) => a.detectedAt.getTime() - b.detectedAt.getTime());

  for (const c of candidates) {
    try {
      const ok = await insertSignalEvent(c, prices.get(c.symbol) ?? null);
      if (ok) {
        inserted++;
        byKind[c.kind] = (byKind[c.kind] ?? 0) + 1;
      }
    } catch (err) {
      console.warn(
        `[signals] insert ${c.kind}/${c.symbol} failed:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  return { inserted, byKind, durationMs: Date.now() - t0 };
}
