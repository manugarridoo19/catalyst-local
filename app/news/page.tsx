import { Header } from "@/components/header";
import { FeedList } from "@/components/feed/feed-list";
import { WatchlistPanel } from "@/components/watchlist/watchlist-panel";
import { getFeed, getTickerMetaMap, getWatchlist } from "@/lib/db/queries";
import { getQuotesMap, type CompactQuote } from "@/lib/providers/finnhub";
import { getSessionId } from "@/lib/session";
import { fifteenDaysAgo } from "@/lib/time-windows";
import { NEWS_TAB_CATEGORIES } from "@/lib/categorizer";
import type { FeedItem } from "@/lib/feed-types";

export const dynamic = "force-dynamic";
export const revalidate = 0;

// News tab — recoge MACRO + OTHER (+ filas sin categoría) que el live
// feed deja fuera. Ventana 15d para que no quede vacía y suficientemente
// amplia para macro coverage. Sin requireTicker porque MACRO suele no
// tener ticker primario asociado.
async function loadInitial(): Promise<{
  feed: FeedItem[];
  watchlist: {
    symbol: string;
    name: string | null;
    sector: string | null;
    logoUrl: string | null;
  }[];
  quotes: Record<string, CompactQuote | null>;
  error?: string;
}> {
  try {
    const session = await getSessionId();
    const [feedRows, watchRows] = await Promise.all([
      getFeed({
        limit: 100,
        since: fifteenDaysAgo(),
        categories: NEWS_TAB_CATEGORIES,
        allowUnknownCategory: true,
        // Sin ticker fuera. FT y otros sources publican company
        // announcements donde el nombre de la compañía no está aún en el
        // alias dict (Finnhub solo enriquece tickers ya conocidos —
        // chicken-and-egg). El resultado eran cards "ft — Bausch Health
        // to Participate..." sin badge de símbolo. Filtramos hasta que
        // exista una pasada de seed de aliases.
        requireTicker: true,
      }),
      getWatchlist(session),
    ]);

    const symbols = new Set<string>();
    for (const r of feedRows) if (r.tickers[0]) symbols.add(r.tickers[0]);
    for (const w of watchRows) symbols.add(w.symbol);
    const meta = await getTickerMetaMap([...symbols]);

    const feed: FeedItem[] = feedRows.map((r) => {
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
      };
    });

    const watchlist = watchRows.map((w) => ({
      symbol: w.symbol,
      name: w.name,
      sector: w.sector,
      logoUrl: meta.get(w.symbol)?.logoUrl ?? null,
    }));

    const quotes = watchlist.length
      ? await getQuotesMap(watchlist.map((w) => w.symbol)).catch(() => ({}))
      : {};

    return { feed, watchlist, quotes };
  } catch (err) {
    return {
      feed: [],
      watchlist: [],
      quotes: {},
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export default async function NewsPage() {
  const { feed, watchlist, quotes, error } = await loadInitial();

  return (
    <div className="flex min-h-full flex-1 flex-col">
      <Header />
      {error ? (
        <div className="border-b border-rose-500/40 bg-rose-500/10 px-6 py-3 font-mono text-xs text-rose-200">
          {error}
        </div>
      ) : null}
      <div className="flex flex-1 overflow-hidden">
        <main className="flex-1 overflow-hidden">
          <FeedList
            initial={feed}
            watchlist={watchlist.map((w) => w.symbol)}
            mode="news"
          />
        </main>
        <WatchlistPanel items={watchlist} initialQuotes={quotes} />
      </div>
    </div>
  );
}
