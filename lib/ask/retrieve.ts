// Recuperación para Ask Catalyst. Solo LECTURA de BD — Workers-safe.
//
// Tres canales que se complementan y que fallan de formas distintas:
//   1. VECTORIAL (pgvector sobre news_embeddings): encuentra por SIGNIFICADO
//      — "chips de IA" trae Nvidia/Nebius sin que la palabra aparezca.
//   2. LÉXICO (ILIKE): encuentra lo literal — nombres propios, cifras, un
//      ticker exacto. Es además el ÚNICO canal para anónimos, porque no
//      gasta cuota de embeddings.
//   3. ESTRUCTURADO (SQL): los NÚMEROS. El research es explícito en que el
//      RAG vectorial falla en conteos y agregados, así que ningún número de
//      una respuesta sale de un embedding: salen de estas queries.
//
// El vectorial busca sobre el snapshot, no sobre `news`: las citas siguen
// existiendo después de la purga de noticias a 20 días.

import { sql, type SQL } from "drizzle-orm";
import { db, unwrapRows } from "@/lib/db";

export type Citation = {
  n: number;
  newsId: number | null;
  headline: string;
  summary: string | null;
  url: string;
  source: string;
  symbols: string[];
  publishedAt: string;
  impact: number;
  sentiment: number;
  /** Cómo llegó aquí — se pinta en la UI y ayuda a depurar el retrieval. */
  via: "vector" | "lexical";
  /** Distancia coseno al query (solo canal vectorial). La lee hasCoverage. */
  dist?: number;
  /** Sustancia del artículo YA extraída (article_extracts): resumen IA o
   *  primeros chars del texto. Sin esto el LLM de /ask solo veía titular +
   *  summary del scoring y "analizaba" parafraseando el header. */
  body?: string | null;
};

export type StructuredFacts = {
  symbol: string;
  name: string | null;
  insiderNet7d: number | null;
  insiderNet30d: number | null;
  insiderBuyers30d: number;
  insiderSellers30d: number;
  stakes: Array<{ filer: string | null; pct: number | null; filedAt: string }>;
  nextEarnings: string | null;
  lastPick: { thesis: string; generatedAt: string } | null;
  newsCount7d: number;
  avgSentiment7d: number | null;
};

export type Retrieval = {
  symbols: string[];
  citations: Citation[];
  facts: StructuredFacts[];
  /** true si el canal vectorial pudo usarse (sesión del dueño con cuota). */
  vectorUsed: boolean;
};

// All-caps que son palabras normales en una pregunta y ADEMÁS existen como
// ticker real (AI = C3.ai, IT = Gartner…). Sin esto, "¿qué hay de nuevo en
// AI?" se convertiría en una pregunta sobre C3.ai.
const AMBIGUOUS_UPPER = new Set([
  "AI", "IT", "US", "USA", "UK", "EU", "CEO", "CFO", "IPO", "ETF", "SEC",
  "FED", "GDP", "CPI", "EPS", "PE", "ATH", "YTD", "Q1", "Q2", "Q3", "Q4",
  "OK", "NEWS", "BUY", "SELL", "ALL", "ANY", "ON", "IN", "OR", "AND", "SO",
]);

const STOPWORDS = new Set([
  "the", "what", "whats", "que", "qué", "de", "del", "la", "el", "los", "las",
  "and", "for", "with", "about", "sobre", "esta", "this", "week", "semana",
  "hoy", "today", "is", "are", "was", "were", "has", "have", "did", "does",
  "how", "why", "when", "which", "who", "cómo", "por", "para", "con", "una",
  "un", "en", "se", "su", "sus", "me", "my", "mi", "a", "an", "of", "to",
  "dijo", "said", "say", "says", "new", "nuevo", "nueva", "any", "all",
]);

function list(values: string[]): SQL {
  return sql.join(
    values.map((v) => sql`${v}`),
    sql`, `,
  );
}

/**
 * Símbolos mencionados en la pregunta. Dos vías: token en mayúsculas que
 * existe en `tickers`, y n-grama que coincide con un alias conocido
 * ("Nvidia", "Palo Alto Networks"). El diccionario NO se carga entero: se
 * consulta sólo por los n-gramas de la pregunta.
 */
