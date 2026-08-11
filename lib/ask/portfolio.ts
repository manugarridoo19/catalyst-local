// Retrieval para la revisión de cartera. Solo LECTURA de BD — Workers-safe.
//
// Es el hermano prospectivo de `lib/ask/retrieve.ts`. La diferencia no es
// de tamaño sino de EJE:
//
//   retrieve.ts  → parte de una pregunta, busca noticias parecidas, mira
//                  hacia atrás (published_at DESC, distancia coseno).
//   portfolio.ts → parte de una LISTA DE POSICIONES conocida, y lo que
//                  busca es el estado de cada una + lo que está por venir.
//
// Dos consecuencias de diseño:
//
// 1. CERO CUOTA DE EMBEDDINGS. Los símbolos no hay que adivinarlos — están
//    en la watchlist. Sin adivinanza no hace falta búsqueda semántica, así
//    que una revisión completa no gasta ni una unidad del presupuesto de
//    Gemini (que es el recurso escaso del proyecto, 1.000/día y key).
//
// 2. QUERIES DE CONJUNTO, no por símbolo. `factsForSymbol` lanza 6 queries
//    por ticker; con 15 posiciones serían 90 round-trips HTTP contra Neon,
//    y el driver HTTP hace un fetch independiente por query. Aquí son 8
//    queries en total, con `= ANY($1)`, sea cual sea el tamaño de la
//    cartera. Cambiar esto a un bucle por símbolo es la regresión más
//    fácil de introducir y la más cara de todas.

import { sql, type SQL } from "drizzle-orm";
import { db, unwrapRows } from "@/lib/db";
import { attachExtracts, type Citation } from "@/lib/ask/retrieve";
import { kindLabel } from "@/lib/signals/kinds";
import { getFundPositionChanges, type FundPositionChange } from "@/lib/funds/queries";
import {
  earningsBars,
  harvestBodies,
  pendingDeals,
  reloadBodies,
  selectForwardCandidates,
  systematicSellers,
  type EarningsBar,
  type ForwardCandidate,
  type PendingDeal,
  type SystematicSeller,
} from "@/lib/ask/forward";
import {
  buildPortfolio,
  concentrationFlags,
  type ConcentrationFlag,
  type Portfolio,
  type Position,
  type QuoteLike,
} from "@/lib/portfolio";

/** Tope de posiciones que entran en una revisión. Acota el prompt y el
 *  tiempo de las queries; por encima de esto la revisión dejaría de ser
 *  legible de todos modos. Se recortan las de MENOR peso, que son las que
 *  menos mueven la aguja. */
const MAX_POSITIONS = 20;
/** Citas por símbolo y tope global — el prompt tiene que caber. */
const NEWS_PER_SYMBOL = 3;
const MAX_CITATIONS = 30;
/** Ventana de noticias que se considera "estado actual" de una posición. */
const NEWS_WINDOW_DAYS = 14;
/** Horizonte del calendario de catalizadores conocidos. */
const CALENDAR_DAYS = 30;

export type PositionSignal = {
  kind: string;
  label: string;
  detectedAt: string;
  /** false = disparó hace poco y su horizonte de 30d AÚN NO se ha medido.
   *  Es la única forma honesta de decir "esto está en curso". */
  matured: boolean;
};

export type PositionFacts = {
  symbol: string;
  insiderNet7d: number | null;
  insiderNet30d: number | null;
  insiderBuyers30d: number;
  insiderSellers30d: number;
  stakes: Array<{ filer: string | null; pct: number | null; filedAt: string }>;
  nextEarnings: string | null;
  earningsHour: string | null;
  signals: PositionSignal[];
  beta: number | null;
  pe: number | null;
  /** Cobertura y sentimiento de los últimos 7d… */
  news7d: number;
  avgSentiment7d: number | null;
  /** …contra los 7 anteriores. La DERIVADA es la señal: que un valor pase
   *  de +2,1 a -0,4 dice mucho más que el nivel absoluto de esta semana. */
  newsPrior7d: number;
  avgSentimentPrior7d: number | null;
  daysToCover: number | null;
  /** Números de cita [n] que respaldan a este símbolo. */
  citationNums: number[];
};

