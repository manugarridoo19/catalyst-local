import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { Header } from "@/components/header";
import { TradingViewChart } from "@/components/ticker/tradingview-chart";
import { NewsSidePanel } from "@/components/ticker/news-side-panel";
import { TickerBrief } from "@/components/ticker/ticker-brief";
import { TickerLogo } from "@/components/ticker/ticker-logo";
import { WatchlistToggle } from "@/components/ticker/watchlist-toggle";
import { getProfile, getQuote } from "@/lib/providers/finnhub";
import { getFeed, getTickerMetaMap, getWatchlist } from "@/lib/db/queries";
import { getSessionId } from "@/lib/session";
import { fifteenDaysAgo } from "@/lib/time-windows";
import type { FeedItem } from "@/lib/feed-types";

export const dynamic = "force-dynamic";

type Params = { symbol: string };

// Finnhub devuelve marketCapitalization en MILLONES de USD.
function formatMarketCap(millions: number): string {
  if (millions >= 1_000_000) return `$${(millions / 1_000_000).toFixed(2)}T`;
  if (millions >= 1_000) return `$${(millions / 1_000).toFixed(2)}B`;
  return `$${millions.toFixed(0)}M`;
}

export default async function TickerPage({
  params,
}: {
  params: Promise<Params>;
}) {
  const { symbol: raw } = await params;
  const symbol = raw.toUpperCase();
  if (!/^[A-Z0-9.\-]{1,10}$/.test(symbol)) notFound();

  const session = await getSessionId();
  const [profile, quote, newsRows, watchlist, metaMap] = await Promise.all([
    getProfile(symbol).catch(() => null),
    getQuote(symbol).catch(() => null),
    // Orden estricto por publishedAt DESC — el tiempo manda, igual que en
    // el live feed. Sin filtro de categoría: en la página del ticker el
    // usuario quiere TODA la cobertura, incluyendo macro/otros.
    getFeed({
      symbol,
      limit: 100,
      since: fifteenDaysAgo(),
    }).catch(() => []),
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
    category: r.category,
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
    // h-screen + overflow-hidden encierra el layout en el viewport. Sin esto,
    // el chart TradingView (autosize) crece a la altura natural del iframe
    // de TV (~600px ó más) y la página se hace scrollable sin sentido —
    // bajas y bajas dentro del chart en vez de ver la lista de noticias.
    <div className="flex h-screen flex-col overflow-hidden">
      <Header />

      {/* Hero */}
      <section className="relative shrink-0 overflow-hidden border-b border-border/70 bg-gradient-to-br from-card/50 via-card/30 to-transparent px-6 py-5">
        <div className="absolute inset-0 -z-0 opacity-[0.04] [mask-image:radial-gradient(circle_at_top_left,black,transparent_70%)]">
          <div className="h-full w-full bg-[radial-gradient(circle_at_30%_50%,oklch(0.78_0.13_75)_0%,transparent_60%)]" />
        </div>
        <div className="relative">
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
          <div className="flex flex-wrap items-center justify-between gap-6">
            <div className="flex items-center gap-5">
              <TickerLogo symbol={symbol} logoUrl={logoUrl} size="lg" />
              <div>
                <div className="tick font-mono text-4xl font-bold uppercase tracking-tight tabular-nums leading-none">
                  {symbol}
                </div>
                <div className="mt-1.5 font-editorial text-base text-muted-foreground">
                  {displayName ?? "Unknown company"}
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  {sector && (
                    <span className="rounded-sm border border-border/60 bg-card/40 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.18em] text-muted-foreground/80">
                      {sector}
                    </span>
                  )}
                  {profile?.exchange && (
                    <span className="rounded-sm border border-border/60 bg-card/40 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.18em] text-muted-foreground/80">
                      {profile.exchange}
                    </span>
                  )}
                  {profile?.country && (
                    <span className="rounded-sm border border-border/60 bg-card/40 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.18em] text-muted-foreground/80">
                      {profile.country}
                    </span>
                  )}
                  {news.length > 0 && (
                    <span className="rounded-sm border border-primary/40 bg-primary/10 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.18em] text-primary">
                      {news.length} news
                    </span>
                  )}
                </div>
              </div>
            </div>
            <div className="flex items-center gap-5">
              {price != null && (
                <div className="text-right">
                  <div className="tick font-mono text-3xl font-bold tabular-nums leading-none">
                    ${price.toFixed(2)}
                  </div>
                  {change != null && (
                    <div
                      className={`tick mt-1.5 inline-flex items-center gap-1 rounded-sm border px-1.5 py-0.5 font-mono text-xs tabular-nums ${
                        change >= 0
                          ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                          : "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300"
                      }`}
                    >
                      {change >= 0 ? "▲" : "▼"} {change >= 0 ? "+" : ""}
                      {change.toFixed(2)}%
                    </div>
                  )}
                </div>
              )}
              {profile?.marketCapitalization != null && profile.marketCapitalization > 0 && (
                <div className="hidden text-right md:block">
                  <div className="font-mono text-[9px] uppercase tracking-[0.22em] text-muted-foreground/70">
                    Market cap
                  </div>
                  <div className="tick font-mono text-base font-semibold tabular-nums text-foreground">
                    {formatMarketCap(profile.marketCapitalization)}
                  </div>
                </div>
              )}
              <WatchlistToggle symbol={symbol} initial={inWatchlist} />
            </div>
          </div>
        </div>
      </section>

      {/* Chart left, news right.
          Móvil: una columna, chart altura fija razonable y news debajo
          scrollable como parte del flujo de página.
          Desktop: chart fill + news 440px panel lateral, ambos contenidos.
          min-h-0 es crítico — sin él los hijos flex no pueden achicarse
          y se desbordan, causando el efecto "estirado horizontal" que veías. */}
      <div className="flex flex-1 min-h-0 flex-col overflow-y-auto lg:grid lg:grid-cols-[minmax(0,1fr)_440px] lg:overflow-hidden">
        <main className="relative flex h-[50vh] min-h-[320px] flex-col overflow-hidden border-b border-border/60 lg:h-auto lg:border-b-0 lg:border-r">
          <TradingViewChart symbol={symbol} />
        </main>
        <aside className="flex min-h-0 flex-1 flex-col lg:overflow-hidden">
          {/* Cuadro AI del día: se rellena async (la 1ª generación puede
              tardar; el caché BD hace instantáneas las siguientes). */}
          <TickerBrief symbol={symbol} />
          <div className="min-h-0 flex-1">
            <NewsSidePanel symbol={symbol} items={news} />
          </div>
        </aside>
      </div>
    </div>
  );
}
