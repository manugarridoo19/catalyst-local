import { db } from "./index";
import {
  news,
  newsScores,
  newsTickers,
  tickerAliases,
  tickers,
  watchlist,
} from "./schema";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type {
  ExtractedTicker,
  NormalizedNewsItem,
  SentimentScore,
} from "@/lib/types";
import { categorizeHeuristic, type NewsCategory } from "@/lib/categorizer";

// IN-list para `news.category` reutilizado por live feed y News tab. Toma
// un array de categorías + una flag `allowNull` (incluye filas sin
// categoría asignada, típicas de inserts pre-categorizer).
function categoryCondition(
  categories: NewsCategory[],
  allowNull: boolean,
) {
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

  for (let i = 0; i < items.length; i += INSERT_CHUNK) {
    const chunk = items.slice(i, i + INSERT_CHUNK);
    try {
      const chunkOut = await db.transaction(async (tx) => {
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

  const conditions = [] as ReturnType<typeof eq>[];
  // Postgres-js serializa Date con toString() ("Tue May 12 2026 ..."), no
  // como timestamp. Convertimos a ISO string + cast explícito.
  if (opts.before)
    conditions.push(
      sql`${news.publishedAt} < ${opts.before.toISOString()}::timestamptz` as never,
    );
  if (opts.since)
    conditions.push(
      sql`${news.publishedAt} >= ${opts.since.toISOString()}::timestamptz` as never,
    );
  if (opts.minImpact)
    conditions.push(sql`${newsScores.impact} >= ${opts.minImpact}` as never);
  if (opts.requireTicker)
    conditions.push(
      sql`EXISTS (SELECT 1 FROM news_tickers nt WHERE nt.news_id = ${news.id})` as never,
    );
  if (opts.categories?.length)
    conditions.push(
      categoryCondition(opts.categories, opts.allowUnknownCategory ?? false) as never,
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
    })
    .from(watchlist)
    .leftJoin(tickers, eq(tickers.symbol, watchlist.symbol))
    .where(eq(watchlist.userSession, session))
    .orderBy(desc(watchlist.addedAt));
}

export async function addToWatchlist(session: string, symbol: string) {
  await db.insert(tickers).values({ symbol }).onConflictDoNothing();
  await db
    .insert(watchlist)
    .values({ userSession: session, symbol })
    .onConflictDoNothing();
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
  const result = (await db.execute(sql`
    DELETE FROM news WHERE published_at < ${cutoff}::timestamptz
  `)) as unknown as { count?: number };
  return result.count ?? 0;
}

// Devuelve los símbolos que deberían recibir per-ticker fetching en el cron:
// los más mencionados en news + todo lo que esté en watchlist + los seed
// tickers populares (siempre interesantes).
export async function getTopTickersForFetch(
  limit = 50,
): Promise<{ symbol: string; name: string | null }[]> {
  const result = (await db.execute(sql`
    SELECT t.symbol, t.name FROM tickers t
    LEFT JOIN (
      SELECT ticker, COUNT(*) AS n FROM news_tickers GROUP BY ticker
    ) c ON c.ticker = t.symbol
    LEFT JOIN (
      SELECT DISTINCT symbol FROM watchlist
    ) w ON w.symbol = t.symbol
    ORDER BY
      (w.symbol IS NOT NULL) DESC,
      (t.source = 'seed') DESC,
      COALESCE(c.n, 0) DESC,
      t.first_seen_at DESC
    LIMIT ${limit}
  `)) as unknown as Array<{ symbol: string; name: string | null }>;
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
export async function getTickerMetaMap(
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
