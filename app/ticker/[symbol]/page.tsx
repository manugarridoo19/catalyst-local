import Link from "next/link";
import { notFound } from "next/navigation";
import { Header } from "@/components/header";
import { NewsCard } from "@/components/feed/news-card";
import { PriceChart, type ChartPoint } from "@/components/ticker/price-chart";
import { WatchlistToggle } from "@/components/ticker/watchlist-toggle";
import { getProfile, getQuote } from "@/lib/providers/finnhub";
import { getDailyBars } from "@/lib/providers/yahoo";
import { getFeed, getWatchlist } from "@/lib/db/queries";
import { getSessionId } from "@/lib/session";
import type { FeedItem } from "@/lib/feed-types";

export const dynamic = "force-dynamic";

type Params = { symbol: string };

export default async function TickerPage({
  params,
}: {
  params: Promise<Params>;
}) {
  const { symbol: raw } = await params;
  const symbol = raw.toUpperCase();
  if (!/^[A-Z0-9.\-]{1,10}$/.test(symbol)) notFound();

  const session = await getSessionId();
  const [profile, quote, bars, newsRows, watchlist] = await Promise.all([
    getProfile(symbol).catch(() => null),
    getQuote(symbol).catch(() => null),
    getDailyBars(symbol, 90).catch(() => []),
    getFeed({ symbol, limit: 50 }).catch(() => []),
    getWatchlist(session).catch(() => []),
  ]);

  const chartData: ChartPoint[] = bars.map((b) => ({
    time: b.date.toISOString().slice(0, 10),
    value: b.close,
  }));

  const news: FeedItem[] = newsRows.map((r) => ({
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
  }));

  const inWatchlist = watchlist.some((w) => w.symbol === symbol);

  const price = quote?.c ?? null;
  const change = quote?.dp ?? null;

  return (
    <div className="flex min-h-full flex-1 flex-col">
      <Header />
      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-6xl px-6 py-6">
          <Link
            href="/"
            className="font-mono text-xs uppercase tracking-widest text-muted-foreground hover:text-foreground"
          >
            ← Back to feed
          </Link>

          <div className="mt-4 flex flex-wrap items-end justify-between gap-4">
            <div>
              <div className="font-mono text-3xl font-bold tracking-tight tabular-nums">
                {symbol}
              </div>
              <div className="text-sm text-muted-foreground">
                {profile?.name ?? "Unknown company"}
                {profile?.finnhubIndustry && (
                  <>
                    <span className="mx-2 opacity-50">·</span>
                    {profile.finnhubIndustry}
                  </>
                )}
              </div>
            </div>
            <div className="flex items-center gap-3">
              {price != null && (
                <div className="text-right">
                  <div className="font-mono text-2xl font-bold tabular-nums">
                    ${price.toFixed(2)}
                  </div>
                  {change != null && (
                    <div
                      className={`font-mono text-xs tabular-nums ${
                        change >= 0 ? "text-emerald-400" : "text-rose-400"
                      }`}
                    >
                      {change >= 0 ? "+" : ""}
                      {change.toFixed(2)}%
                    </div>
                  )}
                </div>
              )}
              <WatchlistToggle symbol={symbol} initial={inWatchlist} />
            </div>
          </div>

          <section className="mt-6 rounded border border-border bg-card/30 p-4">
            <div className="mb-2 font-mono text-xs uppercase tracking-widest text-muted-foreground">
              90 day price
            </div>
            {chartData.length === 0 ? (
              <div className="flex h-72 items-center justify-center text-xs text-muted-foreground">
                No historical data available.
              </div>
            ) : (
              <PriceChart data={chartData} />
            )}
          </section>

          <section className="mt-6">
            <div className="mb-2 font-mono text-xs uppercase tracking-widest text-muted-foreground">
              News · {symbol} · {news.length}
            </div>
            <div className="rounded border border-border bg-card/30">
              {news.length === 0 ? (
                <div className="p-6 text-center text-xs text-muted-foreground">
                  No scored news for this ticker yet.
                </div>
              ) : (
                news.map((n) => <NewsCard key={n.id} item={n} dense={false} />)
              )}
            </div>
          </section>
        </div>
      </main>
    </div>
  );
}
