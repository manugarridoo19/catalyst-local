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
// para asociar el score después.
export async function insertNewsWithTickers(
  item: NormalizedNewsItem,
  extracted: ExtractedTicker[],
): Promise<number | null> {
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
    })
    .onConflictDoNothing({ target: news.url })
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
}

export async function loadAliases() {
  return db.select().from(tickerAliases);
}

export type FeedRow = {
  id: number;
  url: string;
  headline: string;
  body: string | null;
  source: string;
  publishedAt: Date;
  imageUrl: string | null;
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
  symbol?: string;
  minImpact?: number;
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
  if (opts.before) conditions.push(sql`${news.publishedAt} < ${opts.before}` as never);
  if (opts.minImpact)
    conditions.push(sql`${newsScores.impact} >= ${opts.minImpact}` as never);

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