export type CalendarItem = {
  date: string | null;
  symbol: string;
  what: string;
};

/** Posiciones que reportan resultados el MISMO día, con el peso conjunto
 *  que se juega en esa sesión. Es el riesgo que una lista de fechas suelta
 *  no comunica: tres nombres el 29-jul pueden ser el 60% de la cartera. */
export type EarningsCluster = {
  date: string;
  symbols: string[];
  weightPct: number;
  /** Símbolos del cluster que NO se pudieron valorar y por tanto NO están
   *  dentro de `weightPct`. Va en el tipo por la misma razón que
   *  `unpricedSymbols` en `buildPortfolio`: quien pinte el porcentaje está
   *  obligado a decir sobre cuánto se calculó. Contarlos como 0% hacía que
   *  «el 12% de la cartera reporta ese día» fuera exacto y falso a la vez
   *  justo el día que el proveedor de precios fallaba. */
  unpricedSymbols: string[];
};

/** Agregados de cartera que el LLM NO debe calcular por su cuenta. */
export type DerivedAggregates = {
  /** Beta de la cartera ponderada por peso. null si no hay beta de nadie. */
  weightedBeta: number | null;
  /** Cobertura del cálculo: qué % del peso tiene beta conocida. */
  betaCoveragePct: number;
  earningsClusters: EarningsCluster[];
};

/** Todo lo que mira hacia adelante. Ver lib/ask/forward.ts para el porqué
 *  de cada pieza — resumen: la revisión leía lo obvio porque el retrieval
 *  ordenaba por impacto (que premia lo ya ocurrido) sobre titulares (que
 *  SON lo obvio), y esto lo corrige por los dos lados. */
export type ForwardLayer = {
  /** Candidatos elegidos por categoría prospectiva, con cuerpo si se pudo. */
  candidates: ForwardCandidate[];
  earningsBars: EarningsBar[];
  sellers: SystematicSeller[];
  deals: PendingDeal[];
  /** Movimientos 13F trimestre a trimestre de las gestoras curadas sobre
   *  ESTAS posiciones. `fund_holdings` tenía 1.782 filas y su único lector
   *  era la página /insider: la revisión de la cartera no sabía que Tiger
   *  Global, Coatue y Appaloosa habían recortado MSFT entre un 28% y un 82%
   *  en el mismo trimestre (auditado 2026-08-07). */
  fundChanges: FundPositionChange[];
  /** Cuántos cuerpos se extrajeron en esta pasada y cuántos se intentaron:
   *  si es 0/20 el archivo no dio material y la revisión debe decirlo en
   *  vez de fingir profundidad. */
  harvested: number;
  attempted: number;
  bodiesAvailable: number;
};

export type PortfolioRetrieval = {
  portfolio: Portfolio;
  facts: PositionFacts[];
  citations: Citation[];
  calendar: CalendarItem[];
  derived: DerivedAggregates;
  forward: ForwardLayer;
  concentration: ConcentrationFlag[];
  /** Posiciones vivas sin UNA sola noticia en la ventana. El archivo no
   *  sabe nada de ellas y la revisión está obligada a decirlo. */
  blindSpots: string[];
};

