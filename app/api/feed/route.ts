import { NextResponse } from "next/server";
import { getFeed, getTickerMetaMap } from "@/lib/db/queries";
import { fifteenDaysAgo, startOfTodayUtc } from "@/lib/time-windows";
import {
  LIVE_FEED_CATEGORIES,
  LIVE_FEED_MAIN_CATEGORIES,
  NEWS_TAB_CATEGORIES,
  type NewsCategory,
} from "@/lib/categorizer";
import type { FeedItem } from "@/lib/feed-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Paginación del feed (live u por ticker). Usado por NewsSidePanel para
// "load more" sin recargar la página. `symbol` aplica ranking signal-first
// y ventana 15 días; sin symbol asume live feed (today UTC) ordenado por
// publishedAt.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const symbol = url.searchParams.get("symbol")?.toUpperCase().trim();
  const tab = url.searchParams.get("tab"); // "live" | "news" — solo aplica sin symbol
  // Slice de una categoría concreta (p.ej. INSIDER, que el live "All"
  // excluye por defecto — las ráfagas de Form 4 inundaban el limit).
  const categoryParam = url.searchParams.get("category")?.toUpperCase().trim();
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 50), 100);
  const offset = Math.max(Number(url.searchParams.get("offset") ?? 0), 0);

  if (symbol && !/^[A-Z0-9.\-]{1,10}$/.test(symbol)) {
    return NextResponse.json({ error: "invalid_symbol" }, { status: 400 });
  }

  try {
    const baseOpts = symbol
      ? { symbol, since: fifteenDaysAgo() }
      : tab === "news"
        ? {
            since: fifteenDaysAgo(),
            categories: NEWS_TAB_CATEGORIES,
            allowUnknownCategory: true,
            requireTicker: true,
          }
        : {
            since: startOfTodayUtc(),
            requireTicker: true,
            categories:
              categoryParam &&
              (LIVE_FEED_CATEGORIES as string[]).includes(categoryParam)
                ? [categoryParam as NewsCategory]
                : LIVE_FEED_MAIN_CATEGORIES,
          };

    const rows = await getFeed({
      ...baseOpts,
      limit,
      offset,
    });

    const primarySymbols = Array.from(
      new Set(rows.map((r) => r.tickers[0]).filter(Boolean) as string[]),
    );
    const meta = await getTickerMetaMap(primarySymbols);

    const items: FeedItem[] = rows.map((r) => {
      const primary = r.tickers[0] ?? null;
      const m = primary ? meta.get(primary) : null;
      return {
        id: r.id,
        url: r.url,
        headline: r.headline,
        body: r.body,
        source: r.source,
        publishedAt: r.publishedAt.toISOString(),
        imageUrl: r.imageUrl,
        category: r.category,
        tickers: r.tickers,
        primarySymbol: primary,
        primaryName: m?.name ?? null,
        primaryLogo: m?.logoUrl ?? null,
        impact: r.impact,
        sentiment: r.sentiment,
        rationale: r.rationale,
        summary: r.summary,
      };
    });

    return NextResponse.json({ items, hasMore: items.length === limit });
  } catch (err) {
    return NextResponse.json(
      { items: [], error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
