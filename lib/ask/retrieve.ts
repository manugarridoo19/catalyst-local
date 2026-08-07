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
import {
  earningsBars,
  harvestBodies,
  pendingDeals,
  selectForwardCandidates,
  systematicSellers,
  type EarningsBar,
  type ForwardCandidate,
  type PendingDeal,
  type SystematicSeller,
} from "@/lib/ask/forward";
import { DECISION_NOISE, PREVIEW_NOISE, type AskIntent } from "@/lib/ask/intent";
import { surprisePct, type EarningsSurprise } from "@/lib/earnings/surprise";
import { getSurpriseHistory, type SurpriseHistoryRow } from "@/lib/earnings/queries";
import { parseAttributions, type Attribution } from "@/lib/coach/frames";
import { COMMON_WORD_DENYLIST } from "@/lib/tickers/alias-denylist";
import { mentionsTicker } from "@/lib/providers/google-news-tickers";

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
  /** Cómo llegó aquí — se pinta en la UI y ayuda a depurar el retrieval.
   *  "forward" = entró por peso de CATEGORÍA prospectiva, no por impacto
   *  ni por semejanza (ver lib/ask/forward.ts).
   *  "filing"  = no es una noticia: es el documento de la propia empresa
   *  (comunicado de resultados). Fuente primaria, va siempre la primera. */
  via: "vector" | "lexical" | "forward" | "filing";
  /** Categoría editorial, cuando se conoce (sólo canal forward: el
   *  snapshot de news_embeddings no la guarda). */
  category?: string | null;
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
  /** La VARA del próximo trimestre, no sólo la fecha. Estaba en la tabla
   *  desde el principio y /ask no la leía: "reporta el 26-oct" no dice si
   *  la noticia será buena; "reporta el 26-oct con consenso de 0,17$" sí. */
  nextEarningsHour: string | null;
  nextEarningsEps: number | null;
  nextEarningsRevenue: number | null;
  /**
   * Cómo se ha MOVIDO esa vara. La primera foto guardada del consenso del
   * próximo evento y la de hoy, con los días entre medias.
   *
   * `earnings_events` sólo guarda el consenso vigente (su `ON CONFLICT DO
   * UPDATE` machaca el anterior en cada refresh), así que "¿han bajado las
   * expectativas?" era incontestable por construcción. Batir una vara que
   * acaban de recortar un 8% no es lo mismo que batir la de hace un mes, y
   * ésa es media respuesta a "cómo se espera que salga".
   *
   * `null` mientras `earnings_estimate_snapshots` no tenga dos capturas del
   * mismo evento — la serie empieza el 2026-08-07 y no se puede reconstruir
   * hacia atrás (Finnhub free no sirve consensos históricos: medido, 0 filas
   * para NU en cualquier ventana pasada).
   */
  consensusTrend: {
    firstSeenOn: string;
    daysAgo: number;
    epsThen: number | null;
    revenueThen: number | null;
  } | null;
  /**
   * ¿Bate esta empresa sistemáticamente? Un trimestre suelto no lo dice.
   *
   * `getSurpriseHistory` estaba escrita desde el 29-07 con su lector en
   * /ticker y /ask nunca la llamó. Hoy devuelve pocas filas —el barrido
   * empezó en julio y hay un trimestre por símbolo—, así que su valor es
   * ACUMULATIVO: crece sola porque `earnings_reports` no purga.
   */
  surpriseHistory: SurpriseHistoryRow[];
  lastPick: { thesis: string; generatedAt: string } | null;
  newsCount7d: number;
  avgSentiment7d: number | null;
};

/**
 * El comunicado de resultados de la propia empresa, ya leído (8-K item 2.02,
 * exhibit 99.1 → `lib/ai/earnings-report.ts`).
 *
 * ⚠️ Esta tabla se escribía desde la Fase 3 y NADIE la leía — ni /ask, ni la
 * página de ticker, ni la revisión de cartera (auditado 2026-07-29: el único
 * `earningsReports` del repo fuera del schema era su propio INSERT). Es el
 * agujero que hacía que preguntar "¿qué dicen del earnings de $SOFI?"
 * devolviera prensa parafraseada mientras el comunicado leído —con las
 * cifras, la guía y lo que el management NO dijo— estaba en la BD.
 *
 * Es material de PRIMERA MANO: no es una noticia sobre el trimestre, es el
 * trimestre. En el prompt va antes que ninguna cita.
 */
export type EarningsRead = {
  symbol: string;
  filingDate: string;
  reportDate: string | null;
  headline: string | null;
  summary: string[];
  readBetweenLines: string | null;
  exhibitUrl: string;
  /** Consenso del trimestre que ESTE comunicado responde (casado por fecha
   *  contra earnings_events). Sin él no se puede decir si batió o falló. */
  epsEstimate: number | null;
  revenueEstimate: number | null;
  /** La sorpresa, YA CALCULADA. Ver `surprisePct`. */
  surprises: EarningsSurprise[];
  /** Qué se movió y a qué lo atribuye la EMPRESA, del mismo extractor que
   *  alimenta al coach (2026-07-31). Es lo que permite que el modo decisión
   *  convierta "ingresos récord y guía elevada" en PRESIÓN DURA con lado —
   *  sin esto, los fundamentales sólo entraban como citas blandas y la mesa
   *  quedaba desequilibrada hacia recortar (beta, peso, ventas de insiders
   *  sí eran duras; el trimestre excepcional no). */
  attributions: Attribution[];
};

// `surprisePct` y `EarningsSurprise` viven en `lib/earnings/surprise.ts` desde
// el 2026-08-07 (módulo hoja, sin BD) y se RE-EXPORTAN aquí: `earnings/queries`
// las importaba de este archivo, así que dejarlas aquí impedía que /ask
// llamase a `getSurpriseHistory` sin cerrar un ciclo. Nadie tuvo que cambiar
// su import.
export { surprisePct };
export type { EarningsSurprise };

/**
 * Riesgo ESTRUCTURAL de un símbolo: lo que no cambia con la noticia del día.
 *
 * Estos dos datos llevaban meses en la BD y la respuesta de decisión no los
 * leía, aun siendo los que cualifican una posición grande: un 27% con beta
 * 1,9 no es el mismo 27% que con beta 0,8, y el days-to-cover de FINRA dice
 * cuánta gente tiene la apuesta contraria puesta y cuánto tardaría en
 * deshacerla. Ninguno de los dos es un precio: no repiten lo que el usuario
 * ya ve en su bróker, que es la regla que gobierna todo este modo.
 */