function symbolList(symbols: string[]): SQL {
  return sql.join(
    symbols.map((s) => sql`${s}`),
    sql`, `,
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Las 8 queries. Todas por conjunto.
// ─────────────────────────────────────────────────────────────────────────

type InsiderRow = {
  symbol: string;
  net7: number | null;
  net30: number | null;
  buyers: number;
  sellers: number;
};

function insiderQuery(syms: SQL) {
  // Sólo P/S de mercado abierto: los grants (A), ejercicios de opciones (M)
  // y retenciones fiscales (F) están en la tabla pero no son decisiones de
  // inversión — mismo criterio que lib/insider/queries.ts.
  return db.execute(sql`
    SELECT symbol,
      (COALESCE(SUM(value) FILTER (WHERE tx_code='P' AND filed_at >= now() - interval '7 days'),0)
       - COALESCE(SUM(value) FILTER (WHERE tx_code='S' AND filed_at >= now() - interval '7 days'),0))::float8 AS net7,
      (COALESCE(SUM(value) FILTER (WHERE tx_code='P'),0)
       - COALESCE(SUM(value) FILTER (WHERE tx_code='S'),0))::float8 AS net30,
      COUNT(DISTINCT owner_name) FILTER (WHERE tx_code='P')::int AS buyers,
      COUNT(DISTINCT owner_name) FILTER (WHERE tx_code='S')::int AS sellers
    FROM insider_trades
    WHERE symbol IN (${syms})
      AND tx_code IN ('P','S')
      AND filed_at >= now() - interval '30 days'
    GROUP BY symbol
  `);
}

type StakeRow = {
  symbol: string;
  filer: string | null;
  pct: number | null;
  filedAt: string;
};

function stakesQuery(syms: SQL) {
  // 2 por símbolo como mucho: un activista que amplía posición genera
  // varios filings y sin el corte un solo nombre inundaría el prompt.
  return db.execute(sql`
    SELECT symbol, filer, pct, "filedAt" FROM (
      SELECT symbol, filer_name AS filer, percent_of_class::float8 AS pct,
             to_char(filed_at at time zone 'UTC','YYYY-MM-DD') AS "filedAt",
             ROW_NUMBER() OVER (PARTITION BY symbol ORDER BY filed_at DESC) AS rn
      FROM fund_stakes
      WHERE symbol IN (${syms}) AND filed_at >= now() - interval '180 days'
    ) t WHERE rn <= 2
  `);
}

type EarningsRow = { symbol: string; d: string; hour: string | null };

function earningsQuery(syms: SQL) {
  // `date` es TEXT yyyy-mm-dd (sortable): se compara como texto, no con
  // operadores de fecha — igual que en retrieve.ts.
  return db.execute(sql`
    SELECT symbol, date AS d, hour FROM (
      SELECT symbol, date, hour,
             ROW_NUMBER() OVER (PARTITION BY symbol ORDER BY date ASC) AS rn
      FROM earnings_events
      WHERE symbol IN (${syms})
        AND date >= to_char(current_date, 'YYYY-MM-DD')
        AND date <= to_char(current_date + ${sql.raw(String(CALENDAR_DAYS))}, 'YYYY-MM-DD')
    ) t WHERE rn = 1
  `);
}

type SignalRow = {
  symbol: string;
  kind: string;
  detectedAt: string;
  matured: boolean;
};

function signalsQuery(syms: SQL) {
  // El LEFT JOIN a horizonte 30 es lo que distingue "esta señal ya se
  // midió" de "esta señal está EN CURSO". Lo segundo es justo el material
  // prospectivo que la revisión necesita y que ninguna otra tabla tiene.
  return db.execute(sql`
    SELECT e.symbol, e.kind,
           to_char(e.detected_at at time zone 'UTC','YYYY-MM-DD') AS "detectedAt",
           (o.event_id IS NOT NULL) AS matured
    FROM signal_events e
    LEFT JOIN signal_outcomes o ON o.event_id = e.id AND o.horizon = 30
    WHERE e.symbol IN (${syms})
      AND e.detected_at >= now() - interval '45 days'
    ORDER BY e.detected_at DESC
  `);
}

type FundRow = { symbol: string; beta: number | null; pe: number | null };

function fundamentalsQuery(syms: SQL) {
  // beta/pe llegan como TEXT de FMP (criterio de la tabla): el cast a
  // float8 va aquí y no en TS para que un valor basura ("" o "N/A") caiga
  // como NULL en vez de convertirse en NaN y propagarse a las medias.
  return db.execute(sql`
    SELECT symbol,
           NULLIF(regexp_replace(COALESCE(beta,''), '[^0-9.\\-]', '', 'g'), '')::float8 AS beta,
           NULLIF(regexp_replace(COALESCE(pe,''), '[^0-9.\\-]', '', 'g'), '')::float8 AS pe
    FROM ticker_fundamentals
    WHERE symbol IN (${syms})
  `);
}

type CoverageRow = {
  symbol: string;
  n7: number;
  avg7: number | null;
  nPrior: number;
  avgPrior: number | null;
};

function coverageQuery(syms: SQL) {
  // Una sola pasada para las DOS ventanas con FILTER, en vez de dos
  // queries: la semana actual y la anterior salen del mismo escaneo.
  return db.execute(sql`
    SELECT nt.ticker AS symbol,
      COUNT(*) FILTER (WHERE n.published_at >= now() - interval '7 days')::int AS n7,
      AVG(s.sentiment) FILTER (WHERE n.published_at >= now() - interval '7 days')::float8 AS avg7,
      COUNT(*) FILTER (WHERE n.published_at <  now() - interval '7 days')::int AS "nPrior",
      AVG(s.sentiment) FILTER (WHERE n.published_at <  now() - interval '7 days')::float8 AS "avgPrior"
    FROM news_tickers nt
    JOIN news n ON n.id = nt.news_id
    JOIN news_scores s ON s.news_id = n.id
    WHERE nt.ticker IN (${syms})
      AND n.published_at >= now() - interval '14 days'
    GROUP BY nt.ticker
  `);
}

type ShortRow = { symbol: string; dtc: number | null };

function shortQuery(syms: SQL) {
  // FINRA publica dos liquidaciones al mes: la última fila por símbolo es
  // el dato vigente. DISTINCT ON es la forma barata de cogerla.
  return db.execute(sql`
    SELECT DISTINCT ON (symbol) symbol, days_to_cover AS dtc
    FROM short_interest
    WHERE symbol IN (${syms})
    ORDER BY symbol, settlement_date DESC
  `);
}

type NewsRow = Omit<Citation, "n" | "via" | "dist"> & { sym: string };

function newsQuery(syms: SQL) {
  // Se lee de `news_embeddings`, no de `news`, por la misma razón que el
  // Ask normal: es el snapshot desnormalizado que SOBREVIVE a la purga de
  // noticias a 20 días, así que las citas siguen siendo verificables.
  // Ordenar por impacto y no por fecha es deliberado: en una revisión de
  // cartera interesa lo que MUEVE la tesis, no lo último que se publicó.
  //
  // El prefiltro `symbols && ARRAY[...]` NO es redundante con el
  // `s.sym IN (...)` de abajo: es el ÚNICO de los dos que puede usar el GIN
  // news_embeddings_symbols_idx (la misma forma que retrieve.ts). Filtrar
  // solo sobre el alias del unnest obligaba a expandir el array de TODAS
  // las filas de la ventana antes de descartar. El IN se queda porque el
  // overlap deja pasar filas por cualquier símbolo del array y `s.sym` debe
  // seguir siendo uno de los pedidos.
  return db.execute(sql`
    SELECT sym, news_id AS "newsId", headline, summary, url, source, symbols,
           impact, sentiment, "publishedAt"
    FROM (
      SELECT ne.news_id, ne.headline, ne.summary, ne.url, ne.source, ne.symbols,
             ne.impact, ne.sentiment, s.sym,
             to_char(ne.published_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "publishedAt",
             ROW_NUMBER() OVER (
               PARTITION BY s.sym ORDER BY ne.impact DESC, ne.published_at DESC
             ) AS rn
      FROM news_embeddings ne
      CROSS JOIN LATERAL unnest(ne.symbols) AS s(sym)
      WHERE ne.symbols && ARRAY[${syms}]::text[]
        AND s.sym IN (${syms})
        AND ne.published_at >= now() - interval '${sql.raw(String(NEWS_WINDOW_DAYS))} days'
    ) t
    WHERE rn <= ${NEWS_PER_SYMBOL}
    ORDER BY impact DESC, "publishedAt" DESC
  `);
}

// ─────────────────────────────────────────────────────────────────────────

function groupBy<T extends { symbol: string }>(rows: T[]): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const r of rows) {
    const cur = m.get(r.symbol);
    if (cur) cur.push(r);
    else m.set(r.symbol, [r]);
  }
  return m;
}

