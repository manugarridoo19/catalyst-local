// Capa prospectiva de la revisión de cartera.
//
// EL PROBLEMA QUE RESUELVE (medido 2026-07-25, no supuesto):
//
// La primera versión de la revisión leía lo obvio — "la acción cae un 8%".
// No era culpa del prompt. Dos causas estructurales:
//
//   1. Las citas se ordenaban por `impact DESC`, y el scoring de impacto
//      premia POR DEFINICIÓN lo que ya movió el precio. La noticia mejor
//      rankeada de una posición que cae es "la posición cae".
//   2. El 97% de las noticias NO tienen cuerpo extraído (META: 26 cuerpos
//      de 785 noticias en 14d; PLTR: 1 de 258). `article_extracts` se
//      rellena al hacer clic en una tarjeta o a 4 por tick de cron. Así
//      que el modelo redactaba desde TITULARES, y un titular es lo obvio.
//
// La sustancia con futuro dentro ("sujeto a aprobación regulatoria",
// "espera cerrar en el primer trimestre", "eleva la guía a") vive en el
// cuerpo. Este módulo va a buscarla antes de que el modelo escriba.
//
// Tres cambios de eje respecto a `lib/ask/portfolio.ts`:
//   - Se selecciona por CATEGORÍA, no por impacto.
//   - Ventana de 20 días (el máximo que permite la purga de `news`), no 14.
//   - Se PAGA por extraer cuerpos que faltan, con presupuesto acotado.

import { sql, type SQL } from "drizzle-orm";
import { db, unwrapRows } from "@/lib/db";
import { getArticleDetail } from "@/lib/articles/enrich";

/**
 * Peso prospectivo por categoría editorial. No es una opinión sobre qué
 * noticia es más importante: es cuánta probabilidad hay de que el CUERPO
 * contenga un compromiso futuro.
 *
 *   MA          — una operación anunciada trae plazo de cierre, condiciones
 *                 suspensivas, financiación y aprobaciones pendientes.
 *   GUIDANCE    — una guía ES una afirmación sobre el futuro.
 *   REGULATORY  — expedientes con calendario propio.
 *   LEGAL       — juicios con fecha de vista señalada.
 *   PRODUCT     — lanzamientos y contratos con fecha de entrega.
 *   EARNINGS    — mitad retrospectiva (el trimestre) mitad prospectiva (la
 *                 guía del siguiente), de ahí el peso intermedio.
 *   ANALYST     — un precio objetivo es una opinión, no un compromiso.
 *   MACRO/OTHER — ruido de fondo para este propósito.
 */
const CATEGORY_FORWARD_WEIGHT: Record<string, number> = {
  MA: 10,
  GUIDANCE: 9,
  REGULATORY: 8,
  LEGAL: 6,
  PRODUCT: 5,
  EARNINGS: 4,
  ANALYST: 2,
  INSIDER: 2,
  MACRO: 1,
  OTHER: 1,
};

/** Ventana máxima: `news` se purga a 20 días y sin fila en `news` no hay
 *  categoría, ni cuerpo, ni posibilidad de extraer (article_extracts
 *  cascadea). Pedir 60 días aquí devolvería menos, no más. */
const FORWARD_WINDOW_DAYS = 20;

export type ForwardCandidate = {
  newsId: number;
  symbol: string;
  headline: string;
  url: string;
  source: string;
  publishedAt: string;
  category: string | null;
  impact: number;
  sentiment: number;
  /** Cuerpo ya extraído, si lo había. */
  body: string | null;
  hasExtract: boolean;
};

function symbolList(symbols: string[]): SQL {
  return sql.join(symbols.map((s) => sql`${s}`), sql`, `);
}

/**
 * Candidatos a contener futuro, por posición.
 *
 * Ordena por peso de categoría y sólo después por recencia. El impacto
 * entra como ÚLTIMO criterio de desempate y no como primero — invertir ese
 * orden es exactamente lo que hacía que la revisión leyera lo obvio.
 *
 * `perCategory` (2026-08-07) impide que una sola categoría monopolice el
 * cupo del símbolo. El peso de arriba es una jerarquía ESTRICTA, así que
 * mientras queden noticias de MA ninguna de PRODUCT entra: medido, RKLB
 * gastaba sus 4 plazas en 4 artículos de la compra de Iridium y ninguno de
 * sus ~70 cuerpos de PRODUCT (Neutron, contratos con la Space Force) llegaba
 * jamás al prompt. Con el tope por categoría la jerarquía sigue mandando el
 * ORDEN pero deja de decidir el CONJUNTO. Degrada sola: si el símbolo sólo
 * tiene noticias de una categoría, se devuelven las que haya.
 */
