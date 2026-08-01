import { cache } from "react";
import { db, unwrapRows, createTxDb } from "./index";
import {
  news,
  newsScores,
  newsTickers,
  tickerAliases,
  tickers,
  watchlist,
} from "./schema";
import { and, desc, eq, inArray, ne, sql, type SQL } from "drizzle-orm";
import type {
  ExtractedTicker,
  NormalizedNewsItem,
  SentimentScore,
} from "@/lib/types";
import { categorizeHeuristic, type NewsCategory } from "@/lib/categorizer";
import {
  addToPosition,
  journalCash,
  reducePosition,
  type JournalCash,
  type TradeLike,
} from "@/lib/portfolio";
import { getProfile } from "@/lib/providers/finnhub";
import { claimableSessionIds } from "@/lib/session";

// IN-list para `news.category` reutilizado por live feed y News tab. Toma
// un array de categorías + una flag `allowNull` (incluye filas sin
// categoría asignada, típicas de inserts pre-categorizer).
function categoryCondition(
  categories: NewsCategory[],
  allowNull: boolean,
): SQL<unknown> {
  const inList = inArray(news.category, categories);
  return allowNull ? sql`(${inList} OR ${news.category} IS NULL)` : inList;
}

// Inserta tickers nuevos sin sobreescribir los existentes. Devuelve la lista
// de símbolos que ya están en DB tras la operación.
export async function upsertTickers(
  symbols: string[],
  source: string,
): Promise<void> {
  if (!symbols.length) return;
  const rows = Array.from(new Set(symbols)).map((s) => ({
    symbol: s,
    source,
  }));
  await db.insert(tickers).values(rows).onConflictDoNothing();
}

export type InsertNewsItem = {
  item: NormalizedNewsItem;
  tickers: ExtractedTicker[];
};

export type InsertedNewsRow = {
  id: number;
  item: NormalizedNewsItem;
  tickers: string[];
};

// Tamaño del chunk batched. 50 da ~25-100KB de payload por INSERT, bien
// dentro del wire-limit, y mantiene fault isolation: si un chunk falla,
// perdemos 50 items max (vs perder los 400 productivos del tick).
const INSERT_CHUNK = 50;

// Inserta noticias + sus tickers en chunks transaccionales. Reemplaza al
// loop secuencial anterior que hacía un await por item (~100-300ms × 400 =
// 40-120s en picos productivos, suficiente para tumbar el budget de 60s
// del cron Hobby). Ahora cada chunk son DOS INSERT (uno a news, otro a
// news_tickers) dentro de la misma transacción — total ~200-500ms por
// chunk de 50 items.
//
// Atomicidad (audit 2026-05-12 #1+#3): cada chunk es una transacción
// independiente — si el INSERT de news_tickers falla, rollback'ea solo
// ese chunk; los anteriores quedan committed. Devuelve solo las rows
// nuevas (las que conflictaron por hash no aparecen).
export async function insertNewsBatch(
  items: InsertNewsItem[],
): Promise<{ inserted: InsertedNewsRow[]; failures: number }> {
  if (!items.length) return { inserted: [], failures: 0 };
  const out: InsertedNewsRow[] = [];
  let failures = 0;

  // Transacciones interactivas → Pool WebSocket efímero (el `db` global es
  // el HTTP driver, sin transacciones interactivas). Solo se llega aquí en
  // Node (cron/daemon/scripts), nunca en el Worker. close() en finally.
  const { db: txClient, close } = createTxDb();
  try {
    for (let i = 0; i < items.length; i += INSERT_CHUNK) {
      const chunk = items.slice(i, i + INSERT_CHUNK);
      try {
        const chunkOut = await txClient.transaction(async (tx) => {
        const newsRows = chunk.map(({ item }) => ({
          url: item.url,
          hash: item.hash,
          headline: item.headline,
          source: item.source,
          publishedAt: item.publishedAt,
          body: item.body,
          imageUrl: item.imageUrl,
          category: categorizeHeuristic({
            headline: item.headline,
            body: item.body ?? null,
            source: item.source,
          }),
        }));

        // Schema tiene unique en BOTH url y hash. Conflict target = hash:
        // es el dedupe semántico (normaliza utm params). Las rows que
        // conflictan NO vuelven en `returning` — eso es nuestro filtro
        // de "ya existía".
        const insertedNews = await tx
          .insert(news)
          .values(newsRows)
          .onConflictDoNothing({ target: news.hash })
          .returning({ id: news.id, hash: news.hash });

        if (!insertedNews.length) return [] as InsertedNewsRow[];

        const idByHash = new Map(insertedNews.map((r) => [r.hash, r.id]));

        // Reasociamos los tickers extraídos al newsId real (vía hash).
        const tickerRows: {
          newsId: number;
          ticker: string;
          extractionMethod: ExtractedTicker["method"];
        }[] = [];
        const result: InsertedNewsRow[] = [];
        for (const { item, tickers } of chunk) {
          const newsId = idByHash.get(item.hash);
          if (!newsId) continue;
          for (const t of tickers) {
            tickerRows.push({
              newsId,
              ticker: t.symbol,
              extractionMethod: t.method,
            });
          }
          result.push({ id: newsId, item, tickers: tickers.map((t) => t.symbol) });
        }

        if (tickerRows.length) {
          await tx
            .insert(newsTickers)
            .values(tickerRows)
            .onConflictDoNothing();
        }
        return result;
      });
        out.push(...chunkOut);
      } catch (err) {
        failures += chunk.length;
        console.warn(
          `[insertNewsBatch] chunk of ${chunk.length} failed:`,
          err instanceof Error ? err.message.slice(0, 200) : err,
        );
      }
    }
  } finally {
    await close();
  }
  return { inserted: out, failures };
}