/**
 * Foto completa de la cartera: valoración + hechos por posición + citas +
 * calendario de lo que viene.
 *
 * `quotes` se inyecta en vez de pedirse aquí para que este módulo siga
 * siendo solo-BD: quien llama ya tiene `getQuotesMap` (lo usa la home) y
 * así la revisión no añade una ronda de red propia contra Finnhub.
 */
export type RetrieveOptions = {
  /** false = no salir a la red a extraer cuerpos. Sólo para pruebas y para
   *  un modo rápido: sin cosecha la revisión vuelve a leer titulares. */
  harvest?: boolean;
  harvestBudgetMs?: number;
  forwardPerSymbol?: number;
};

const EMPTY_FORWARD: ForwardLayer = {
  candidates: [],
  earningsBars: [],
  sellers: [],
  deals: [],
  fundChanges: [],
  harvested: 0,
  attempted: 0,
  bodiesAvailable: 0,
};

export async function retrievePortfolio(
  rows: Position[],
  quotes: Record<string, QuoteLike>,
  opts?: RetrieveOptions,
): Promise<PortfolioRetrieval> {
  const portfolio = buildPortfolio(rows, quotes);

  // Las de menor peso son las que se caen si la cartera es enorme.
  const positions = portfolio.positions.slice(0, MAX_POSITIONS);
  const symbols = positions.map((p) => p.symbol);

  if (!symbols.length) {
    return {
      portfolio,
      facts: [],
      citations: [],
      calendar: [],
      derived: { weightedBeta: null, betaCoveragePct: 0, earningsClusters: [] },
      forward: EMPTY_FORWARD,
      concentration: concentrationFlags(portfolio),
      blindSpots: [],
    };
  }

  const syms = symbolList(symbols);
  const [
    insR, stkR, earnR, sigR, fndR, covR, shrR, newsR,
    fwdCandidates, bars, sellers, deals, fundChanges,
  ] = await Promise.all([
      insiderQuery(syms),
      stakesQuery(syms),
      earningsQuery(syms),
      signalsQuery(syms),
      fundamentalsQuery(syms),
      coverageQuery(syms),
      shortQuery(syms),
      newsQuery(syms),
      selectForwardCandidates(symbols, opts?.forwardPerSymbol ?? 4),
      earningsBars(symbols),
      systematicSellers(symbols),
      pendingDeals(symbols),
      getFundPositionChanges(24, symbols).catch(() => []),
    ]);

  // LA operación que cambia el resultado: ir a buscar los cuerpos que
  // faltan. Medido el 2026-07-25, sólo el 3% de las noticias tenía cuerpo
  // extraído, así que sin esto el modelo redacta desde titulares y un
  // titular es, literalmente, lo obvio. Coste: N fetches con presupuesto
  // de pared y CERO llamadas LLM (allowLlm:false). Queda cacheado en
  // article_extracts, así que la segunda revisión ya casi no paga.
  const harvest = opts?.harvest === false
    ? { harvested: 0, attempted: 0 }
    : await harvestBodies(fwdCandidates, { budgetMs: opts?.harvestBudgetMs ?? 20_000 });
  const candidates = harvest.harvested > 0
    ? await reloadBodies(fwdCandidates)
    : fwdCandidates;

  const insider = new Map(
    unwrapRows<InsiderRow>(insR).map((r) => [r.symbol, r]),
  );
  const stakes = groupBy(unwrapRows<StakeRow>(stkR));
  const earnings = new Map(
    unwrapRows<EarningsRow>(earnR).map((r) => [r.symbol, r]),
  );
  const signals = groupBy(unwrapRows<SignalRow>(sigR));
  const funds = new Map(unwrapRows<FundRow>(fndR).map((r) => [r.symbol, r]));
  const coverage = new Map(
    unwrapRows<CoverageRow>(covR).map((r) => [r.symbol, r]),
  );
  const shorts = new Map(unwrapRows<ShortRow>(shrR).map((r) => [r.symbol, r]));

  // Citas: numeración global única. Una noticia puede tocar a dos
  // posiciones de la cartera (un competidor, una fusión); se numera UNA
  // vez y las dos posiciones apuntan al mismo [n] — si se numerara por
  // símbolo, la misma noticia saldría dos veces con números distintos y
  // el lector no podría saber que es la misma.
  const citations: Citation[] = [];
  const byUrl = new Map<string, number>();
  const citationsBySymbol = new Map<string, number[]>();

  // Los candidatos prospectivos se numeran PRIMERO. No es cosmética: el
  // orden de las citas es el orden en que el modelo las lee, y quien
  // ocupaba el [1] era la noticia de mayor impacto, es decir, la caída del
  // día. Ahora el [1] es la operación pendiente de cerrar.
  const numByNewsId = new Map<number, number>();
  for (const c of candidates) {
    const key = `n${c.newsId}`;
    if (byUrl.has(key)) continue;
    const n = citations.length + 1;
    byUrl.set(key, n);
    numByNewsId.set(c.newsId, n);
    citations.push({
      n,
      via: "forward",
      category: c.category,
      newsId: c.newsId,
      headline: c.headline,
      summary: null,
      url: c.url,
      source: c.source,
      symbols: [c.symbol],
      publishedAt: c.publishedAt,
      impact: c.impact,
      sentiment: c.sentiment,
      body: c.body ? c.body.slice(0, 700) : null,
    });
    const list = citationsBySymbol.get(c.symbol) ?? [];
    if (!list.includes(n)) list.push(n);
    citationsBySymbol.set(c.symbol, list);
  }

  for (const row of unwrapRows<NewsRow>(newsR)) {
    const key = row.newsId !== null ? `n${row.newsId}` : row.url;
    let n = byUrl.get(key);
    if (n === undefined) {
      if (citations.length >= MAX_CITATIONS) continue;
      n = citations.length + 1;
      byUrl.set(key, n);
      citations.push({
        n,
        via: "lexical",
        newsId: row.newsId,
        headline: row.headline,
        summary: row.summary,
        url: row.url,
        source: row.source,
        symbols: row.symbols,
        publishedAt: row.publishedAt,
        impact: row.impact,
        sentiment: row.sentiment,
      });
    }
    const list = citationsBySymbol.get(row.sym) ?? [];
    if (!list.includes(n)) list.push(n);
    citationsBySymbol.set(row.sym, list);
  }
  await attachExtracts(citations);

  const facts: PositionFacts[] = symbols.map((symbol) => {
    const ins = insider.get(symbol);
    const cov = coverage.get(symbol);
    const earn = earnings.get(symbol);
    const fnd = funds.get(symbol);
    return {
      symbol,
      insiderNet7d: ins?.net7 ?? null,
      insiderNet30d: ins?.net30 ?? null,
      insiderBuyers30d: ins?.buyers ?? 0,
      insiderSellers30d: ins?.sellers ?? 0,
      stakes: (stakes.get(symbol) ?? []).map((s) => ({
        filer: s.filer,
        pct: s.pct,
        filedAt: s.filedAt,
      })),
      nextEarnings: earn?.d ?? null,
      earningsHour: earn?.hour ?? null,
      signals: (signals.get(symbol) ?? []).map((s) => ({
        kind: s.kind,
        label: kindLabel(s.kind),
        detectedAt: s.detectedAt,
        matured: Boolean(s.matured),
      })),
      beta: fnd?.beta ?? null,
      pe: fnd?.pe ?? null,
      news7d: cov?.n7 ?? 0,
      avgSentiment7d: cov?.avg7 ?? null,
      newsPrior7d: cov?.nPrior ?? 0,
      avgSentimentPrior7d: cov?.avgPrior ?? null,
      daysToCover: shorts.get(symbol)?.dtc ?? null,
      citationNums: citationsBySymbol.get(symbol) ?? [],
    };
  });

  const forward: ForwardLayer = {
    candidates,
    earningsBars: bars,
    sellers,
    deals,
    fundChanges,
    harvested: harvest.harvested,
    attempted: harvest.attempted,
    bodiesAvailable: candidates.filter((c) => c.body && c.body.length >= 200).length,
  };

  return {
    portfolio,
    facts,
    citations,
    calendar: buildCalendar(facts, forward),
    derived: deriveAggregates(facts, portfolio),
    forward,
    concentration: concentrationFlags(portfolio),
    blindSpots: facts.filter((f) => f.news7d === 0 && !f.citationNums.length).map((f) => f.symbol),
  };
}

