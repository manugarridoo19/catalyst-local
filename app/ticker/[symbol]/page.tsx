import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { Header } from "@/components/header";
import { PriceChart } from "@/components/ticker/price-chart";
import { NewsSidePanel } from "@/components/ticker/news-side-panel";
import { TickerLogo } from "@/components/ticker/ticker-logo";
import { WatchlistToggle } from "@/components/ticker/watchlist-toggle";
import { getProfile, getQuote } from "@/lib/providers/finnhub";
import { getBars } from "@/lib/providers/yahoo";
import { getFeed, getTickerMetaMap, getWatchlist } from "@/lib/db/queries";
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
  const [profile, quote, bars, newsRows, watchlist, metaMap] = await Promise.all([
    getProfile(symbol).catch(() => null),
    getQuote(symbol).catch(() => null),
    getBars(symbol, "1d").catch(() => []),
    getFeed({ symbol, limit: 80 }).catch(() => []),
    getWatchlist(session).catch(() => []),
    getTickerMetaMap([symbol]),
  ]);

  const news: FeedItem[] = newsRows.map((r) => ({
    id: r.id,
    url: r.url,
    headline: r.headline,
    body: r.body,
    source: r.source,
    publishedAt: r.publishedAt.toISOString(),
    imageUrl: r.imageUrl,
    tickers: r.tickers,
    impact: r.impact,
    sentiment: r.sentiment,
    rationale: r.rationale,
  }));

  const inWatchlist = watchlist.some((w) => w.symbol === symbol);
  const meta = metaMap.get(symbol);
  const displayName = profile?.name ?? meta?.name ?? null;
  const sector = profile?.finnhubIndustry ?? meta?.sector ?? null;
  const logoUrl = profile?.logo ?? meta?.logoUrl ?? null;

  const price = quote?.c ?? null;
  const change = quote?.dp ?? null;

  return (
    <div className="flex min-h-full flex-1 flex-col">
      <Header />

      {/* Hero */}
      <section className="border-b border-border/70 bg-card/30 px-6 py-4">
        <div className="mb-3 flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.22em] text-muted-foreground">
          <Link
            href="/"
            className="inline-flex items-center gap-1 hover:text-foreground"
          >
            <ArrowLeft className="h-3 w-3" /> Feed
          </Link>
          <span className="opacity-50">/</span>
          <span className="text-foreground">{symbol}</span>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <TickerLogo symbol={symbol} logoUrl={logoUrl} size="lg" />
            <div>
              <div className="tick font-mono text-3xl font-bold uppercase tracking-tight tabular-nums">
                {symbol}
              </div>
              <div className="mt-0.5 font-editorial text-base text-muted-foreground">
                {displayName ?? "Unknown company"}
                {sector && (
                  <span className="ml-2 rounded-sm border border-border/60 bg-card/40 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.18em] text-muted-foreground/80">
                    {sector}
                  </span>
                )}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-4">
            {price != null && (
              <div className="text-right">
                <div className="tick font-mono text-2xl font-bold tabular-nums">
                  ${price.toFixed(2)}
                </div>
                {change != null && (
                  <div
                    className={`tick font-mono text-xs tabular-nums ${
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
      </section>

      {/* Chart left, news right */}
      <div className="grid flex-1 grid-cols-1 overflow-hidden lg:grid-cols-[1fr_420px]">
        <main className="relative flex flex-col overflow-hidden border-b border-border/60 lg:border-b-0 lg:border-r">
          <PriceChart
            symbol={symbol}
            initial={bars.map((b) => ({ time: b.time, close: b.close }))}
            initialPeriod="1d"
          />
        </main>
        <aside className="overflow-hidden">
          <NewsSidePanel symbol={symbol} items={news} />
        </aside>
      </div>
    </div>
  );
}