export async function selectForwardCandidates(
  symbols: string[],
  perSymbol = 4,
  perCategory = 2,
): Promise<ForwardCandidate[]> {
  if (!symbols.length) return [];
  const syms = symbolList(symbols);

  // El CASE de pesos se construye desde la constante para que añadir una
  // categoría al enum no obligue a tocar SQL a mano en dos sitios.
  const weightCase = sql.join(
    Object.entries(CATEGORY_FORWARD_WEIGHT).map(
      ([cat, w]) => sql`WHEN ${cat} THEN ${sql.raw(String(w))}`,
    ),
    sql` `,
  );

  const rows = unwrapRows<ForwardCandidate & { rn: number }>(
    await db.execute(sql`
      SELECT "newsId", symbol, headline, url, source, "publishedAt", category,
             impact, sentiment, body, "hasExtract"
      FROM (
        -- Nivel 2: ya sin la cola de la categoría dominante, se reparte el
        -- cupo del SÍMBOLO por peso. La jerarquía sigue mandando el orden.
        SELECT *, ROW_NUMBER() OVER (
                    PARTITION BY symbol
                    ORDER BY w DESC, "publishedAt" DESC, impact DESC
                  ) AS rn
        FROM (
          -- Nivel 1: dentro de cada categoría, las mejores perCategory.
          -- Con CUERPO primero: un artículo sin extraer aporta un titular, y
          -- un titular es justo lo obvio que este canal existe para evitar.
          SELECT n.id AS "newsId", nt.ticker AS symbol, n.headline, n.url,
                 n.source, n.category::text AS category,
                 to_char(n.published_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "publishedAt",
                 COALESCE(s.impact, 0) AS impact,
                 COALESCE(s.sentiment, 0) AS sentiment,
                 a.text AS body,
                 (a.news_id IS NOT NULL AND a.status = 'ok') AS "hasExtract",
                 (CASE n.category::text ${weightCase} ELSE 0 END) AS w,
                 ROW_NUMBER() OVER (
                   PARTITION BY nt.ticker, n.category::text
                   ORDER BY (a.news_id IS NOT NULL AND a.status = 'ok') DESC,
                            n.published_at DESC,
                            COALESCE(s.impact, 0) DESC
                 ) AS rn_cat
          FROM news_tickers nt
          JOIN news n ON n.id = nt.news_id
          LEFT JOIN news_scores s ON s.news_id = n.id
          LEFT JOIN article_extracts a ON a.news_id = n.id
          WHERE nt.ticker IN (${syms})
            AND n.published_at >= now() - interval '${sql.raw(String(FORWARD_WINDOW_DAYS))} days'
            AND n.category IS NOT NULL
            AND n.category NOT IN ('MACRO','OTHER')
        ) t
        WHERE rn_cat <= ${perCategory}
      ) u
      WHERE rn <= ${perSymbol}
      ORDER BY symbol, rn
    `),
  );
  return rows.map((c) => ({
    newsId: c.newsId,
    symbol: c.symbol,
    headline: c.headline,
    url: c.url,
    source: c.source,
    publishedAt: c.publishedAt,
    category: c.category,
    impact: c.impact,
    sentiment: c.sentiment,
    body: c.body,
    hasExtract: c.hasExtract,
  }));
}

/**
 * Extrae los cuerpos que faltan. Ésta es la operación que convierte la
 * revisión de "lee titulares" a "lee el documento".
 *
 * `allowLlm: false` a propósito: sólo queremos el TEXTO. El resumen IA por
 * artículo costaría una llamada LLM por noticia (~20 por revisión); el
 * texto crudo lo lee después una sola llamada, la del libro de futuros.
 *
 * Presupuesto de PARED, no de reintentos: cada extracción es un fetch a un
 * medio externo y algunos tardan o cuelgan. Cuando se agota el tiempo se
 * devuelve lo cosechado hasta ese momento — media revisión con cuerpos es
 * mucho mejor que un timeout. Lo extraído queda cacheado en
 * `article_extracts`, así que la segunda revisión de los mismos valores
 * empieza casi llena.
 */
/** Lo MÍNIMO que necesita la cosecha: un id de noticia y si ya tiene cuerpo.
 *  Tipado estructural a propósito — `lib/ask/retrieve.ts` cosecha sobre
 *  `Citation[]` y no tiene por qué fabricar ForwardCandidates falsos para
 *  reusar esta función. */
export type Harvestable = { newsId: number | null; hasExtract: boolean };