/** Mapa newsId → número de cita, para que el extractor del libro de
 *  futuros pueda referenciar las mismas citas que verá el lector. */
export function citationNumberFor(r: PortfolioRetrieval): (newsId: number) => number | undefined {
  const m = new Map(
    r.citations
      .filter((c) => c.newsId !== null)
      .map((c) => [c.newsId as number, c.n]),
  );
  return (newsId: number) => m.get(newsId);
}

/**
 * Agregados que se calculan AQUÍ y no en el prompt.
 *
 * Motivo, y es la doctrina del proyecto entera: "el RAG vectorial falla en
 * conteos y agregados", que es por lo que existe el bloque de hechos SQL.
 * Un LLM multiplicando pesos por betas cae en el mismo agujero — dio un
 * resultado aproximadamente correcto en la primera prueba real, que es
 * exactamente el modo de fallo peligroso: parece bien y nadie lo revisa.
 * Si el número va a salir en pantalla, lo calcula el código.
 *
 * Exportada SOLO para el test que fija la beta reescalada y el cluster con
 * `unpricedSymbols`: son de los pocos números que llegan a pantalla sin
 * pasar por el LLM y nada más los protegía de una regresión.
 */
export function deriveAggregates(
  facts: PositionFacts[],
  portfolio: Portfolio,
): DerivedAggregates {
  // `weightPct` es null cuando la posición no se pudo valorar (429 del
  // proveedor de precios). El mapa guarda SÓLO lo valorable, y quien lo
  // consulte distingue "pesa 0" de "no se sabe" — que es la diferencia entre
  // un agregado correcto y uno inventado.
  const weightOf = new Map(
    portfolio.positions
      .filter((p) => p.weightPct !== null)
      .map((p) => [p.symbol, p.weightPct as number]),
  );

  // Beta ponderada SOLO sobre el peso que tiene beta conocida, y se
  // reescala a ese subconjunto. Tratar la beta ausente como 0 empujaría la
  // media hacia abajo y haría parecer defensiva una cartera que no lo es.
  let betaWeight = 0;
  let betaSum = 0;
  for (const f of facts) {
    if (f.beta === null) continue;
    const w = weightOf.get(f.symbol) ?? 0;
    betaWeight += w;
    betaSum += f.beta * w;
  }

  const clusters = new Map<
    string,
    { symbols: string[]; weightPct: number; unpricedSymbols: string[] }
  >();
  for (const f of facts) {
    if (!f.nextEarnings) continue;
    const cur = clusters.get(f.nextEarnings) ?? {
      symbols: [],
      weightPct: 0,
      unpricedSymbols: [],
    };
    cur.symbols.push(f.symbol);
    const w = weightOf.get(f.symbol);
    // Sin peso conocido NO suma cero: sale declarado aparte. Sumar 0 dejaba
    // el porcentaje por debajo de la verdad sin ninguna señal de que faltaba
    // un nombre, y el prompt lo presenta como cifra cerrada.
    if (w === undefined) cur.unpricedSymbols.push(f.symbol);
    else cur.weightPct += w;
    clusters.set(f.nextEarnings, cur);
  }

  return {
    weightedBeta: betaWeight > 0 ? betaSum / betaWeight : null,
    betaCoveragePct: betaWeight,
    earningsClusters: [...clusters.entries()]
      .map(([date, v]) => ({ date, ...v }))
      .sort((a, b) => a.date.localeCompare(b.date)),
  };
}