export async function insertScore(
  newsId: number,
  score: SentimentScore,
): Promise<void> {
  await db
    .insert(newsScores)
    .values({
      newsId,
      impact: score.impact,
      sentiment: score.sentiment,
      rationale: score.rationale,
      summary: score.summary,
      model: score.model,
      promptVersion: score.promptVersion,
    })
    .onConflictDoNothing();
  // Si el LLM clasificó la categoría, la sobreescribimos sobre la heurística.
  if (score.category) {
    await db
      .update(news)
      .set({ category: score.category })
      .where(eq(news.id, newsId));
  }
}

// Re-puntúa una noticia YA scoreada, sobrescribiendo el score anterior.
// Lo usa el re-scoring on-click: cuando al abrir una card extraemos el
// artículo completo, recalculamos impact/sentiment con ese texto (mucho
// más contexto que el titular+snippet original). onConflictDoUpdate en vez
// del onConflictDoNothing de insertScore.
export async function upsertScore(
  newsId: number,
  score: SentimentScore,
): Promise<void> {
  const values = {
    newsId,
    impact: score.impact,
    sentiment: score.sentiment,
    rationale: score.rationale,
    summary: score.summary,
    model: score.model,
    promptVersion: score.promptVersion,
  };
  // El scoring single NO produce `summary` (es campo solo-batch, impact>=3).
  // Si re-puntuamos sin summary, NO pisamos el que dejó el batch — se
  // preserva el existente vía COALESCE.
  const set: Record<string, unknown> = {
    impact: values.impact,
    sentiment: values.sentiment,
    rationale: values.rationale,
    model: values.model,
    promptVersion: values.promptVersion,
  };
  if (score.summary != null) set.summary = score.summary;
  await db
    .insert(newsScores)
    .values(values)
    .onConflictDoUpdate({ target: newsScores.newsId, set });
  if (score.category) {
    await db
      .update(news)
      .set({ category: score.category })
      .where(eq(news.id, newsId));
  }
}

// Desvincula tickers concretos de una noticia. Lo usa el scorer batch v4
// cuando el LLM marca wrong_tickers — mislinks del extractor que
// sobrevivieron a las reglas estáticas. Los links `api` son INTOCABLES:
// vienen anotados por el proveedor (SEC CIK map, Finnhub company news…) y
// son verdad de mayor confianza que la opinión del LLM sobre un titular —
// caso real 2026-07-20: "Honeywell Aerospace Inc. files Form 4" con ticker
// HONA (spinoff nuevo, del regulador) — el modelo lo marcaba wrong porque
// "Honeywell es HON" y dejaba el filing huérfano (rompía la ingesta
// insider). wrong_tickers existe para mislinks dict/regex, no para api.
// Devuelve los símbolos realmente borrados (el caller no debe ocultar del
// broadcast los que sobrevivieron protegidos).
export async function removeTickersFromNews(
  newsId: number,
  symbols: string[],
): Promise<string[]> {
  if (!symbols.length) return [];
  const removed = await db
    .delete(newsTickers)
    .where(
      and(
        eq(newsTickers.newsId, newsId),
        inArray(newsTickers.ticker, symbols.map((s) => s.toUpperCase())),
        ne(newsTickers.extractionMethod, "api"),
      ),
    )
    .returning({ ticker: newsTickers.ticker });
  return removed.map((r) => r.ticker);
}

export async function loadAliases() {
  return db.select().from(tickerAliases);
}

// Symbol set para el extractor leading-ticker pattern. Una sola query, cabe
// en memoria fácil (391 tickers actuales × ~5 bytes = 2KB).
export async function loadKnownSymbols(): Promise<Set<string>> {
  const rows = await db.select({ symbol: tickers.symbol }).from(tickers);
  return new Set(rows.map((r) => r.symbol));
}

export type FeedRow = {
  id: number;
  url: string;
  headline: string;
  body: string | null;
  source: string;
  publishedAt: Date;
  imageUrl: string | null;
  category: NewsCategory | null;
  tickers: string[];
  impact: number | null;
  sentiment: number | null;
  rationale: string | null;
  summary: string | null;
};