export async function extractQuestionSymbols(question: string): Promise<string[]> {
  const raw = question.replace(/[^\p{L}\p{N}$.\s-]/gu, " ");
  const words = raw.split(/\s+/).filter(Boolean);

  // El candidato a ticker tiene que venir YA en mayúsculas (o con `$`) en
  // la pregunta. Pasar cada palabra a mayúsculas convertía "qué se dijo DE
  // AI chips ESTA semana" en una pregunta sobre Deere, Establishment Labs
  // y Sea Ltd — con sus agregados SQL incluidos. La señal no es "existe un
  // ticker con esas letras" sino "el usuario lo escribió como ticker".
  const upperCandidates = words
    .filter((w) => w.startsWith("$") || w === w.toUpperCase())
    .map((w) => w.replace(/^\$/, "").toUpperCase())
    .filter(
      (w) =>
        /^[A-Z][A-Z.-]{0,5}$/.test(w) &&
        (!AMBIGUOUS_UPPER.has(w) || words.includes(`$${w}`)),
    );

  // N-gramas de 1 a 3 palabras para casar alias multipalabra.
  const lower = words.map((w) => w.toLowerCase());
  const ngrams = new Set<string>();
  for (let i = 0; i < lower.length; i++) {
    for (let n = 1; n <= 3 && i + n <= lower.length; n++) {
      const g = lower.slice(i, i + n).join(" ");
      if (n === 1 && (STOPWORDS.has(g) || g.length < 3)) continue;
      ngrams.add(g);
    }
  }

  const found = new Set<string>();
  if (upperCandidates.length) {
    const rows = unwrapRows<{ symbol: string }>(
      await db.execute(
        sql`SELECT symbol FROM tickers WHERE symbol IN (${list(upperCandidates)})`,
      ),
    );
    rows.forEach((r) => found.add(r.symbol));
  }
  if (ngrams.size) {
    const rows = unwrapRows<{ symbol: string; alias: string }>(
      await db.execute(sql`
        SELECT DISTINCT symbol, lower(alias) AS alias FROM ticker_aliases
        WHERE lower(alias) IN (${list([...ngrams].slice(0, 60))})
      `),
    );
    // El match más largo gana: "Palo Alto Networks" casa PANW y, de paso,
    // el alias "alto" de Alto Ingredients. Si un alias está contenido en
    // otro ya aceptado, es un subtramo del mismo nombre, no otra empresa.
    const accepted: string[] = [];
    for (const r of rows.sort((a, b) => b.alias.length - a.alias.length)) {
      if (accepted.some((a) => a.includes(r.alias))) continue;
      accepted.push(r.alias);
      found.add(r.symbol);
    }
  }
  return [...found].slice(0, 6);
}

/** Palabras con contenido de la pregunta, para el canal léxico. */
function keywords(question: string): string[] {
  return [
    ...new Set(
      question
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, " ")
        .split(/\s+/)
        .filter((w) => w.length >= 4 && !STOPWORDS.has(w)),
    ),
  ].slice(0, 6);
}

type Row = Omit<Citation, "n" | "via"> & { dist?: number };

function rowsToCitations(rows: Row[], via: Citation["via"]): Citation[] {
  return rows.map((r) => ({ ...r, n: 0, via }));
}

const SELECT_COLS = sql`
  news_id AS "newsId", headline, summary, url, source, symbols, impact, sentiment,
  to_char(published_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "publishedAt"
`;

async function vectorSearch(
  queryVec: number[],
  symbols: string[],
  limit: number,
): Promise<Citation[]> {
  const vec = `[${queryVec.join(",")}]`;
  // Con símbolos: primero los que hablan de ESE ticker, después el resto
  // por semejanza pura. Sin el segundo tramo, una pregunta sobre NVDA no
  // vería la noticia de un competidor que la explica.
  const filtered = symbols.length
    ? unwrapRows<Row>(
        await db.execute(sql`
          SELECT ${SELECT_COLS}, (embedding <=> ${vec}::halfvec)::float8 AS dist
          FROM news_embeddings
          WHERE symbols && ARRAY[${list(symbols)}]::text[]
          ORDER BY embedding <=> ${vec}::halfvec
          LIMIT ${limit}
        `),
      )
    : [];
  const global = unwrapRows<Row>(
    await db.execute(sql`
      SELECT ${SELECT_COLS}, (embedding <=> ${vec}::halfvec)::float8 AS dist
      FROM news_embeddings
      ORDER BY embedding <=> ${vec}::halfvec
      LIMIT ${limit}
    `),
  );
  return rowsToCitations([...filtered, ...global], "vector");
}

