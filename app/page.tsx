import { Header } from "@/components/header";
import { FeedList } from "@/components/feed/feed-list";
import { WatchlistPanel } from "@/components/watchlist/watchlist-panel";
import { CommandPalette } from "@/components/search/command-palette";
import { getFeed, getWatchlist } from "@/lib/db/queries";
import { getSessionId } from "@/lib/session";
import type { FeedItem } from "@/lib/feed-types";

export const dynamic = "force-dynamic";
export const revalidate = 0;

async function loadInitial(): Promise<{
  feed: FeedItem[];
  watchlist: { symbol: string; name: string | null; sector: string | null }[];
  error?: string;
}> {
  try {
    const session = await getSessionId();
    const [feedRows, watchRows] = await Promise.all([
      getFeed({ limit: 100 }),
      getWatchlist(session),
    ]);
    return {
      feed: feedRows.map((r) => ({
        id: r.id,
        url: r.url,
        headline: r.headline,
        source: r.source,
        publishedAt: r.publishedAt.toISOString(),
        imageUrl: r.imageUrl,
        tickers: r.tickers,
        impact: r.impact,
        sentiment: r.sentiment,
        rationale: r.rationale,
      })),
      watchlist: watchRows.map((w) => ({
        symbol: w.symbol,
        name: w.name,
        sector: w.sector,
      })),
    };
  } catch (err) {
    return {
      feed: [],
      watchlist: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export default async function HomePage() {
  const { feed, watchlist, error } = await loadInitial();

  return (
    <div className="flex min-h-full flex-1 flex-col">
      <Header />
      {error ? <SetupBanner message={error} /> : null}
      <div className="flex flex-1 overflow-hidden">
        <main className="flex-1 overflow-hidden">
          <FeedList
            initial={feed}
            watchlist={watchlist.map((w) => w.symbol)}
          />
        </main>
        <WatchlistPanel items={watchlist} />
      </div>
      <CommandPalette />
    </div>
  );
}

function SetupBanner({ message }: { message: string }) {
  return (
    <div className="border-b border-amber-500/40 bg-amber-500/10 px-6 py-3 font-mono text-xs text-amber-200">
      <div className="mb-1 font-semibold uppercase tracking-widest">
        Setup pendiente
      </div>
      <div>
        DB no accesible: <span className="opacity-80">{message}</span>
      </div>
      <div className="mt-1 opacity-80">
        Rellena <code>.env.local</code> y corre{" "}
        <code className="rounded bg-amber-500/20 px-1">pnpm db:push</code>{" "}
        para crear las tablas en Neon.
      </div>
    </div>
  );
}