// Devuelve el feed paginado con tickers agregados y scores. Se usa en SSR
// inicial y en el endpoint de "más noticias". Orden siempre por
// publishedAt DESC — el tiempo manda, tanto en live feed como en ticker
// pages. El control de calidad se hace filtrando categorías (`categories`)
// en el WHERE, no reordenando.
export async function getFeed(opts: {
  limit?: number;
  offset?: number;
  before?: Date;
  since?: Date;
  symbol?: string;
  minImpact?: number;
  requireTicker?: boolean;
  // Lista cerrada de categorías a incluir. Live feed pasa las premium,
  // News tab pasa OTHER+MACRO. Si se omite, se incluyen todas.
  categories?: NewsCategory[];
  // Cuando true, news.category IS NULL también pasa el filtro de categorías.
  // Útil en la News tab para no perder filas viejas sin categorizar.
  allowUnknownCategory?: boolean;
} = {}): Promise<FeedRow[]> {
  const limit = Math.min(opts.limit ?? 50, 200);
  const offset = Math.max(opts.offset ?? 0, 0);

  // Correlated subquery (audit 2026-05-12 #2): antes hacíamos un
  // `LEFT JOIN (SELECT news_id, array_agg(ticker) FROM news_tickers
  // GROUP BY news_id)` — Postgres construía la hash aggregate sobre la
  // tabla ENTERA en cada page load (hoy ~25k rows, en 6m proyectado a
  // 250k+). Con la subquery correlada, Postgres solo evalúa el array_agg
  // para las filas que sobreviven al WHERE + LIMIT (típicamente 100 max),
  // usando la PK `(news_id, ticker)` como index. O(limit · log n) vs O(n).
  const tickersSubquery = sql<string[]>`(
    SELECT array_agg(nt.ticker)
    FROM news_tickers nt
    WHERE nt.news_id = ${news.id}
  )`;

  // Audit 2026-05-12 #12: tipar como `SQL<unknown>[]` (no `ReturnType<typeof eq>[]`).
  // Las condiciones son una mezcla de `eq(...)` y `sql\`\``; ambas devuelven
  // `SQL<unknown>`, así que el array las acepta sin `as never` cast. Drizzle
  // `and(...SQL<unknown>[])` consume el array directamente.
  const conditions: SQL<unknown>[] = [];
  // Postgres-js serializa Date con toString() ("Tue May 12 2026 ..."), no
  // como timestamp. Convertimos a ISO string + cast explícito.
  if (opts.before)
    conditions.push(
      sql`${news.publishedAt} < ${opts.before.toISOString()}::timestamptz`,
    );
  if (opts.since)
    conditions.push(
      sql`${news.publishedAt} >= ${opts.since.toISOString()}::timestamptz`,
    );
  if (opts.minImpact)
    conditions.push(sql`${newsScores.impact} >= ${opts.minImpact}`);
  if (opts.requireTicker)
    conditions.push(
      sql`EXISTS (SELECT 1 FROM news_tickers nt WHERE nt.news_id = ${news.id})`,
    );
  if (opts.categories?.length)
    conditions.push(
      categoryCondition(opts.categories, opts.allowUnknownCategory ?? false),
    );

  let rows;
  if (opts.symbol) {
    rows = await db
      .select({
        id: news.id,
        url: news.url,
        headline: news.headline,
        body: news.body,
        source: news.source,
        publishedAt: news.publishedAt,
        imageUrl: news.imageUrl,
        category: news.category,
        tickers: tickersSubquery,
        impact: newsScores.impact,
        sentiment: newsScores.sentiment,
        rationale: newsScores.rationale,
        summary: newsScores.summary,
      })
      .from(news)
      .innerJoin(newsTickers, eq(newsTickers.newsId, news.id))
      .leftJoin(newsScores, eq(newsScores.newsId, news.id))
      .where(
        and(eq(newsTickers.ticker, opts.symbol.toUpperCase()), ...conditions),
      )
      .orderBy(desc(news.publishedAt))
      .limit(limit)
      .offset(offset);
  } else {
    rows = await db
      .select({
        id: news.id,
        url: news.url,
        headline: news.headline,
        body: news.body,
        source: news.source,
        publishedAt: news.publishedAt,
        imageUrl: news.imageUrl,
        category: news.category,
        tickers: tickersSubquery,
        impact: newsScores.impact,
        sentiment: newsScores.sentiment,
        rationale: newsScores.rationale,
        summary: newsScores.summary,
      })
      .from(news)
      .leftJoin(newsScores, eq(newsScores.newsId, news.id))
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(news.publishedAt))
      .limit(limit)
      .offset(offset);
  }

  return rows.map((r) => ({
    ...r,
    tickers: r.tickers ?? [],
    category: r.category as NewsCategory | null,
  }));
}

