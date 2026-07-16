import { Header } from "@/components/header";
import { FeedList } from "@/components/feed/feed-list";
import { BriefPanel } from "@/components/feed/brief-panel";
import { PicksPanel } from "@/components/feed/picks-panel";
import { WatchlistPanel } from "@/components/watchlist/watchlist-panel";
import { getFeed, getTickerMetaMap, getWatchlist } from "@/lib/db/queries";
import { getLatestBrief, type BriefRow } from "@/lib/ai/brief";
import { getLatestPicks, type PicksRow } from "@/lib/ai/picks";
import {
  getUpcomingEarnings,
  type UpcomingEarning,
} from "@/lib/cron/refresh-earnings";
import { EarningsPanel } from "@/components/watchlist/earnings-panel";
import { getQuotesMap, type CompactQuote } from "@/lib/providers/finnhub";
import { getSessionId } from "@/lib/session";
import { startOfTodayUtc } from "@/lib/time-windows";
import { LIVE_FEED_CATEGORIES } from "@/lib/categorizer";
import type { FeedItem } from "@/lib/feed-types";

export const dynamic = "force-dynamic";
export const revalidate = 0;

async function loadInitial(): Promise<{
  feed: FeedItem[];
  watchlist: {
    symbol: string;
    name: string | null;
    sector: string | null;
    logoUrl: string | null;
  }[];
  quotes: Record<string, CompactQuote | null>;
  brief: BriefRow | null;
  picks: PicksRow | null;
  earnings: UpcomingEarning[];
  error?: string;
}> {
  try {
    const session = await getSessionId();
    const [feedRows, watchRows, brief, picks, earnings] = await Promise.all([
      // Live feed: solo noticias del día (UTC) con ticker asociado y
      // categoría de signal (ANALYST/EARNINGS/MA/GUIDANCE/INSIDER/REG/
      // LEGAL/PRODUCT). MACRO y OTHER viven en /news. Orden estricto por
      // publishedAt DESC — el tiempo manda. Items aún sin grading entran
      // y aparecen con placeholder; Pusher rebroadcast pinta el score
      // cuando llega.
      getFeed({
        limit: 100,
        requireTicker: true,
        since: startOfTodayUtc(),
        categories: LIVE_FEED_CATEGORIES,
      }),
      getWatchlist(session),
      // Brief más reciente — puede no existir aún (tabla vacía → null).
      getLatestBrief().catch(() => null),
      getLatestPicks().catch(() => null),
      getUpcomingEarnings().catch(() => []),
    ]);

    // Recolectar symbols primarios + watchlist para una sola query de meta.
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

    // Quotes iniciales para watchlist + AI Picks (una sola pasada) — evita
    // el flash "—" en SSR. Si Finnhub está lento o caído, devolvemos {} y
    // el cliente refresca (los picks pierden su % del día, no pasa nada).
    const quoteSymbols = [
      ...watchlist.map((w) => w.symbol),
      ...(picks?.picks.map((p) => p.symbol) ?? []),
    ];
    const quotes = quoteSymbols.length
      ? await getQuotesMap(quoteSymbols).catch(() => ({}))
      : {};

    return { feed, watchlist, quotes, brief, picks, earnings };
  } catch (err) {
    return {
      feed: [],
      watchlist: [],
      quotes: {},
      brief: null,
      picks: null,
      earnings: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export default async function HomePage() {
  const { feed, watchlist, quotes, brief, picks, earnings, error } =
    await loadInitial();

  return (
    <div className="flex min-h-full flex-1 flex-col">
      <Header />
      {error ? <SetupBanner message={error} /> : null}
      <BriefPanel brief={brief} />
      <PicksPanel picks={picks} quotes={quotes} />
      <div className="flex flex-1 overflow-hidden">
        <main className="flex-1 overflow-hidden">
          <FeedList
            initial={feed}
            watchlist={watchlist.map((w) => w.symbol)}
          />
        </main>
        <WatchlistPanel
          items={watchlist}
          initialQuotes={quotes}
          footer={<EarningsPanel events={earnings} />}
        />
      </div>
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