/**
 * Calendario de catalizadores CONOCIDOS.
 *
 * Esto es todo lo que Catalyst puede decir honestamente sobre el futuro:
 * fechas ya publicadas y procesos ya iniciados. No hay ninguna predicción
 * de precio aquí y no debe haberla — el resto del sistema (el Lab) existe
 * precisamente porque medir a posteriori es lo único que no se puede
 * falsear, y una revisión que "anticipe" inventando rompería esa cadena.
 */
function buildCalendar(facts: PositionFacts[], forward: ForwardLayer): CalendarItem[] {
  const items: CalendarItem[] = [];
  const barBySymbol = new Map(forward.earningsBars.map((b) => [b.symbol, b]));

  for (const f of facts) {
    if (f.nextEarnings) {
      const hour = f.earningsHour ? ` (${f.earningsHour})` : "";
      // La VARA, no sólo la fecha. "Reporta el 29" ya está en pantalla;
      // "reporta el 29 con un consenso de 7,38$" es lo que dice si la
      // noticia va a ser buena o mala. El dato estaba en la tabla desde el
      // principio y no lo leía nadie.
      const bar = barBySymbol.get(f.symbol);
      const est =
        bar?.epsEstimate != null
          ? ` · consenso BPA ${bar.epsEstimate.toFixed(4).replace(/0+$/, "").replace(/\.$/, "")}$${
              bar.revenueEstimate != null
                ? ` e ingresos ${(bar.revenueEstimate / 1e9).toFixed(2)}B$`
                : ""
            }`
          : "";
      items.push({
        date: f.nextEarnings,
        symbol: f.symbol,
        what: `Resultados${hour}${est}`,
      });
    }
    // Señales aún sin medir = proceso abierto, no historia cerrada.
    for (const s of f.signals) {
      if (!s.matured) {
        items.push({
          date: null,
          symbol: f.symbol,
          what: `${s.label} en curso desde ${s.detectedAt} — horizonte 30d sin medir`,
        });
      }
    }
    // Un 13D no es un evento aislado: el activista que declara el 5% casi
    // siempre vuelve (ampliación, carta al consejo, propuesta de consejeros).
    for (const st of f.stakes) {
      items.push({
        date: null,
        symbol: f.symbol,
        what: `13D/G de ${st.filer ?? "declarante no identificado"}${st.pct !== null ? ` (${st.pct}%)` : ""} el ${st.filedAt} — vigilar escalada`,
      });
    }
    if (f.daysToCover !== null && f.daysToCover >= 5) {
      items.push({
        date: null,
        symbol: f.symbol,
        what: `Days-to-cover ${f.daysToCover.toFixed(1)} — el dato de FINRA se refresca dos veces al mes`,
      });
    }
  }

  // Vendedores sistemáticos: oferta futura conocida. Una venta suelta es
  // ruido; dos o más del mismo directivo en 90d con acciones aún por
  // colocar dice que viene más papel, y eso es anticipación, no crónica.
  //
  // La coletilla dependía de una INFERENCIA: decía "venta programada en
  // curso" siempre, porque el patrón repetido era lo único que teníamos.
  // Desde que se lee `<aff10b5One>` del Form 4 (2026-08-11) se puede
  // afirmar, negar o CALLAR, que son tres respuestas distintas:
  //
  //   - todas en plan  → sólo oferta. Un plan se firmó meses antes y no
  //                      dice nada de lo que el directivo piense hoy; leerlo
  //                      como falta de fe es el error que el prompt no
  //                      puede corregir si el hecho llega ya deformado.
  //   - alguna fuera   → oferta Y decisión reciente. Ahí sí hay lectura.
  //   - sin dato       → se describe el patrón y punto. Antes esto se
  //                      contaba como "programada", que era inventarlo.
  for (const s of forward.sellers) {
    const quedan =
      s.sharesAfter != null
        ? ` y le quedan ${Math.round(s.sharesAfter).toLocaleString("es-ES")} acciones`
        : "";
    const plan =
      s.discretionarySales > 0
        ? ` — ${s.discretionarySales} de ${s.sales} declaradas FUERA de plan 10b5-1 en el propio Form 4`
        : s.plannedSales === s.sales
          ? " — todas declaradas dentro de un plan 10b5-1: es oferta futura, no una opinión sobre el negocio"
          : s.plannedSales > 0
            ? ` — ${s.plannedSales} de ${s.sales} dentro de plan 10b5-1 declarado`
            : "";
    items.push({
      date: null,
      symbol: s.symbol,
      what: `${s.owner}${s.title ? ` (${s.title})` : ""} lleva ${s.sales} ventas desde ${s.firstSale}${quedan}${plan}`,
    });
  }
  // Lo fechado primero y en orden; lo indefinido detrás, en el orden de la
  // cartera (que ya viene por peso).
  const dated = items.filter((i) => i.date).sort((a, b) => a.date!.localeCompare(b.date!));
  return [...dated, ...items.filter((i) => !i.date)];
}