export async function getWatchlist(session: string) {
  return db
    .select({
      symbol: watchlist.symbol,
      addedAt: watchlist.addedAt,
      name: tickers.name,
      sector: tickers.sector,
      shares: watchlist.shares,
      avgCost: watchlist.avgCost,
      frameMadurez: watchlist.frameMadurez,
      frameCapital: watchlist.frameCapital,
      frameCiclo: watchlist.frameCiclo,
    })
    .from(watchlist)
    .leftJoin(tickers, eq(tickers.symbol, watchlist.symbol))
    .where(eq(watchlist.userSession, session))
    .orderBy(desc(watchlist.addedAt));
}

export type WatchlistRow = Awaited<ReturnType<typeof getWatchlist>>[number];

/**
 * Fija (o limpia) la posición de un símbolo YA presente en la watchlist.
 *
 * No hace upsert a propósito: añadir un ticker es `addToWatchlist` y pasa
 * por el `insert` en `tickers`, que es lo que mantiene la integridad de la
 * FK y del universo. Si esto insertara por su cuenta, una llamada con un
 * símbolo inventado crearía una posición sobre un ticker que Catalyst no
 * sigue — sin noticias, sin fundamentals y sin forma de valorarlo.
 *
 * `null` en cualquiera de los dos campos es un borrado explícito: devuelve
 * la fila a "solo seguimiento".
 */
export async function setPosition(
  session: string,
  symbol: string,
  shares: number | null,
  avgCost: number | null,
): Promise<boolean> {
  // Se anota como `adjust` en el diario. Sin esto el historial mentiría por
  // OMISIÓN: las acciones saltarían de una fila a otra sin operación que lo
  // explique y el lector supondría que falta una compra. Una corrección no
  // lleva cantidad ni precio (no es una compra ni una venta, es un estado
  // nuevo declarado a mano), y por eso `shares`/`price` van a null.
  //
  // A diferencia de comprar y vender, aquí NO hay guarda optimista: el
  // editor manda valores absolutos ("déjalo exactamente así"), que es una
  // orden deliberada del usuario y debe ganar sobre lo que hubiera. El CTE
  // sigue siendo necesario por la atomicidad entre posición y diario.
  const rows = unwrapRows<{ id: number }>(
    await db.execute(sql`
      WITH upd AS (
        UPDATE watchlist SET shares = ${shares}, avg_cost = ${avgCost}
         WHERE user_session = ${session} AND symbol = ${symbol}
           -- Sin cambio real no hay nada que anotar. El diario existe para
           -- que las acciones no salten entre dos filas sin operación que lo
           -- explique; una línea 'adjust' que deja la posición EXACTAMENTE
           -- igual no explica nada y ensucia el registro con ruido que luego
           -- hay que leer (abrir el editor y guardar sin tocar bastaba para
           -- generarla). IS DISTINCT FROM y no <>: los dos campos son
           -- NULLABLE y con <> una fila sin coste nunca se compararía
           -- consigo misma.
           AND (shares IS DISTINCT FROM ${shares}
                OR avg_cost IS DISTINCT FROM ${avgCost})
        RETURNING id
      )
      INSERT INTO position_trades
        (user_session, symbol, side, shares, price, realized_pnl,
         shares_after, avg_cost_after)
      SELECT ${session}, ${symbol}, 'adjust', NULL, NULL, NULL,
             ${shares}, ${avgCost}
      FROM upd
      RETURNING id
    `),
  );
  if (rows.length > 0) return true;
  // Cero filas significa DOS cosas distintas desde que el UPDATE exige un
  // cambio real: o el símbolo no está en la watchlist (404 legítimo) o los
  // valores ya eran ésos y no había nada que escribir. Sin distinguirlas,
  // guardar el editor sin tocar nada devolvía «no está en tu lista» sobre un
  // valor que sí está — un error inventado por una operación innecesaria.
  return (await readPosition(session, symbol)) !== null;
}

/**
 * Refuerza una posición con una compra nueva y devuelve cómo queda.
 *
 * Lee-calcula-escribe en vez de un solo UPDATE con la media dentro del SQL,
 * y es deliberado: la media ponderada la define `addToPosition` en
 * `lib/portfolio.ts` y tener UNA sola implementación vale más que ahorrar
 * un round-trip. Escribir la fórmula también en SQL sería el mismo error
 * que el proyecto ya evita con `buildPortfolio`: dos sitios calculando lo
 * mismo acaban discrepando, y aquí el que discrepe se lleva por delante el
 * P&L y los pesos de toda la cartera.
 *
 * Lo que sí protege del hueco entre la lectura y la escritura es la GUARDA
 * de la cláusula WHERE: si `shares`/`avg_cost` ya no son los que se leyeron
 * —otra pestaña abierta, un doble click—, no se escribe nada y se devuelve
 * `conflict`. Sin ella, dos compras simultáneas se pisan y una desaparece
 * sin dejar rastro, que es la peor forma de perder dinero registrado.
 */