async function lexicalSearch(
  question: string,
  symbols: string[],
  limit: number,
): Promise<Citation[]> {
  const terms = keywords(question);
  const conds: SQL[] = [];
  if (symbols.length) {
    conds.push(sql`symbols && ARRAY[${list(symbols)}]::text[]`);
  }
  for (const t of terms) {
    conds.push(sql`(headline ILIKE ${"%" + t + "%"} OR summary ILIKE ${"%" + t + "%"})`);
  }
  if (!conds.length) return [];
  const rows = unwrapRows<Row>(
    await db.execute(sql`
      SELECT ${SELECT_COLS}
      FROM news_embeddings
      WHERE ${sql.join(conds, sql` OR `)}
      ORDER BY published_at DESC
      LIMIT ${limit}
    `),
  );
  return rowsToCitations(rows, "lexical");
}

/** Agregados reales por símbolo. Aquí es donde salen los números.
 *  Las 6 queries del símbolo (y los hasta 3 símbolos) van en Promise.all:
 *  el driver HTTP hace un fetch independiente por query, así que en serie
 *  eran ~18 round-trips encadenados de latencia pura. */
async function factsForSymbol(symbol: string): Promise<StructuredFacts> {
  const metaQ = db.execute(sql`SELECT name FROM tickers WHERE symbol = ${symbol}`);
  const insiderQ = db.execute(sql`
        SELECT
          (COALESCE(SUM(value) FILTER (WHERE tx_code='P' AND filed_at >= now() - interval '7 days'),0)
           - COALESCE(SUM(value) FILTER (WHERE tx_code='S' AND filed_at >= now() - interval '7 days'),0))::float8 AS net7,
          (COALESCE(SUM(value) FILTER (WHERE tx_code='P'),0)
           - COALESCE(SUM(value) FILTER (WHERE tx_code='S'),0))::float8 AS net30,
          COUNT(DISTINCT owner_name) FILTER (WHERE tx_code='P')::int AS buyers,
          COUNT(DISTINCT owner_name) FILTER (WHERE tx_code='S')::int AS sellers
        FROM insider_trades
        WHERE symbol = ${symbol}
          AND tx_code IN ('P','S')
          AND filed_at >= now() - interval '30 days'
      `);
  const stakesQ = db.execute(sql`
        SELECT filer_name AS filer, percent_of_class::float8 AS pct,
               to_char(filed_at at time zone 'UTC','YYYY-MM-DD') AS "filedAt"
        FROM fund_stakes WHERE symbol = ${symbol}
        ORDER BY filed_at DESC LIMIT 4
      `);
  // earnings_events.date es TEXT yyyy-mm-dd (sortable) — se compara como
  // texto contra la fecha de hoy, no con operadores de fecha.
  const earnQ = db.execute(sql`
        SELECT date AS d FROM earnings_events
        WHERE symbol = ${symbol} AND date >= to_char(current_date, 'YYYY-MM-DD')
        ORDER BY date ASC LIMIT 1
      `);
  // ai_picks guarda UN JSON array por generación, no una fila por
  // símbolo: hay que desplegarlo para encontrar la tesis de este ticker.
  const pickQ = db.execute(sql`
        SELECT e.elem->>'thesis' AS thesis,
               to_char(p.generated_at at time zone 'UTC','YYYY-MM-DD') AS "generatedAt"
        FROM ai_picks p,
             LATERAL jsonb_array_elements(p.content::jsonb) AS e(elem)
        WHERE e.elem->>'symbol' = ${symbol}
        ORDER BY p.generated_at DESC LIMIT 1
      `);
  const covQ = db.execute(sql`
        SELECT COUNT(*)::int AS n, AVG(s.sentiment)::float8 AS avg
        FROM news_tickers nt
        JOIN news n ON n.id = nt.news_id
        JOIN news_scores s ON s.news_id = n.id
        WHERE nt.ticker = ${symbol} AND n.published_at >= now() - interval '7 days'
      `);

  const [metaR, insiderR, stakesR, earnR, pickR, covR] = await Promise.all([
    metaQ, insiderQ, stakesQ, earnQ, pickQ, covQ,
  ]);
  const [meta] = unwrapRows<{ name: string | null }>(metaR);
  const [insider] = unwrapRows<{
    net7: number | null;
    net30: number | null;
    buyers: number;
    sellers: number;
  }>(insiderR);
  const stakes = unwrapRows<{ filer: string | null; pct: number | null; filedAt: string }>(stakesR);
  const [earn] = unwrapRows<{ d: string | null }>(earnR);
  const [pick] = unwrapRows<{ thesis: string; generatedAt: string }>(pickR);
  const [cov] = unwrapRows<{ n: number; avg: number | null }>(covR);

  return {
    symbol,
    name: meta?.name ?? null,
    insiderNet7d: insider?.net7 ?? null,
    insiderNet30d: insider?.net30 ?? null,
    insiderBuyers30d: insider?.buyers ?? 0,
    insiderSellers30d: insider?.sellers ?? 0,
    stakes,
    nextEarnings: earn?.d ?? null,
    lastPick: pick ?? null,
    newsCount7d: cov?.n ?? 0,
    avgSentiment7d: cov?.avg ?? null,
  };
}