export type RiskFact = {
  symbol: string;
  beta: number | null;
  pe: number | null;
  daysToCover: number | null;
  /** Interés corto de la última liquidación contra la anterior. La
   *  DERIVADA es la señal: un DTC alto y ESTABLE es estructura del valor;
   *  uno que sube rápido es gente tomando posición contra él ahora. */
  shortChangePct: number | null;
};

/** Material prospectivo. Sólo se levanta para preguntas de DECISIÓN: son
 *  las únicas donde "qué está comprometido a pasar y aún no ha pasado"
 *  manda sobre "qué se publicó". Cinco queries más, cero cuota de IA. */
export type AskForward = {
  bars: EarningsBar[];
  sellers: SystematicSeller[];
  deals: PendingDeal[];
  risk: RiskFact[];
};

export type Retrieval = {
  symbols: string[];
  /** Qué clase de pregunta se recuperó. Decide la FORMA de la respuesta en
   *  `answerShape` y qué canales se usaron aquí. */
  intent: AskIntent;
  citations: Citation[];
  facts: StructuredFacts[];
  /** Comunicados de resultados leídos de los símbolos de la pregunta. */
  earnings: EarningsRead[];
  forward: AskForward;
  /** true si el canal vectorial pudo usarse (sesión del dueño con cuota). */
  vectorUsed: boolean;
  /** Cuántos cuerpos se salieron a buscar en esta pregunta y cuántos
   *  llegaron. Si es 0/12 el archivo no dio material y la respuesta debe
   *  decirlo en vez de fingir profundidad (mismo criterio que ForwardLayer). */
  harvested: number;
  attempted: number;
  bodiesAvailable: number;
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
 * ¿Es esta palabra suelta demasiado corriente para ser el alias de una
 * empresa dentro de una PREGUNTA?
 *
 * El guard de los tokens en mayúsculas sólo cubría su propio canal; el de
 * alias entraba sin filtro. Medido el 2026-07-30 con "¿es buena IDEA dejar
 * correr $MSFT…?": la pregunta consultaba también IACO, cuyo alias es
 * "Idea" — con sus agregados SQL, sus noticias y un bloque de presiones
 * colgando de una empresa que no pintaba nada en la pregunta.
 *
 * Reusa `COMMON_WORD_DENYLIST`, que es la fuente ÚNICA del proyecto para
 * esto (extractor + enricher ya la comparten, y forkarla está prohibido por
 * convención), y le suma el vocabulario de la duda, que es específico de
 * este canal: en un titular no aparece "vendemos", en una pregunta sí.
 */
function isCommonWord(word: string): boolean {
  const bare = word.normalize("NFD").replace(/\p{Diacritic}/gu, "");
  return (
    COMMON_WORD_DENYLIST.has(word) ||
    COMMON_WORD_DENYLIST.has(bare) ||
    DECISION_NOISE.has(bare) ||
    STOPWORDS.has(word) ||
    STOPWORDS.has(bare)
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
      if (n === 1 && (isCommonWord(g) || g.length < 3)) continue;
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

/**
 * Palabras con contenido de la pregunta, para el canal léxico.
 *
 * En una pregunta de DECISIÓN el vocabulario de la decisión se come las 6
 * plazas ("buena", "idea", "dejar", "correr", "vendemos", "parte") y ninguna
 * describe una noticia — encima "parte" y "correr" casan por subcadena con
 * medio archivo. Se purgan: lo que queda es lo que sí nombra algo del mundo
 * ("resultados", "antitrust", "guidance"), y si no queda nada el canal cae
 * al filtro por símbolo, que es lo correcto.
 */
export function keywords(question: string, intent: AskIntent = "archive"): string[] {
  // El término que viaja al ILIKE conserva sus tildes (un titular en
  // español las lleva y `ILIKE '%opinion%'` no casa "opinión"); la
  // comparación contra las listas sí se hace sin ellas, que es donde están
  // escritas. Dos formas de la misma palabra, cada una donde toca.
  const bare = (w: string) => w.normalize("NFD").replace(/\p{Diacritic}/gu, "");
  return [
    ...new Set(
      question
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, " ")
        .split(/\s+/)
        .filter(
          (w) =>
            w.length >= 4 &&
            !STOPWORDS.has(w) &&
            !STOPWORDS.has(bare(w)) &&
            !(intent === "decision" && DECISION_NOISE.has(bare(w))) &&
            !(intent === "preview" && PREVIEW_NOISE.has(bare(w))),
        ),
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

/**
 * Cuántas plazas puede llevarse el tramo GLOBAL cuando la pregunta NOMBRA un
 * símbolo. Es una cuota y no un umbral, y el porqué está medido.
 *
 * Hasta el 2026-08-07 los dos tramos pedían `ceil(limit/2)` cada uno, así que
 * la MITAD de las plazas estaba reservada por construcción a ítems que no
 * hablaban del valor preguntado. Medido con "¿cómo se espera que sea la
 * earnings report de $NU?": 10 de 20 citas eran de NuScale (SMR), Novartis,
 * Novo Nordisk, Northrop Grumman y Nucor — 2.507 chars del prompt gastados en
 * los resultados de otras cinco empresas, y el canal léxico sin una sola
 * plaza porque el bucle de dedup cortaba en `limit` antes de llegar a él.
 *
 * Por qué NO se arregla con la distancia: los ajenos entraron a 0,298-0,310 y
 * los de NU estaban en 0,250-0,327. Se SOLAPAN, porque "NuScale + earnings"
 * es de verdad vecino semántico de "earnings de NU" — el embedding no se
 * equivoca, es que la pregunta no es semántica sino de pertenencia. Cualquier
 * umbral que dejara fuera a Novartis dejaría fuera también a media NU.
 *
 * El tramo global se queda porque su caso de uso es real (el competidor que
 * explica el movimiento, la regulación sectorial), pero es una guarnición.
 */
const VECTOR_GLOBAL_QUOTA = 3;

/** Por debajo de esto, "el archivo tiene material de este valor" es falso y
 *  la pregunta se trata como temática. Ver el comentario de `globalLimit`. */
const VECTOR_OWN_THIN = 5;

async function vectorSearch(
  queryVec: number[],
  symbols: string[],
  limit: number,
): Promise<Citation[]> {
  const vec = `[${queryVec.join(",")}]`;
  // Con símbolos: primero los que hablan de ESE ticker, y con TODO el
  // presupuesto a su disposición — antes pedía la mitad y devolvía menos
  // material del que el archivo tenía sobre el valor preguntado.
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
  // El tramo global se abre en proporción INVERSA a lo que el archivo tenga
  // del valor preguntado.
  //
  // - Sin símbolos, ES el canal: la pregunta es temática y no hay
  //   pertenencia que exigir.
  // - Con cobertura propia de sobra, se cierra. Medido con NU: sus 3 plazas
  //   se las llevaban NuScale, Novo Nordisk y Novartis, vecinas del
  //   embedding por el PREFIJO DEL NOMBRE ("Nu…", "No…") y no por el tema.
  //   Teniendo 15 noticias del propio valor, una cita ajena no es contexto:
  //   es una plaza menos.
  // - Con cobertura propia ESCASA se abre entero, y esta rama no es teórica:
  //   `extractQuestionSymbols` acierta casi siempre pero no siempre, y "¿qué
  //   se ha dicho de los centros de datos de IA?" extrae **IA** como ticker.
  //   Un símbolo sin nada en el archivo es indistinguible de una pregunta
  //   temática, y tratarlo como específico dejaba esa pregunta en 3 citas.
  //   Vale igual para un ticker legítimo recién llegado al universo.
  const own = filtered.length;
  const globalLimit =
    symbols.length === 0
      ? limit
      : own >= Math.ceil(limit / 2)
        ? 0
        : own < VECTOR_OWN_THIN
          ? limit - own
          : Math.max(0, Math.min(VECTOR_GLOBAL_QUOTA, limit - own));
  // Con símbolos el tramo global EXCLUYE los del propio símbolo. Si no, sus
  // 3 plazas se las llevarían las mismas filas que ya trae `filtered` (son
  // las más cercanas del archivo entero, no sólo del ticker), el dedup las
  // tiraría y la cuota compraría cero diversidad — que es justo lo contrario
  // de para lo que existe el segundo tramo.
  const global = globalLimit
    ? unwrapRows<Row>(
        await db.execute(sql`
          SELECT ${SELECT_COLS}, (embedding <=> ${vec}::halfvec)::float8 AS dist
          FROM news_embeddings
          ${
            symbols.length
              ? sql`WHERE NOT (symbols && ARRAY[${list(symbols)}]::text[])`
              : sql``
          }
          ORDER BY embedding <=> ${vec}::halfvec
          LIMIT ${globalLimit}
        `),
      )
    : [];
  return rowsToCitations([...filtered, ...global], "vector");
}

async function lexicalSearch(
  question: string,
  symbols: string[],
  limit: number,
  intent: AskIntent,
): Promise<Citation[]> {
  const terms = keywords(question, intent);
  const termConds: SQL[] = terms.map(
    (t) => sql`(headline ILIKE ${"%" + t + "%"} OR summary ILIKE ${"%" + t + "%"})`,
  );

  // CON SÍMBOLO, el filtro es CONJUNTIVO: del ticker preguntado Y que hable
  // del tema. Hasta el 2026-08-07 los dos iban unidos por OR y el orden era
  // `published_at DESC`, así que la condición de símbolo no restringía nada —
  // sólo añadía candidatos, y ganaban los más RECIENTES de todo el archivo
  // que casaran cualquier término suelto. Medido con la pregunta de NU: 0 de
  // 10 filas del canal léxico hablaban de NU.
  //
  // No se ve en la superficie del dueño porque ahí el vectorial tapa el
  // agujero. Se ve donde no hay vectorial: el Worker ANÓNIMO (`allowLlm`
  // false) y el dueño con el embed caído — es decir, justo el modo degradado
  // que existe para seguir respondiendo cuando falla la cuota.
  //
  // Si la conjunción se queda corta se RELAJA a sólo el símbolo, nunca a
  // sólo los términos: sin el ticker la fila no responde a la pregunta.
  if (symbols.length) {
    const symCond = sql`symbols && ARRAY[${list(symbols)}]::text[]`;
    const where = termConds.length
      ? sql`${symCond} AND (${sql.join(termConds, sql` OR `)})`
      : symCond;
    const strict = unwrapRows<Row>(
      await db.execute(sql`
        SELECT ${SELECT_COLS}
        FROM news_embeddings
        WHERE ${where}
        ORDER BY published_at DESC
        LIMIT ${limit}
      `),
    );
    if (strict.length >= limit || !termConds.length) {
      return rowsToCitations(strict, "lexical");
    }
    // Segundo tramo: el resto del ticker por recencia. El dedup de `retrieve`
    // se encarga de los solapes, así que no hace falta excluirlos aquí.
    const loose = unwrapRows<Row>(
      await db.execute(sql`
        SELECT ${SELECT_COLS}
        FROM news_embeddings
        WHERE ${symCond}
        ORDER BY published_at DESC
        LIMIT ${limit}
      `),
    );
    return rowsToCitations([...strict, ...loose], "lexical");
  }

  if (!termConds.length) return [];
  const rows = unwrapRows<Row>(
    await db.execute(sql`
      SELECT ${SELECT_COLS}
      FROM news_embeddings
      WHERE ${sql.join(termConds, sql` OR `)}
      ORDER BY published_at DESC
      LIMIT ${limit}
    `),
  );
  return rowsToCitations(rows, "lexical");
}

/**
 * Beta, PER y presión de cortos, en UNA query por tabla para todos los
 * símbolos (no una por símbolo: el driver HTTP de Neon hace un fetch
 * independiente por query y en serie se nota).
 *
 * `beta`/`pe` llegan como TEXT de FMP y el cast a float8 va en SQL, no en
 * TS: así un valor basura ("" o "N/A") cae como NULL en vez de convertirse
 * en NaN y propagarse. Mismo criterio que `lib/ask/portfolio.ts`.
 *
 * Coste CERO de cuota FMP: `ticker_fundamentals` está cacheada a 7 días y
 * esto sólo lee. Nunca disparar una llamada a FMP desde aquí — son 250/día
 * para todo el proyecto y una pregunta no puede gastarlas.
 */
async function riskFacts(symbols: string[]): Promise<RiskFact[]> {
  if (!symbols.length) return [];
  const syms = list(symbols);
  const [fndR, shrR] = await Promise.all([
    db.execute(sql`
      SELECT symbol,
             NULLIF(regexp_replace(COALESCE(beta,''), '[^0-9.\\-]', '', 'g'), '')::float8 AS beta,
             NULLIF(regexp_replace(COALESCE(pe,''), '[^0-9.\\-]', '', 'g'), '')::float8 AS pe
      FROM ticker_fundamentals WHERE symbol IN (${syms})
    `),
    // Las DOS últimas liquidaciones de FINRA por símbolo: la vigente y la
    // anterior, para poder dar la derivada y no sólo el nivel.
    db.execute(sql`
      SELECT symbol, dtc, qty, prev FROM (
        SELECT symbol, days_to_cover::float8 AS dtc,
               current_short_qty::float8 AS qty, previous_short_qty::float8 AS prev,
               ROW_NUMBER() OVER (PARTITION BY symbol ORDER BY settlement_date DESC) AS rn
        FROM short_interest WHERE symbol IN (${syms})
      ) t WHERE rn = 1
    `),
  ]);
  const fnd = new Map(
    unwrapRows<{ symbol: string; beta: number | null; pe: number | null }>(fndR).map((r) => [
      r.symbol,
      r,
    ]),
  );
  const shr = new Map(
    unwrapRows<{ symbol: string; dtc: number | null; qty: number | null; prev: number | null }>(
      shrR,
    ).map((r) => [r.symbol, r]),
  );
  return symbols.map((symbol) => {
    const s = shr.get(symbol);
    // El porcentaje se calcula AQUÍ y no en el prompt: es la regla dura del
    // proyecto (si el número sale en pantalla, lo calcula el código).
    const shortChangePct =
      s?.qty != null && s.prev != null && s.prev > 0
        ? ((s.qty - s.prev) / s.prev) * 100
        : null;
    return {
      symbol,
      beta: fnd.get(symbol)?.beta ?? null,
      pe: fnd.get(symbol)?.pe ?? null,
      daysToCover: s?.dtc ?? null,
      shortChangePct,
    };
  });
}

/** Agregados reales por símbolo. Aquí es donde salen los números.
 *  Las 6 queries del símbolo (y los hasta 3 símbolos) van en Promise.all:
 *  el driver HTTP hace un fetch independiente por query, así que en serie
 *  eran ~18 round-trips encadenados de latencia pura. */
async function factsForSymbol(
  symbol: string,
  /** Fechas de earnings cuyo comunicado YA hemos leído: no son "próximos".
   *  Llega como PROMESA a propósito — así la query de comunicados vuela en
   *  paralelo con estas 6 en vez de encadenarse delante (el driver HTTP de
   *  Neon hace un fetch por query y la latencia en serie se nota). */
  reportedP: Promise<Set<string>>,
): Promise<StructuredFacts> {
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
  // Nota: el nombre del declarante se DESESCAPA abajo. El XML de portada del
  // 13D/G trae entidades (`Baillie Gifford &amp; Co`) y el prompt las pasaba
  // literales al modelo, que las copiaba tal cual a la respuesta.
  // earnings_events.date es TEXT yyyy-mm-dd (sortable) — se compara como
  // texto contra la fecha de hoy, no con operadores de fecha.
  //
  // Se piden DOS y no una: `date >= current_date` incluye el trimestre que
  // se publica HOY, así que el día del resultado /ask anunciaba como
  // "próximos resultados" uno que ya había salido esa mañana. El que ya
  // tiene comunicado leído se descarta arriba y queda el siguiente de
  // verdad. Y viajan las estimaciones, que es la vara a batir.
  const earnQ = db.execute(sql`
        SELECT date AS d, hour,
               NULLIF(regexp_replace(COALESCE(eps_estimate,''),'[^0-9.\\-]','','g'),'')::float8 AS eps,
               NULLIF(regexp_replace(COALESCE(revenue_estimate,''),'[^0-9.\\-]','','g'),'')::float8 AS revenue
        FROM earnings_events
        WHERE symbol = ${symbol} AND date >= to_char(current_date, 'YYYY-MM-DD')
        ORDER BY date ASC LIMIT 2
      `);
  // La PRIMERA foto guardada del consenso del próximo evento. Se compara
  // arriba contra la vigente para dar la revisión. `DISTINCT ON` con el
  // orden ascendente de `captured_on` = la más antigua de cada evento.
  const trendQ = db.execute(sql`
        SELECT DISTINCT ON (event_date)
               event_date AS "eventDate", captured_on AS "capturedOn",
               NULLIF(regexp_replace(COALESCE(eps_estimate,''),'[^0-9.\\-]','','g'),'')::float8 AS eps,
               NULLIF(regexp_replace(COALESCE(revenue_estimate,''),'[^0-9.\\-]','','g'),'')::float8 AS revenue,
               (current_date - captured_on::date)::int AS "daysAgo"
        FROM earnings_estimate_snapshots
        WHERE symbol = ${symbol} AND event_date >= to_char(current_date, 'YYYY-MM-DD')
        ORDER BY event_date ASC, captured_on ASC
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

  // El historial de sorpresas es una query aparte (`lib/earnings/queries`,
  // fuente única — la comparte con /ticker) y vuela con las demás.
  const historyQ = getSurpriseHistory(symbol, 8).catch(() => [] as SurpriseHistoryRow[]);

  const [metaR, insiderR, stakesR, earnR, pickR, covR, trendR, history] =
    await Promise.all([
      metaQ, insiderQ, stakesQ, earnQ, pickQ, covQ, trendQ, historyQ,
    ]);
  const [meta] = unwrapRows<{ name: string | null }>(metaR);
  const [insider] = unwrapRows<{
    net7: number | null;
    net30: number | null;
    buyers: number;
    sellers: number;
  }>(insiderR);
  const stakes = unwrapRows<{ filer: string | null; pct: number | null; filedAt: string }>(
    stakesR,
  ).map((s) => ({ ...s, filer: decodeXmlEntities(s.filer) }));
  const earnRows = unwrapRows<{
    d: string;
    hour: string | null;
    eps: number | null;
    revenue: number | null;
  }>(earnR);
  const [pick] = unwrapRows<{ thesis: string; generatedAt: string }>(pickR);
  const [cov] = unwrapRows<{ n: number; avg: number | null }>(covR);

  // El trimestre cuyo comunicado ya hemos leído NO es "el próximo".
  const reported = await reportedP;
  const earn = earnRows.find((r) => !reported.has(r.d)) ?? null;

  // La tendencia es del MISMO evento que se anuncia como próximo. Casarlas
  // por fecha y no quedarse con la primera fila evita el caso en que el
  // evento de la foto ya se publicó y el "próximo" es otro: ahí la revisión
  // hablaría de una vara distinta de la que se enseña.
  const trendRows = unwrapRows<{
    eventDate: string;
    capturedOn: string;
    eps: number | null;
    revenue: number | null;
    daysAgo: number;
  }>(trendR);
  const t = earn ? trendRows.find((x) => x.eventDate === earn.d) : undefined;
  // Una sola captura no es una tendencia: `daysAgo === 0` significa que la
  // serie empezó hoy para este evento y no hay contra qué comparar. Decir
  // "sin cambios" ahí sería afirmar algo que nadie ha medido — el mismo
  // criterio que hizo omitir la comparación de cortos cuando falta la
  // liquidación anterior (2026-07-31).
  const consensusTrend =
    t && t.daysAgo > 0
      ? {
          firstSeenOn: t.capturedOn,
          daysAgo: t.daysAgo,
          epsThen: t.eps,
          revenueThen: t.revenue,
        }
      : null;

  return {
    symbol,
    name: meta?.name ?? null,
    insiderNet7d: insider?.net7 ?? null,
    insiderNet30d: insider?.net30 ?? null,
    insiderBuyers30d: insider?.buyers ?? 0,
    insiderSellers30d: insider?.sellers ?? 0,
    stakes,
    nextEarnings: earn?.d ?? null,
    nextEarningsHour: earn?.hour ?? null,
    nextEarningsEps: earn?.eps ?? null,
    nextEarningsRevenue: earn?.revenue ?? null,
    consensusTrend,
    surpriseHistory: history,
    lastPick: pick ?? null,
    newsCount7d: cov?.n ?? 0,
    avgSentiment7d: cov?.avg ?? null,
  };
}

async function structuredFacts(
  symbols: string[],
  reportedBySymbol: Promise<Map<string, Set<string>>>,
): Promise<StructuredFacts[]> {
  return Promise.all(
    symbols.slice(0, 3).map((s) =>
      factsForSymbol(
        s,
        reportedBySymbol.then((m) => m.get(s) ?? new Set<string>()),
      ),
    ),
  );
}

/** Cuántos días atrás sigue siendo "el último trimestre". Un comunicado de
 *  hace 4 meses ya no explica el precio de hoy y confundiría más que ayuda:
 *  100 días cubre el trimestre vigente con holgura sin colarse en el
 *  anterior (ciclo ~90d). */
const EARNINGS_READ_MAX_AGE_DAYS = 100;

/**
 * El último comunicado leído de cada símbolo, con el consenso de SU
 * trimestre al lado. Una query para todos los símbolos.
 *
 * El casado con `earnings_events` va por fecha con ventana de ±5 días
 * (`report_date` es lo que declara el propio filing y `date` lo que dice el
 * calendario de Finnhub; no siempre coinciden al día) y se queda con el más
 * cercano. Sin este join el modelo puede decir "récord de ingresos" pero no
 * si eso batió o falló, que es la única pregunta que importa.
 */
// Exportada (2026-08-06) para que la REVISIÓN DE CARTERA reciba lo mismo
// que /ask. Era privada, y esa es la razón mecánica de que la revisión
// opinara sin los comunicados: el arreglo del 31-07 que equilibró la mesa
// vivía detrás de una función que la otra superficie no podía llamar.
export async function earningsReads(symbols: string[]): Promise<EarningsRead[]> {
  if (!symbols.length) return [];
  const rows = unwrapRows<{
    symbol: string;
    filingDate: string;
    reportDate: string | null;
    headline: string | null;
    summary: string;
    readBetweenLines: string | null;
    exhibitUrl: string;
    eps: number | null;
    revenue: number | null;
    revenueActual: number | null;
    revenueBasis: string | null;
    epsActual: number | null;
    epsBasis: string | null;
    attribution: string | null;
  }>(
    await db.execute(sql`
      SELECT r.symbol, r.filing_date AS "filingDate", r.report_date AS "reportDate",
             r.headline, r.summary, r.read_between_lines AS "readBetweenLines",
             r.exhibit_url AS "exhibitUrl",
             -- El snapshot manda: earnings_events borra las fechas pasadas
             -- en cada refresh, así que el join en vivo (e.*) solo responde
             -- los primeros días tras el comunicado. El COALESCE mantiene el
             -- comportamiento viejo para filas anteriores al snapshot.
             COALESCE(r.eps_estimate, e.eps) AS eps,
             COALESCE(r.revenue_estimate, e.revenue) AS revenue,
             r.revenue_actual AS "revenueActual", r.revenue_basis AS "revenueBasis",
             r.eps_actual AS "epsActual", r.eps_basis AS "epsBasis",
             r.attribution
      FROM (
        SELECT *, ROW_NUMBER() OVER (PARTITION BY symbol ORDER BY filing_date DESC) AS rn
        FROM earnings_reports
        WHERE symbol IN (${list(symbols)})
          AND filing_date::date >= current_date - ${sql.raw(String(EARNINGS_READ_MAX_AGE_DAYS))}
      ) r
      LEFT JOIN LATERAL (
        SELECT NULLIF(regexp_replace(COALESCE(eps_estimate,''),'[^0-9.\\-]','','g'),'')::float8 AS eps,
               NULLIF(regexp_replace(COALESCE(revenue_estimate,''),'[^0-9.\\-]','','g'),'')::float8 AS revenue
        FROM earnings_events ev
        WHERE ev.symbol = r.symbol
          AND ABS(ev.date::date - COALESCE(r.report_date, r.filing_date)::date) <= 5
        ORDER BY ABS(ev.date::date - COALESCE(r.report_date, r.filing_date)::date) ASC
        LIMIT 1
      ) e ON true
      WHERE r.rn = 1
    `),
  );
  return rows.map((r) => {
    const surprises: EarningsSurprise[] = [];
    const rev = surprisePct(r.revenueActual, r.revenue, r.revenueBasis);
    if (rev !== null && r.revenueActual !== null && r.revenue !== null) {
      surprises.push({
        metric: "revenue",
        label: "ingresos",
        actual: r.revenueActual,
        estimate: r.revenue,
        basis: r.revenueBasis as string,
        pct: rev,
      });
    }
    const eps = surprisePct(r.epsActual, r.eps, r.epsBasis);
    if (eps !== null && r.epsActual !== null && r.eps !== null) {
      surprises.push({
        metric: "eps",
        label: "BPA",
        actual: r.epsActual,
        estimate: r.eps,
        basis: r.epsBasis as string,
        pct: eps,
      });
    }
    return {
      symbol: r.symbol,
      filingDate: r.filingDate,
      reportDate: r.reportDate,
      headline: r.headline,
      // `summary` se guarda como JSON string (array de bullets). Un fallo de
      // parseo no debe tumbar la pregunta entera: degrada a texto plano.
      summary: parseSummary(r.summary),
      readBetweenLines: r.readBetweenLines,
      exhibitUrl: r.exhibitUrl,
      epsEstimate: r.eps,
      revenueEstimate: r.revenue,
      surprises,
      attributions: parseEarningsAttributions(r.attribution),
    };
  });
}

/** El JSON de atribución de la fila, tolerante a corrupto: una fila mala no
 *  puede tumbar la pregunta — esa lectura simplemente no aporta presiones. */
function parseEarningsAttributions(raw: string | null): Attribution[] {
  if (!raw) return [];
  try {
    return parseAttributions(JSON.parse(raw));
  } catch {
    return [];
  }
}

function parseSummary(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.filter((b): b is string => typeof b === "string" && b.trim() !== "");
    }
  } catch {
    // cae abajo
  }
  return raw.trim() ? [raw.trim()] : [];
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
  /** Clasificación de la pregunta. `decision` enciende el canal prospectivo
   *  y purga el vocabulario de decisión del canal léxico. */
  intent?: AskIntent;
  /** false = no salir a la red a extraer cuerpos que faltan. Los anónimos
   *  del Worker van así: no pueden disparar N fetches salientes. */
  harvest?: boolean;
  harvestBudgetMs?: number;
  /** Símbolos del turno ANTERIOR de la conversación. Solo entran cuando la
   *  pregunta nueva no nombra ninguno: "¿y a largo plazo?" tras hablar de
   *  SOFI tiene que seguir hablando de SOFI, y sin esto el retrieval se
   *  quedaba sin referente y la respuesta salía genérica. Si la pregunta
   *  nueva SÍ nombra símbolos, mandan los nuevos — cambiar de valor en
   *  mitad de la conversación es legítimo. */
  carrySymbols?: string[];
}): Promise<Retrieval> {
  const { question, queryVec } = opts;
  const intent: AskIntent = opts.intent ?? "archive";
  const limit = opts.limit ?? 20;
  // Cada canal pide el presupuesto ENTERO y el reparto lo decide el bucle de
  // dedup de abajo, por orden de prioridad. Antes cada uno pedía `ceil/2`,
  // que no era un reparto sino un tope: el vectorial se llevaba sus 10 (la
  // mitad de otras empresas, ver VECTOR_GLOBAL_QUOTA) y el léxico se quedaba
  // con las 10 restantes que el `break` de `limit` no le llegaba a dar.
  const extracted = await extractQuestionSymbols(question);
  const symbols = extracted.length ? extracted : (opts.carrySymbols ?? []);
  // Los HECHOS prospectivos (vara de consenso, vendedores sistemáticos,
  // operaciones abiertas, riesgo estructural). Los enciende la decisión —son
  // insumo de `buildDecisionFacts`— y desde el 2026-08-07 también la PREVIA,
  // donde son literalmente el objeto de la pregunta: qué vara hay que batir,
  // quién tiene papel comprometido a colocar, qué operación puede aparecer en
  // el trimestre y cuánta apuesta contraria hay acumulada. Dejarlos apagados
  // ahí era la razón mecánica de que una previa sólo pudiera dar la fecha.
  const forwardOn =
    (intent === "decision" || intent === "preview") && symbols.length > 0;
  // El canal de CITAS por símbolo, en cambio, se enciende siempre que la
  // pregunta nombre un valor (2026-08-07). Es el arreglo del agujero que
  // dejaba una pregunta de archivo leyendo sólo `news_embeddings`, o sea
  // sólo lo que puntuó impacto≥3: medido con NU, 46 noticias en 30 días, 27
  // con CUERPO extraído y sólo 15 embebidas. Doce cuerpos ya pagados —
  // incluidas las piezas que explican la licencia de México y la compra de
  // Banco Porto Real — eran invisibles para /ask por no haber sacado un 3 en
  // una escala pensada para ordenar un feed, no para responder preguntas.
  //
  // Coste: 1 query, cero cuota. Reusa `selectForwardCandidates` en vez de
  // escribir una consulta nueva porque su orden por peso de CATEGORÍA es
  // justo lo que hace falta aquí — y porque dos consultas distintas para lo
  // mismo acaban divergiendo (la lección de `earningsReads` el 06-08).
  const symbolChannel = symbols.length > 0;

  // Se lanza aquí y se pasa SIN await a structuredFacts: las dos cosas
  // vuelan a la vez y los hechos sólo la esperan al final.
  const earningsP = earningsReads(symbols);

  const [vector, lexical, facts, earnings, fwdCandidates, bars, sellers, rawDeals, risk] =
    await Promise.all([
    queryVec ? vectorSearch(queryVec, symbols, limit) : Promise.resolve([]),
    lexicalSearch(question, symbols, limit, intent),
    structuredFacts(
      symbols,
      earningsP.then((rs) => {
        const m = new Map<string, Set<string>>();
        for (const r of rs) {
          const set = m.get(r.symbol) ?? new Set<string>();
          if (r.reportDate) set.add(r.reportDate);
          set.add(r.filingDate);
          m.set(r.symbol, set);
        }
        return m;
      }),
    ),
    earningsP,
    // Canal PROSPECTIVO, sólo en decisiones. Selecciona por peso de
    // CATEGORÍA (MA > GUIDANCE > REGULATORY > …), nunca por impacto: el
    // scoring de impacto premia por definición lo que YA movió el precio,
    // así que en una pregunta de "¿vendo?" la cita mejor rankeada era la
    // crónica de la subida que provocó la pregunta. Es la misma trampa que
    // midió la revisión de cartera el 2026-07-25.
    symbolChannel
      ? selectForwardCandidates(
          symbols,
          // En una DECISIÓN estas citas comparten mesa con el libro de
          // futuros, las presiones y la posición: 3 por símbolo bastan y el
          // resto del cupo es mejor gastarlo en semejanza. En archivo o
          // previa son la ÚNICA vía a los cuerpos ya extraídos, así que se
          // les da sitio de verdad.
          intent === "decision" ? 3 : 8,
        )
      : Promise.resolve([]),
    forwardOn ? earningsBars(symbols) : Promise.resolve([]),
    forwardOn ? systematicSellers(symbols) : Promise.resolve([]),
    forwardOn ? pendingDeals(symbols) : Promise.resolve([]),
    forwardOn ? riskFacts(symbols) : Promise.resolve([]),
  ]);

  // `pendingDeals` levanta TODA noticia de categoría MA ligada al símbolo, y
  // un nombre como MSFT está ligado a media portada de fusiones ajenas.
  // Medido el 2026-07-30: de 12 "operaciones pendientes" de MSFT, la
  // mayoría eran de terceros ("Will SpaceX buy Tesla?"). En la revisión de
  // cartera esto lo filtra después el extractor LLM del libro de futuros;
  // aquí van directas a la respuesta, así que el filtro tiene que ser de
  // código: la operación cuenta sólo si el titular NOMBRA a la empresa.
  const nameBySymbol = new Map(facts.map((f) => [f.symbol, f.name]));
  const deals = rawDeals
    .filter(
      (d) =>
        mentionsTicker(d.headline, d.symbol, nameBySymbol.get(d.symbol) ?? null) &&
        looksLikeDeal(d.headline),
    )
    .slice(0, FORWARD_DEALS_MAX);

  const seen = new Set<string>();
  const seenText = new Set<string>();
  const citations: Citation[] = [];

  // Los comunicados se numeran PRIMERO, y no es cosmética. El orden de las
  // citas es el orden en que el modelo las lee, y quien ocupaba el [1] era
  // la noticia de mejor semejanza — que sobre un día de resultados es la
  // crónica de la caída. Ahora el [1] es el documento de la empresa. Es la
  // misma corrección que la revisión de cartera aplicó el 2026-07-25.
  for (const e of earnings) {
    citations.push({
      n: citations.length + 1,
      via: "filing",
      newsId: null,
      headline: e.headline ?? `${e.symbol}: comunicado de resultados ${e.filingDate}`,
      summary: null,
      url: e.exhibitUrl,
      source: "sec-edgar (8-K ex. 99.1)",
      symbols: [e.symbol],
      publishedAt: `${e.reportDate ?? e.filingDate}T00:00:00Z`,
      impact: 5,
      sentiment: 0,
      category: "EARNINGS",
    });
  }

  // Los candidatos prospectivos van justo detrás de los comunicados y por
  // delante de vectorial y léxico. El orden de las citas es el orden en que
  // el modelo las lee, y en una decisión lo que pesa es lo que sigue
  // abierto, no lo último que se publicó.
  for (const c of fwdCandidates) {
    const key = `n${c.newsId}`;
    if (seen.has(key)) continue;
    const text = normalizeHeadline(c.headline);
    // El dedup TEXTUAL también aquí. Este bucle alimentaba `seenText` y
    // nunca lo consultaba, así que sólo protegía a los canales de abajo y no
    // a sí mismo: medido el 2026-08-07 en la previa de NU, "NU Stock Rises As
    // Nubank Wins Key Mexico Bank License" ocupaba TRES citas —la misma
    // historia por gnews, marketbeat y un agregador—, con tres cuerpos
    // distintos que decían lo mismo. Tres plazas de dieciséis.
    if (text && seenText.has(text)) continue;
    seen.add(key);
    if (text) seenText.add(text);
    citations.push({
      n: citations.length + 1,
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
      body: c.body ? c.body.slice(0, EXTRACT_MAX_CHARS) : null,
    });
  }

  for (const c of [...vector, ...lexical]) {
    const key = c.newsId !== null ? `n${c.newsId}` : c.url;
    if (seen.has(key)) continue;
    seen.add(key);
    // Dedupe TEXTUAL además del de identidad. El mismo teletipo entra por
    // dos fuentes con titular idéntico salvo el sufijo del sindicador
    // ("… By Investing.com"), y ocupaban DOS de las citas del prompt: en la
    // pregunta de SOFI del 2026-07-29, 2 de las 8 citas usadas eran la
    // misma noticia del mínimo de 52 semanas. Slots gastados en repetirse.
    const text = normalizeHeadline(c.headline);
    if (text && seenText.has(text)) continue;
    if (text) seenText.add(text);
    citations.push({ ...c, n: citations.length + 1 });
    if (citations.length >= limit) break;
  }

  await attachExtracts(citations);

  // LA operación que cambia la profundidad de la respuesta. Medido el
  // 2026-07-29 sobre la pregunta de SOFI: de 18 noticias del día, CERO
  // tenían cuerpo extraído, así que el modelo volvía a redactar desde
  // titulares — el mismo fallo que la revisión de cartera ya había medido y
  // resuelto pagando por extraer. Coste: N fetches acotados por reloj y
  // CERO llamadas LLM (allowLlm:false). Queda cacheado en article_extracts,
  // así que repreguntar sobre el mismo tema ya no paga.
  let harvested = 0;
  let attempted = 0;
  if (opts.harvest !== false) {
    const r = await harvestCitationBodies(citations, {
      budgetMs: opts.harvestBudgetMs ?? HARVEST_BUDGET_MS,
    });
    harvested = r.harvested;
    attempted = r.attempted;
    if (harvested > 0) await attachExtracts(citations);
  }

  return {
    symbols,
    intent,
    citations,
    facts,
    earnings,
    forward: { bars, sellers, deals, risk },
    vectorUsed: Boolean(queryVec),
    harvested,
    attempted,
    bodiesAvailable: citations.filter((c) => c.body && c.body.length >= 200).length,
  };
}

/**
 * Prepara la entrada de la PRIMERA llamada LLM de una decisión (el libro de
 * futuros, `lib/ai/forward-ledger.ts`) a partir de las citas ya cosechadas.
 *
 * Se construye desde `citations` y no desde los candidatos prospectivos por
 * dos razones. La primera es de frescura: los cuerpos se cosechan y se
 * adjuntan SOBRE las citas, así que los candidatos originales van con el
 * cuerpo viejo (la revisión de cartera necesita `reloadBodies` justo por
 * esto; aquí no hace falta). La segunda es de cobertura: en /ask también
 * traen cuerpo las citas vectoriales y léxicas, y un compromiso pendiente
 * no deja de serlo por haber entrado al prompt por semejanza.
 *
 * Se exigen ≥200 chars de cuerpo: con un titular suelto no hay plazo ni
 * condición que extraer, y mandarlo es invitar al modelo justo al error que
 * la separación en dos etapas trata de eliminar.
 */
export function ledgerCandidates(r: Retrieval): {
  candidates: ForwardCandidate[];
  numberOf: (newsId: number) => number | undefined;
} {
  const wanted = new Set(r.symbols);
  const byNewsId = new Map<number, number>();
  const candidates: ForwardCandidate[] = [];

  for (const c of r.citations) {
    if (c.newsId === null) continue; // el comunicado ya viaja entero aparte
    if (!c.body || c.body.trim().length < 200) continue;
    // El símbolo del candidato tiene que ser uno de los PREGUNTADOS: un
    // compromiso de otra empresa que aparecía de refilón en el artículo no
    // es material para esta decisión, y el gate del extractor lo tiraría
    // igual — mejor no pagar tokens por él.
    const symbol = c.symbols.find((s) => wanted.has(s));
    if (!symbol) continue;
    byNewsId.set(c.newsId, c.n);
    candidates.push({
      newsId: c.newsId,
      symbol,
      headline: c.headline,
      url: c.url,
      source: c.source,
      publishedAt: c.publishedAt,
      category: c.category ?? null,
      impact: c.impact,
      sentiment: c.sentiment,
      body: c.body,
      hasExtract: true,
    });
  }
  return { candidates, numberOf: (newsId: number) => byNewsId.get(newsId) };
}

/** Titular reducido a su esqueleto comparable: sin mayúsculas, sin
 *  puntuación, sin el sufijo del sindicador ni el nombre del medio tras un
 *  guion. Dos noticias que colapsan al mismo esqueleto son el mismo
 *  teletipo redistribuido. */
/**
 * Las cinco entidades XML predefinidas. No es un decodificador de HTML: los
 * nombres de la portada de un 13D/G vienen de un XML de EDGAR, y ahí sólo
 * pueden aparecer éstas. Un decodificador general traería una dependencia y
 * una superficie de escape que este campo no necesita.
 */
export function decodeXmlEntities(s: string | null): string | null {
  if (!s) return s;
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    // El `&amp;` va el ÚLTIMO: hacerlo antes convertiría `&amp;lt;` —un `&lt;`
    // literal correctamente escapado— en `<`, que es justo lo que el doble
    // escape quería evitar.
    .replace(/&amp;/g, "&");
}

export function normalizeHeadline(h: string): string {
  return h
    .toLowerCase()
    .replace(/\s+(by|via)\s+[a-z0-9.\s-]+$/i, "")
    .replace(/\s+[-–—]\s+[a-z0-9.'\s]{3,30}$/i, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .slice(0, 70);
}

/** Cuántas citas se enriquecen con el cuerpo del artículo (las primeras N,
 *  que son las mejor rankeadas) y cuántos chars viajan de cada una. Acota
 *  los tokens del prompt de /ask: 12×~900 ≈ 2,7k tokens extra como mucho. */
const EXTRACT_MAX_CITATIONS = 12;
const EXTRACT_MAX_CHARS = 900;

/** Presupuesto de PARED de la cosecha de cuerpos. La revisión de cartera usa
 *  20s; aquí se baja a 14 porque una pregunta se escribe y se espera mirando
 *  la pantalla, mientras que la revisión se lanza a sabiendas de que tarda.
 *  Lo que no llegue a tiempo queda cacheado para la siguiente pregunta. */
const HARVEST_BUDGET_MS = 14_000;
/** Cuántas citas sin cuerpo se salen a buscar. Por encima de esto el prompt
 *  no cabría de todos modos y el reloj se agota antes. */
const HARVEST_MAX_CITATIONS = 12;

/** Operaciones pendientes que entran en una respuesta de decisión. Son
 *  contexto, no la respuesta: doce líneas de "operación sin cerrar" ahogan
 *  las dos que de verdad afectan a la posición. */
const FORWARD_DEALS_MAX = 4;

/** Vocabulario que delata una operación de verdad. */
const DEAL_WORDS =
  /\b(acquir\w+|acquisition|merger|merges|merging|deal|takeover|buyout|tender offer|to buy|agrees to|stake in|combination|adquis\w+|adquier\w+|fusi[oó]n|opa|oferta p[uú]blica|compra de)\b/i;

/** Titular que en realidad cuenta un MOVIMIENTO DE PRECIO. */
const PRICE_MOVE =
  /\b(slid\w+|plung\w+|soar\w+|jump\w+|tumbl\w+|rall\w+|sink\w+|surg\w+|drop\w+|spike\w+|climb\w+|cae|caen|sube|suben|desplom\w+|se dispara)\b|\d+(\.\d+)?\s?%/i;

/**
 * ¿Este titular de categoría `MA` es de verdad una operación abierta?
 *
 * `pendingDeals` selecciona por CATEGORÍA, no por contenido, y la categoría
 * es generosa: de los 4 "pendientes" de RKLB (2026-07-30), dos eran "Why
 * Rocket Lab Shares Are Plunging Today" y "Stock Slides 12%". Colarlos hace
 * dos daños a la vez — el bloque afirma que hay una operación sin cerrar
 * donde no la hay, y mete por la puerta de atrás justo el contenido que el
 * prompt de decisión prohíbe: el movimiento de precio que el usuario ya ve
 * en su bróker.
 *
 * La comprobación de que la operación SIGA abierta no se hace aquí (la hace
 * el extractor LLM del libro de futuros, que este camino no usa), y por eso
 * la etiqueta que se pinta en `lib/ask/decision.ts` no lo afirma.
 */
export function looksLikeDeal(headline: string): boolean {
  return DEAL_WORDS.test(headline) && !PRICE_MOVE.test(headline);
}

/** Cosecha los cuerpos que faltan en las mejores citas. Reusa la máquina ya
 *  probada de la revisión de cartera (`harvestBodies`): mismo presupuesto de
 *  reloj, misma concurrencia, mismos fallos cacheados. */
async function harvestCitationBodies(
  citations: Citation[],
  opts: { budgetMs: number },
): Promise<{ harvested: number; attempted: number }> {
  const targets = citations
    .slice(0, HARVEST_MAX_CITATIONS)
    .filter((c) => c.newsId !== null && !c.body)
    .map((c) => ({ newsId: c.newsId, hasExtract: false }));
  if (!targets.length) return { harvested: 0, attempted: 0 };
  try {
    return await harvestBodies(targets, { budgetMs: opts.budgetMs });
  } catch (err) {
    // Sin cosecha se responde igual, con titulares. Nunca tumba la pregunta.
    console.warn(
      "[ask] cosecha de cuerpos falló:",
      err instanceof Error ? err.message.slice(0, 120) : err,
    );
    return { harvested: 0, attempted: targets.length };
  }
}

/**
 * Adjunta a las citas la sustancia del artículo que YA está en
 * `article_extracts` (extraído on-click o pre-enriquecido en el cron).
 * Coste: 1 query por pregunta, cero red y cero LLM — el hueco que tapa es
 * que /ask respondía parafraseando titulares aunque el artículo entero
 * estuviera cacheado en la BD. Best-effort: extracts cascadean con la purga
 * de news a 20d, así que citas viejas van sin body (el snapshot sobrevive).
 */
export async function attachExtracts(citations: Citation[]): Promise<void> {
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