export async function addLotToPosition(
  session: string,
  symbol: string,
  lot: { shares: number; price: number; horizon?: string | null; thesis?: string | null },
): Promise<
  | { status: "ok"; shares: number; avgCost: number | null; avgCostUnknown: boolean }
  | { status: "not_found" }
  | { status: "conflict" }
> {
  const row = await readPosition(session, symbol);
  if (!row) return { status: "not_found" };

  const next = addToPosition(row, lot);
  const written = await commitPosition(session, symbol, row, {
    shares: next.shares,
    avgCost: next.avgCost,
    side: "buy",
    lotShares: lot.shares,
    lotPrice: lot.price,
    realized: null,
    horizon: lot.horizon,
    thesis: lot.thesis,
  });
  if (!written) return { status: "conflict" };
  return { status: "ok", ...next };
}

/**
 * Recorta una posición vendiendo parte (o todo) y archiva el P&L realizado.
 */
export async function reduceLotFromPosition(
  session: string,
  symbol: string,
  lot: { shares: number; price: number; horizon?: string | null; thesis?: string | null },
): Promise<
  | {
      status: "ok";
      shares: number;
      avgCost: number | null;
      realized: number | null;
      closes: boolean;
    }
  | { status: "not_found" }
  | { status: "conflict" }
  | { status: "invalid"; reason: "sin_posicion" | "excede"; shares: number | null }
> {
  const row = await readPosition(session, symbol);
  if (!row) return { status: "not_found" };

  const next = reducePosition(row, lot);
  if (!next.ok) return { status: "invalid", reason: next.reason, shares: row.shares };

  const written = await commitPosition(session, symbol, row, {
    shares: next.shares,
    avgCost: next.avgCost,
    side: "sell",
    lotShares: lot.shares,
    lotPrice: lot.price,
    realized: next.realized,
    horizon: lot.horizon,
    thesis: lot.thesis,
  });
  if (!written) return { status: "conflict" };
  return {
    status: "ok",
    shares: next.shares,
    avgCost: next.avgCost,
    realized: next.realized,
    closes: next.closes,
  };
}

/**
 * Clasifica una operación YA registrada: le pone plazo y, opcionalmente,
 * tesis.
 *
 * Marca SIEMPRE `annotated_later = true`, y eso es el corazón de la
 * función. Una tesis escrita cuando ya sabes cómo fue la operación no es
 * una predicción — es una explicación, y las explicaciones a toro pasado
 * son justo el material del sesgo retrospectivo. Sin esta marca, el panel
 * acabaría felicitándote por "aciertos" cuya tesis redactaste después de
 * ver el resultado, que es la forma más eficaz de que una herramienta así
 * te haga peor inversor en vez de mejor.
 *
 * Es idempotente y reversible (puedes reclasificar), pero la marca NO se
 * puede quitar: una vez que la operación existió sin plazo, el hecho de
 * que se clasificara tarde es cierto para siempre.
 *
 * Acotada a la sesión: sin el filtro, un id ajeno bastaría para escribir
 * en el diario de otro.
 */
/**
 * Declara qué CLASE de empresa es una posición, en los tres ejes. Ver
 * `lib/coach/frames.ts`.
 *
 * Los tres a la vez y nunca uno suelto: `parseAxes` exige los tres para
 * leer, así que dejar uno a medias dejaría la posición clasificada a ojos
 * del usuario e ilegible para el coach. Pasar `null` en los tres la
 * devuelve a "sin clasificar", que es un estado legítimo.
 */
export async function setAxes(
  session: string,
  symbol: string,
  axes: { madurez: string; capital: string; ciclo: string } | null,
): Promise<boolean> {
  const res = await db.execute(sql`
    UPDATE watchlist
       SET frame_madurez = ${axes?.madurez ?? null},
           frame_capital = ${axes?.capital ?? null},
           frame_ciclo   = ${axes?.ciclo ?? null}
     WHERE user_session = ${session} AND symbol = ${symbol}
  `);
  return (res as { rowCount?: number }).rowCount === 1;
}

export async function annotateTrade(
  session: string,
  tradeId: number,
  horizon: string | null,
  thesis: string | null,
): Promise<boolean> {
  const res = await db.execute(sql`
    UPDATE position_trades
       SET horizon = ${horizon},
           thesis = ${thesis},
           annotated_later = true
     WHERE id = ${tradeId}
       AND user_session = ${session}
       -- Los 'adjust' no se clasifican: no son decisiones de mercado, así
       -- que darles plazo sugeriría que se juzgan, y no se juzgan.
       AND side <> 'adjust'
  `);
  return (res as { rowCount?: number }).rowCount === 1;
}

async function readPosition(
  session: string,
  symbol: string,
): Promise<{ shares: number | null; avgCost: number | null } | null> {
  const [row] = await db
    .select({ shares: watchlist.shares, avgCost: watchlist.avgCost })
    .from(watchlist)
    .where(and(eq(watchlist.userSession, session), eq(watchlist.symbol, symbol)))
    .limit(1);
  return row ?? null;
}

