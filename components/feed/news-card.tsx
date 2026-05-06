import Link from "next/link";
import { formatDistanceToNowStrict } from "date-fns";
import { ImpactBadge, SentimentBadge } from "./score-badges";
import { TickerLogo } from "@/components/ticker/ticker-logo";
import type { FeedItem } from "@/lib/feed-types";
import { cn } from "@/lib/utils";

// Card compacta del feed: logo + TICKER MAYÚSCULAS | mini headline | scores.
// Toda la card es un Link al detalle del ticker primario, con `?news=ID` para
// que la vista detalle pueda hacer scroll y expandir esa noticia.
export function NewsCard({
  item,
  fresh = false,
}: {
  item: FeedItem;
  fresh?: boolean;
}) {
  const ago = formatDistanceToNowStrict(new Date(item.publishedAt), {
    addSuffix: false,
  });
  const primary = item.primarySymbol ?? item.tickers[0] ?? null;
  const direction =
    item.sentiment == null ? null : item.sentiment > 0 ? "▲" : item.sentiment < 0 ? "▼" : null;

  const inner = (
    <div
      className={cn(
        "group grid grid-cols-[auto_1fr_auto] items-center gap-4 border-b border-border/40 px-5 py-3 transition-all duration-150 hover:bg-foreground/[0.025]",
        fresh && "news-fresh",
      )}
    >
      {/* Left: logo + ticker uppercase */}
      <div className="flex w-32 items-center gap-3">
        {primary ? (
          <TickerLogo symbol={primary} logoUrl={item.primaryLogo ?? undefined} size="md" />
        ) : (
          <div className="flex h-9 w-9 items-center justify-center rounded-md border border-border/60 bg-card/60 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
            mkt
          </div>
        )}
        <div className="flex flex-col leading-tight min-w-0">
          <span className="tick font-mono text-sm font-bold uppercase text-foreground">
            {primary ?? "MKT"}
          </span>
          {direction && (
            <span
              className={cn(
                "font-mono text-[10px] leading-none",
                item.sentiment != null && item.sentiment > 0 && "text-emerald-400",
                item.sentiment != null && item.sentiment < 0 && "text-rose-400",
              )}
            >
              {direction}
            </span>
          )}
        </div>
      </div>

      {/* Mini headline (single line truncated) */}
      <div className="min-w-0">
        <h3
          className="font-editorial truncate text-[15px] font-medium leading-snug text-foreground transition-colors group-hover:text-primary"
          title={item.headline}
        >
          {item.headline}
        </h3>
        <div className="mt-0.5 flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground/80">
          <span className="truncate">
            {item.source.replace(/^(rss:|finnhub:|marketaux:)/, "")}
          </span>
          <span className="opacity-40">/</span>
          <span className="tick whitespace-nowrap">{ago}</span>
          {item.tickers.length > 1 && (
            <>
              <span className="opacity-40">/</span>
              <span className="tick whitespace-nowrap">+{item.tickers.length - 1}</span>
            </>
          )}
        </div>
      </div>

      {/* Right: scores */}
      <div className="flex items-center gap-2 self-center pl-3">
        <ImpactBadge value={item.impact} />
        <SentimentBadge value={item.sentiment} />
      </div>
    </div>
  );

  // Si no hay ticker primario, la card no navega — solo expone link externo
  // como fallback en el headline (modo macro/MKT).
  if (!primary) {
    return (
      <a
        href={item.url}
        target="_blank"
        rel="noreferrer noopener"
        className="block"
      >
        {inner}
      </a>
    );
  }

  return (
    <Link
      href={`/ticker/${primary}?news=${item.id}`}
      className="block"
      prefetch={false}
    >
      {inner}
    </Link>
  );
}
