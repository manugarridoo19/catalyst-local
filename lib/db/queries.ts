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

// Inserta una noticia + sus tickers. Si la URL ya existe (unique constraint)
// devuelve null y el caller debe saltarla. Devuelve el id de la noticia
// para asociar el score después. Aplicamos la categorización heurística
// aquí mismo para que la card tenga badge desde el primer render.
export async function insertNewsWithTickers(
  item: NormalizedNewsItem,
  extracted: ExtractedTicker[],
): Promise<number | null> {
  const category = categorizeHeuristic({
    headline: item.headline,
    body: item.body ?? null,
    source: item.source,
  });
  const inserted = await db
    .insert(news)
    .values({
      url: item.url,
      hash: item.hash,
      headline: item.headline,
      source: item.source,
      publishedAt: item.publishedAt,
      body: item.body,
      imageUrl: item.imageUrl,
      category,
    })
    // Schema tiene unique on BOTH url y hash. El conflict target debe ser
    // hash porque es el dedupe semántico (normaliza utm params). Si usamos
    // url como target, llegan dos URLs distintas que normalizan al mismo
    // hash → Postgres detecta la violación de hash que NO está en el ON
    // CONFLICT → 500 y el cron entero muere. Switching a hash arregla esto.
    .onConflictDoNothing({ target: news.hash })
    .returning({ id: news.id });

  const newsId = inserted[0]?.id;
  if (!newsId) return null;

  if (extracted.length) {
    await db
      .insert(newsTickers)
      .values(
        extracted.map((t) => ({
          newsId,
          ticker: t.symbol,
          extractionMethod: t.method,
        })),
      )
      .onConflictDoNothing();
  }
  return newsId;
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
// inicial y en el endpoint de "más noticias".
export async function getFeed(opts: {
  limit?: number;
  before?: Date;
  since?: Date;
  symbol?: string;
  minImpact?: number;
  requireTicker?: boolean;
} = {}): Promise<FeedRow[]> {
  const limit = Math.min(opts.limit ?? 50, 200);

  // Subquery: agregar tickers por noticia.
  const tickersAgg = db
    .select({
      newsId: newsTickers.newsId,
      tickers: sql<string[]>`array_agg(${newsTickers.ticker})`.as("tickers"),
    })
    .from(newsTickers)
    .groupBy(newsTickers.newsId)
    .as("tickers_agg");

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
        tickers: tickersAgg.tickers,
        impact: newsScores.impact,
        sentiment: newsScores.sentiment,
        rationale: newsScores.rationale,
      })
      .from(news)
      .innerJoin(newsTickers, eq(newsTickers.newsId, news.id))
      .leftJoin(tickersAgg, eq(tickersAgg.newsId, news.id))
      .leftJoin(newsScores, eq(newsScores.newsId, news.id))
      .where(
        and(eq(newsTickers.ticker, opts.symbol.toUpperCase()), ...conditions),
      )
      .orderBy(desc(news.publishedAt))
      .limit(limit);
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
        tickers: tickersAgg.tickers,
        impact: newsScores.impact,
        sentiment: newsScores.sentiment,
        rationale: newsScores.rationale,
      })
      .from(news)
      .leftJoin(tickersAgg, eq(tickersAgg.newsId, news.id))
      .leftJoin(newsScores, eq(newsScores.newsId, news.id))
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(news.publishedAt))
      .limit(limit);
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