/**
 * Escribe la posición nueva Y su línea de diario en UNA sola sentencia.
 *
 * El CTE no es lucimiento: `/api/watchlist` corre en el Worker y ahí está
 * PROHIBIDO el driver Pool (`createTxDb`), así que no hay transacción
 * interactiva disponible. Con dos sentencias sueltas, un fallo entre medias
 * deja la posición movida sin línea en el diario —o al revés—, y un diario
 * que no cuadra con la posición es peor que no tener diario: invita a
 * confiar en él. Un único statement es atómico por definición.
 *
 * La GUARDA sigue en el WHERE del UPDATE: si la fila cambió entre la
 * lectura y esto, el CTE no devuelve nada, el INSERT no inserta y la
 * llamada responde `conflict`. `IS NOT DISTINCT FROM` y no `=` porque los
 * dos campos son NULLABLE y con `=` una fila sin coste registrado no
 * casaría NUNCA consigo misma — el refuerzo fallaría siempre justo en el
 * caso que ya es el raro.
 */
async function commitPosition(
  session: string,
  symbol: string,
  prev: { shares: number | null; avgCost: number | null },
  next: {
    shares: number | null;
    avgCost: number | null;
    side: "buy" | "sell" | "adjust";
    lotShares: number | null;
    lotPrice: number | null;
    realized: number | null;
    /** Intención DECLARADA al operar. Viaja hasta el INSERT porque anotarla
     *  después en otra sentencia dejaría un hueco en el que la operación
     *  existe sin plazo — y una operación sin plazo no se juzga, así que ese
     *  hueco es una pérdida permanente de dato, no un estado transitorio. */
    horizon?: string | null;
    thesis?: string | null;
  },
): Promise<boolean> {
  const rows = unwrapRows<{ id: number }>(
    await db.execute(sql`
      WITH upd AS (
        UPDATE watchlist
           SET shares = ${next.shares}, avg_cost = ${next.avgCost}
         WHERE user_session = ${session}
           AND symbol = ${symbol}
           AND shares IS NOT DISTINCT FROM ${prev.shares}
           AND avg_cost IS NOT DISTINCT FROM ${prev.avgCost}
        RETURNING id
      )
      INSERT INTO position_trades
        (user_session, symbol, side, shares, price, realized_pnl,
         shares_after, avg_cost_after, horizon, thesis)
      SELECT ${session}, ${symbol}, ${next.side}, ${next.lotShares},
             ${next.lotPrice}, ${next.realized}, ${next.shares}, ${next.avgCost},
             ${next.horizon ?? null}, ${next.thesis ?? null}
      FROM upd
      RETURNING id
    `),
  );
  return rows.length > 0;
}

export type PositionTrade = {
  id: number;
  symbol: string;
  side: "buy" | "sell" | "adjust";
  shares: number | null;
  price: number | null;
  realizedPnl: number | null;
  sharesAfter: number | null;
  avgCostAfter: number | null;
  horizon: "corto" | "medio" | "largo" | null;
  thesis: string | null;
  annotatedLater: boolean;
  createdAt: string;
};

/** El diario de la sesión, lo último primero. Acotado porque se pinta
 *  entero: quien quiera contabilidad completa exporta, no scrollea. */
export async function getTrades(
  session: string,
  limit = 200,
): Promise<PositionTrade[]> {
  return unwrapRows<PositionTrade>(
    await db.execute(sql`
      SELECT id, symbol, side, shares, price, horizon, thesis,
             realized_pnl AS "realizedPnl",
             shares_after AS "sharesAfter",
             avg_cost_after AS "avgCostAfter",
             annotated_later AS "annotatedLater",
             to_char(created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "createdAt"
      FROM position_trades
      WHERE user_session = ${session}
      ORDER BY created_at DESC, id DESC
      LIMIT ${limit}
    `),
  );
}

/** La caja del diario, calculada EN EL SERVIDOR y sobre el diario COMPLETO.
 *  `getTrades` corta a 200 porque se pinta entero; sumar sobre ese corte
 *  hacía que «P&L realizado» y la caja dejaran de ser la cifra de toda la
 *  vida del diario a partir de la operación 201, sin ningún síntoma (audit
 *  2026-08-01). La aritmética NO se duplica en SQL: se traen las columnas
 *  mínimas (TradeLike) de todas las filas y se pasa por `journalCash`, que
 *  es la única definición de estas cuentas en el proyecto. El diario es de
 *  un solo usuario real: traerlo entero para agregar es más barato que
 *  mantener dos aritméticas que pueden divergir. */
export async function getJournalCash(session: string): Promise<JournalCash> {
  const rows = unwrapRows<TradeLike>(
    await db.execute(sql`
      SELECT side, shares, price,
             realized_pnl AS "realizedPnl",
             to_char(created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "createdAt"
      FROM position_trades
      WHERE user_session = ${session}
    `),
  );
  return journalCash(rows);
}