async function structuredFacts(symbols: string[]): Promise<StructuredFacts[]> {
  return Promise.all(symbols.slice(0, 3).map(factsForSymbol));
}

/**
 * K=20 citas como máximo. El vectorial entra por semejanza y el léxico por
 * recencia; el dedup se queda con la PRIMERA aparición, así que una noticia
 * que salga por los dos canales conserva su posición vectorial (mejor
 * señal de relevancia que la fecha).
 */
export async function retrieve(opts: {
  question: string;
  queryVec: number[] | null;
  limit?: number;
}): Promise<Retrieval> {
  const { question, queryVec } = opts;
  const limit = opts.limit ?? 20;
  const half = Math.ceil(limit / 2);
  const symbols = await extractQuestionSymbols(question);

  const [vector, lexical, facts] = await Promise.all([
    queryVec ? vectorSearch(queryVec, symbols, half) : Promise.resolve([]),
    lexicalSearch(question, symbols, half),
    structuredFacts(symbols),
  ]);

  const seen = new Set<string>();
  const citations: Citation[] = [];
  for (const c of [...vector, ...lexical]) {
    const key = c.newsId !== null ? `n${c.newsId}` : c.url;
    if (seen.has(key)) continue;
    seen.add(key);
    citations.push({ ...c, n: citations.length + 1 });
    if (citations.length >= limit) break;
  }

  await attachExtracts(citations);

  return { symbols, citations, facts, vectorUsed: Boolean(queryVec) };
}

/** Cuántas citas se enriquecen con el cuerpo del artículo (las primeras N,
 *  que son las mejor rankeadas) y cuántos chars viajan de cada una. Acota
 *  los tokens del prompt de /ask: 10×~700 ≈ 1,8k tokens extra como mucho. */
const EXTRACT_MAX_CITATIONS = 10;
const EXTRACT_MAX_CHARS = 700;

/**
 * Adjunta a las citas la sustancia del artículo que YA está en
 * `article_extracts` (extraído on-click o pre-enriquecido en el cron).
 * Coste: 1 query por pregunta, cero red y cero LLM — el hueco que tapa es
 * que /ask respondía parafraseando titulares aunque el artículo entero
 * estuviera cacheado en la BD. Best-effort: extracts cascadean con la purga
 * de news a 20d, así que citas viejas van sin body (el snapshot sobrevive).
 */
async function attachExtracts(citations: Citation[]): Promise<void> {
  const ids = citations
    .slice(0, EXTRACT_MAX_CITATIONS)
    .map((c) => c.newsId)
    .filter((id): id is number => id !== null);
  if (!ids.length) return;
  try {
    const rows = unwrapRows<{ newsId: number; body: string | null }>(
      await db.execute(sql`
        SELECT news_id AS "newsId",
               COALESCE(
                 NULLIF(TRIM(CONCAT_WS(' — ', ai_summary, ai_take)), ''),
                 LEFT(text, ${EXTRACT_MAX_CHARS})
               ) AS body
        FROM article_extracts
        WHERE news_id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
          AND status = 'ok'
      `),
    );
    const byId = new Map(rows.map((r) => [Number(r.newsId), r.body]));
    for (const c of citations) {
      if (c.newsId !== null && byId.has(c.newsId)) {
        c.body = byId.get(c.newsId)?.slice(0, EXTRACT_MAX_CHARS) ?? null;
      }
    }
  } catch (err) {
    // Sin body se responde igual (como antes de esta mejora).
    console.warn(
      "[ask] attachExtracts falló:",
      err instanceof Error ? err.message.slice(0, 120) : err,
    );
  }
}