export async function harvestBodies(
  candidates: Harvestable[],
  opts?: { budgetMs?: number; concurrency?: number },
): Promise<{ harvested: number; attempted: number }> {
  const budgetMs = opts?.budgetMs ?? 20_000;
  const concurrency = opts?.concurrency ?? 4;
  const deadline = Date.now() + budgetMs;

  const pending = [
    ...new Set(
      candidates
        .filter((c) => !c.hasExtract)
        .map((c) => c.newsId)
        .filter((id): id is number => id !== null),
    ),
  ];
  if (!pending.length) return { harvested: 0, attempted: 0 };

  let cursor = 0;
  let harvested = 0;
  let attempted = 0;

  async function worker() {
    while (cursor < pending.length && Date.now() < deadline) {
      const id = pending[cursor++];
      attempted++;
      try {
        // Texto y NADA más. `allowLlm:false` por sí solo no bastaba: el
        // re-scoring cuelga de su propio interruptor y se colaba en toda
        // cosecha masiva, gastando la cuota del pool que puntúa las
        // noticias frescas y, de paso, comiéndose el presupuesto de pared
        // de la propia pregunta. Los TRES consumidores de esta función son
        // caminos masivos (precalentado, revisión de cartera, /ask), así
        // que el sitio correcto para cortarlo es aquí y no en cada uno. El
        // click sobre una tarjeta —un artículo, pedido por alguien— sigue
        // re-puntuando por `/api/article/[id]`.
        const d = await getArticleDetail(id, {
          allowLlm: false,
          allowRescore: false,
        });
        if (d?.status === "ok" && d.text) harvested++;
      } catch {
        // Una fuente que bloquea (paywall, 403) no debe tumbar la cosecha:
        // el fallo ya queda cacheado por el propio enrich con cooldown.
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return { harvested, attempted };
}

/** Vuelve a leer los cuerpos tras la cosecha. Una query, no una por id. */
export async function reloadBodies(
  candidates: ForwardCandidate[],
): Promise<ForwardCandidate[]> {
  const ids = candidates.map((c) => c.newsId);
  if (!ids.length) return candidates;
  const rows = unwrapRows<{ newsId: number; body: string | null }>(
    await db.execute(sql`
      SELECT news_id AS "newsId", text AS body
      FROM article_extracts
      WHERE status = 'ok' AND text IS NOT NULL
        AND news_id IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})
    `),
  );
  const byId = new Map(rows.map((r) => [Number(r.newsId), r.body]));
  return candidates.map((c) => ({
    ...c,
    body: byId.get(c.newsId) ?? c.body,
    hasExtract: c.hasExtract || byId.has(c.newsId),
  }));
}

// ─────────────────────────────────────────────────────────────────────────
// Hechos estructurales de futuro: los que se calculan, no se leen.
// ─────────────────────────────────────────────────────────────────────────

export type EarningsBar = {
  symbol: string;
  date: string;
  hour: string | null;
  epsEstimate: number | null;
  revenueEstimate: number | null;
  daysAway: number;
};

/**
 * La VARA de los próximos resultados, no el resultado.
 *
 * `earnings_events` guardaba las estimaciones de consenso desde el primer
 * día y nadie las leía. Es la diferencia entre "reporta el 29" (un dato de
 * calendario que ya está en la pantalla) y "reporta el 29 con un consenso
 * de 7,38$ de BPA" (el listón que define si la noticia será buena o mala).
 */
export async function earningsBars(symbols: string[]): Promise<EarningsBar[]> {
  if (!symbols.length) return [];
  return unwrapRows<EarningsBar>(
    await db.execute(sql`
      SELECT symbol, date, hour,
             NULLIF(regexp_replace(COALESCE(eps_estimate,''),'[^0-9.\\-]','','g'),'')::float8 AS "epsEstimate",
             NULLIF(regexp_replace(COALESCE(revenue_estimate,''),'[^0-9.\\-]','','g'),'')::float8 AS "revenueEstimate",
             (date::date - current_date)::int AS "daysAway"
      FROM (
        SELECT symbol, date, hour, eps_estimate, revenue_estimate,
               ROW_NUMBER() OVER (PARTITION BY symbol ORDER BY date ASC) AS rn
        FROM earnings_events
        WHERE symbol IN (${symbolList(symbols)})
          AND date >= to_char(current_date,'YYYY-MM-DD')
      ) t WHERE rn = 1
    `),
  );
}

export type SystematicSeller = {
  symbol: string;
  owner: string;
  title: string | null;
  sales: number;
  totalValue: number | null;
  firstSale: string;
  lastSale: string;
  /** Acciones que le QUEDAN tras la última venta declarada. */
  sharesAfter: number | null;
  /** Acciones vendidas de media por operación — el ritmo. */
  avgShares: number;
  /** De las `sales`, cuántas declara el filing dentro de un plan 10b5-1. */
  plannedSales: number;
  /** Cuántas declara EXPLÍCITAMENTE fuera de plan (casilla a 0). */
  discretionarySales: number;
};

/**
 * Vendedores sistemáticos: el hecho más prospectivo que hay en Form 4 y
 * que nadie estaba mirando.
 *
 * Una venta aislada es ruido (impuestos, una casa, diversificación). DOS O
 * MÁS del mismo directivo en 90 días con un ritmo regular es un plan de
 * venta programada en curso, y `shares_after` dice cuánto queda por
 * colocar. Eso no es leer el pasado: es oferta futura conocida.
 *
 * Se agrupa por (símbolo, persona) y se exige >=2 operaciones.
 *
 * DESDE 2026-08-11 EL PLAN 10b5-1 SE LEE DEL FILING, no se infiere. La SEC
 * hizo obligatoria la casilla en dic-2022 (vigente abr-2023) y viene como
 * `<aff10b5One>` en el XML; antes de eso el patrón repetido era la única
 * firma observable, que es lo que esta nota decía.
 *
 * **No cambia si la señal cuenta, cambia QUÉ afirma.** El hecho prospectivo
 * es la OFERTA FUTURA, y esas acciones salen al mercado con plan o sin él —
 * por eso un plan no borra la señal. Lo que el plan borra es la lectura de
 * CONVICCIÓN: una venta programada se firmó meses antes y no dice nada de lo
 * que el directivo piense este trimestre. Una venta que el filer declara NO
 * programada sí: se decidió con la información de esa semana.
 *
 * Los tres recuentos van SEPARADOS y no fundidos en un booleano. Un grupo
 * puede mezclar operaciones programadas y discrecionales, y "2 de 5 sin
 * plan" es justo el caso que un booleano tendría que redondear hacia alguno
 * de los dos lados inventándose el resto. `unknown` (sin elemento en el
 * filing) se queda aparte por lo mismo: no es "programada" ni "no lo era".
 */
export async function systematicSellers(
  symbols: string[],
): Promise<SystematicSeller[]> {
  if (!symbols.length) return [];
  return unwrapRows<SystematicSeller>(
    await db.execute(sql`
      SELECT symbol, owner_name AS owner,
             (ARRAY_AGG(owner_title ORDER BY tx_date DESC))[1] AS title,
             COUNT(*)::int AS sales,
             SUM(value)::float8 AS "totalValue",
             MIN(tx_date) AS "firstSale",
             MAX(tx_date) AS "lastSale",
             (ARRAY_AGG(shares_after ORDER BY tx_date DESC))[1]::float8 AS "sharesAfter",
             AVG(shares)::float8 AS "avgShares",
             COUNT(*) FILTER (WHERE planned_sale = 1)::int AS "plannedSales",
             COUNT(*) FILTER (WHERE planned_sale = 0)::int AS "discretionarySales"
      FROM insider_trades
      WHERE symbol IN (${symbolList(symbols)})
        AND tx_code = 'S'
        AND filed_at >= now() - interval '90 days'
      GROUP BY symbol, owner_name
      HAVING COUNT(*) >= 2
      ORDER BY SUM(value) DESC NULLS LAST
      LIMIT 12
    `),
  );
}

export type PendingDeal = {
  symbol: string;
  newsId: number;
  headline: string;
  publishedAt: string;
  url: string;
};

/** Operaciones corporativas anunciadas en la ventana. Que la categoría sea
 *  `MA` no garantiza que siga abierta — de eso se encarga el extractor del
 *  libro de futuros leyendo el cuerpo. Aquí sólo se levantan candidatas. */
export async function pendingDeals(symbols: string[]): Promise<PendingDeal[]> {
  if (!symbols.length) return [];
  return unwrapRows<PendingDeal>(
    await db.execute(sql`
      SELECT nt.ticker AS symbol, n.id AS "newsId", n.headline, n.url,
             to_char(n.published_at at time zone 'UTC','YYYY-MM-DD') AS "publishedAt"
      FROM news_tickers nt
      JOIN news n ON n.id = nt.news_id
      WHERE nt.ticker IN (${symbolList(symbols)})
        AND n.category = 'MA'
        AND n.published_at >= now() - interval '${sql.raw(String(FORWARD_WINDOW_DAYS))} days'
      ORDER BY n.published_at DESC
      LIMIT 20
    `),
  );
}