/** Cuántos símbolos sigue ya esta sesión. Para el tope por sesión de la
 *  ruta: `watchlist` no tiene caducidad y el Worker público acepta
 *  escrituras anónimas, así que sin techo el depósito de 512 MB de Neon
 *  —el mismo en el que la ingesta de embeddings se pausa a 380— se puede
 *  llenar desde fuera. */
export async function countWatchlist(session: string): Promise<number> {
  const rows = unwrapRows<{ n: number }>(
    await db.execute(
      sql`SELECT COUNT(*)::int AS n FROM watchlist WHERE user_session = ${session}`,
    ),
  );
  return rows[0]?.n ?? 0;
}

/**
 * Añade un símbolo a la watchlist de la sesión.
 *
 * EL SÍMBOLO TIENE QUE SER REAL antes de tocar `tickers`. Antes esto hacía
 * un `INSERT INTO tickers … ON CONFLICT DO NOTHING` incondicional, y como la
 * ruta es anónima y sólo valida `[A-Z0-9.\-]{1,10}`, cualquiera podía
 * inventarse filas en la tabla del UNIVERSO desde el Worker público. Eso no
 * se quedaba ahí: `getTopTickersForFetch` prioriza lo que esté en alguna
 * watchlist, así que 50 símbolos basura desplazaban a la watchlist real de
 * las 50 plazas de fetch per-ticker del cron, y `loadKnownSymbols()` —el
 * filtro de la ingesta de SEC EDGAR— se los tragaba también.
 *
 * El camino legítimo NO paga por ello: si el símbolo ya está en `tickers`
 * (el caso normal — el pipeline mete todo lo que menciona un proveedor) no
 * se llama a nadie. Sólo un símbolo NUEVO se confirma, con UNA llamada a
 * `getProfile` de Finnhub, que es el proveedor más barato que tenemos y ya
 * devuelve el nombre y el logo con los que se crea bien la fila.
 *
 * Ante un fallo de Finnhub se responde `unconfirmed` y NO se crea nada: es
 * mejor que el usuario reintente a que un corte del proveedor abra otra vez
 * la puerta del universo.
 */
export async function addToWatchlist(
  session: string,
  symbol: string,
): Promise<"ok" | "unknown_symbol" | "unconfirmed"> {
  const known = unwrapRows<{ ok: number }>(
    await db.execute(sql`SELECT 1 AS ok FROM tickers WHERE symbol = ${symbol} LIMIT 1`),
  ).length;

  if (!known) {
    let profile: Awaited<ReturnType<typeof getProfile>> = null;
    try {
      profile = await getProfile(symbol);
    } catch {
      return "unconfirmed";
    }
    if (!profile || profile.ticker.toUpperCase() !== symbol) {
      return "unknown_symbol";
    }
    await db
      .insert(tickers)
      .values({
        symbol,
        name: profile.name || null,
        logoUrl: profile.logo || null,
        source: "watchlist",
      })
      .onConflictDoNothing();
  }

  await db
    .insert(watchlist)
    .values({ userSession: session, symbol })
    .onConflictDoNothing();
  return "ok";
}

export async function removeFromWatchlist(session: string, symbol: string) {
  await db
    .delete(watchlist)
    .where(
      and(eq(watchlist.userSession, session), eq(watchlist.symbol, symbol)),
    );
}

export async function getNewsScoresByIds(ids: number[]) {
  if (!ids.length) return [];
  return db.select().from(newsScores).where(inArray(newsScores.newsId, ids));
}

// Borra noticias publicadas hace más de N días. Sus filas en news_tickers
// y news_scores caen automáticamente vía FK CASCADE. Casteamos a
// timestamptz porque postgres-js no maneja bien Date como param literal.
export async function deleteOldNews(days: number): Promise<number> {
  const cutoff = new Date(
    Date.now() - days * 24 * 60 * 60 * 1000,
  ).toISOString();
  // El driver de Neon devuelve el nº de filas afectadas en `rowCount`
  // (postgres-js lo exponía como `count`).
  const result = (await db.execute(sql`
    DELETE FROM news WHERE published_at < ${cutoff}::timestamptz
  `)) as unknown as { rowCount?: number };
  return result.rowCount ?? 0;
}

// Purga noticias SIN score de más de `days` días. Mantiene las scored (esas
// las recorta deleteOldNews a RETENTION_DAYS). Recorta el backlog de scoring
// a lo accionable — puntuar una noticia de hace una semana no aporta valor.
export async function deleteUnscoredOlderThan(days: number): Promise<number> {
  const cutoff = new Date(
    Date.now() - days * 24 * 60 * 60 * 1000,
  ).toISOString();
  const result = (await db.execute(sql`
    DELETE FROM news n
    WHERE n.published_at < ${cutoff}::timestamptz
      AND NOT EXISTS (SELECT 1 FROM news_scores s WHERE s.news_id = n.id)
  `)) as unknown as { rowCount?: number };
  return result.rowCount ?? 0;
}

// Devuelve los símbolos que deberían recibir per-ticker fetching en el cron:
// los más mencionados en news + todo lo que esté en watchlist + los seed
// tickers populares (siempre interesantes).
//
// Cache TTL 30min (audit 2026-05-12 #5): el COUNT GROUP BY sobre news_tickers
// es un full-scan que crece con la tabla (~60k rows hoy). El ranking cambia
// lento — un ticker que ya está top no sale del top en 30min — así que
// cachear es gratis. Cron ticks cada 5min ⇒ 1 query DB cada 6 ticks vs cada
// tick. Cache es módulo-level: warm functions lo comparten; daemon local
// nunca reinicia. Watchlist toggles invalidan a través del TTL natural,
// aceptable porque el watchlist tier ya prioriza independiente del COUNT.
type TopTickersEntry = {
  data: { symbol: string; name: string | null }[];
  expiresAt: number;
};
const topTickersCache = new Map<number, TopTickersEntry>();
const TOP_TICKERS_TTL_MS = 30 * 60 * 1000;

export async function getTopTickersForFetch(
  limit = 50,
): Promise<{ symbol: string; name: string | null }[]> {
  const cached = topTickersCache.get(limit);
  if (cached && cached.expiresAt > Date.now()) return cached.data;

  // El tramo de watchlist va acotado a las sesiones del DUEÑO cuando se
  // conocen. La consulta antigua era `SELECT DISTINCT symbol FROM watchlist`
  // sin filtro de sesión, así que la watchlist de cualquier anónimo del
  // Worker público se colaba en el primer criterio de orden y desplazaba a
  // la real de las plazas de fetch.
  //
  // FAIL-OPEN deliberado: `claimableSessionIds()` sale de
  // CLAIMABLE_SESSION_IDS / LOCAL_DEFAULT_SESSION_ID, y el cron de GitHub
  // Actions —que es justo quien llama a esta función— NO tiene ninguna de
  // las dos. Si ahí el filtro se aplicara en vacío, la watchlist del usuario
  // perdería su prioridad de golpe, que es peor que el abuso que se está
  // tapando. Con la lista vacía se conserva el comportamiento de siempre; la
  // puerta de verdad es `addToWatchlist`, que ya no deja entrar símbolos sin
  // confirmar en `tickers`.
  const owners = [...claimableSessionIds()];
  const watchScope = owners.length
    ? sql`SELECT DISTINCT symbol FROM watchlist WHERE user_session IN (${sql.join(
        owners.map((s) => sql`${s}`),
        sql`, `,
      )})`
    : sql`SELECT DISTINCT symbol FROM watchlist`;

  const result = unwrapRows<{ symbol: string; name: string | null }>(
    await db.execute(sql`
      SELECT t.symbol, t.name FROM tickers t
      LEFT JOIN (
        SELECT ticker, COUNT(*) AS n FROM news_tickers GROUP BY ticker
      ) c ON c.ticker = t.symbol
      LEFT JOIN (${watchScope}) w ON w.symbol = t.symbol
      ORDER BY
        (w.symbol IS NOT NULL) DESC,
        (t.source = 'seed') DESC,
        COALESCE(c.n, 0) DESC,
        t.first_seen_at DESC
      LIMIT ${limit}
    `),
  );
  topTickersCache.set(limit, {
    data: result,
    expiresAt: Date.now() + TOP_TICKERS_TTL_MS,
  });
  return result;
}

export type TickerMeta = {
  symbol: string;
  name: string | null;
  logoUrl: string | null;
  sector: string | null;
};

// Fetch metadata para varios symbols a la vez. Lo usa el feed page loader
// para inyectar logo+nombre del "primary ticker" en cada noticia.
//
// `React.cache` (audit 2026-05-12 #15): dedupe per-request. La key del
// cache es la lista de symbols normalizada — para que dos llamadas dentro
// del mismo render con el mismo set vuelvan de cache. Sin esto, si el
// layout y la página ambos resolvían tickers (caso común al crecer la
// app), pegábamos la DB dos veces por render.
export const getTickerMetaMap = cache(_getTickerMetaMap);

async function _getTickerMetaMap(
  symbols: string[],
): Promise<Map<string, TickerMeta>> {
  const out = new Map<string, TickerMeta>();
  if (!symbols.length) return out;
  const unique = Array.from(new Set(symbols.map((s) => s.toUpperCase())));
  const rows = await db
    .select({
      symbol: tickers.symbol,
      name: tickers.name,
      logoUrl: tickers.logoUrl,
      sector: tickers.sector,
    })
    .from(tickers)
    .where(inArray(tickers.symbol, unique));
  for (const r of rows) out.set(r.symbol, r);
  return out;
}
