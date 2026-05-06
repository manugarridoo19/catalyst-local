import Link from "next/link";
import { formatDistanceToNowStrict } from "date-fns";
import { ImpactBadge, SentimentBadge } from "./score-badges";
import type { FeedItem } from "@/lib/feed-types";
import { cn } from "@/lib/utils";

export function NewsCard({
  item,
  dense = true,
  fresh = false,
}: {
  item: FeedItem;
  dense?: boolean;
  fresh?: boolean;
}) {
  const ago = formatDistanceToNowStrict(new Date(item.publishedAt), {
    addSuffix: false,
  });

  // Direccional sutil — flecha pequeña en el chip si hay sentiment definido.
  const direction =
    item.sentiment == null ? null : item.sentiment > 0 ? "▲" : item.sentiment < 0 ? "▼" : "·";

  return (
    <article
      className={cn(
        "group relative grid grid-cols-[auto_1fr_auto] items-start gap-4 border-b border-border/40 px-5 transition-all duration-200 hover:bg-foreground/[0.015]",
        dense ? "py-3" : "py-5",
        fresh && "news-fresh",
      )}
    >
      {/* Tickers chips — left rail */}
      <div className="flex flex-wrap items-center gap-1 pt-1">
        {item.tickers.length === 0 ? (
          <span className="rounded-sm border border-border/50 bg-card/40 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
            mkt
          </span>
        ) : (
          item.tickers.slice(0, 3).map((t) => (
            <Link
              key={t}
              href={`/ticker/${t}`}
              className="group/chip flex items-center gap-1 rounded-sm border border-border/70 bg-card/60 px-1.5 py-0.5 font-mono text-[11px] font-semibold uppercase tabular-nums text-foreground transition-colors hover:border-primary/70 hover:bg-primary/[0.08] hover:text-primary"
            >
              <span className="tick">{t}</span>
              {direction && (
                <span
                  className={cn(
                    "text-[8px] leading-none",
                    item.sentiment != null && item.sentiment > 0 && "text-emerald-400/80",
                    item.sentiment != null && item.sentiment < 0 && "text-rose-400/80",
                    item.sentiment === 0 && "text-muted-foreground",
                  )}
                >
                  {direction}
                </span>
              )}
            </Link>
          ))
        )}
        {item.tickers.length > 3 && (
          <span className="self-center font-mono text-[10px] text-muted-foreground/70">
            +{item.tickers.length - 3}
          </span>
        )}
      </div>

      {/* Headline + meta */}
      <div className="min-w-0">
        <a
          href={item.url}
          target="_blank"
          rel="noreferrer noopener"
          className="font-editorial block truncate text-[15px] font-medium leading-snug text-foreground transition-colors group-hover:text-primary"
          title={item.headline}
        >
          {item.headline}
        </a>
        <div className="mt-1 flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground/80">
          <span>{item.source.replace(/^(rss:|finnhub:|marketaux:)/, "")}</span>
          <span className="opacity-40">/</span>
          <span className="tick">{ago}</span>
          {item.rationale && (
            <>
              <span className="opacity-40">/</span>
              <span className="truncate normal-case tracking-normal italic text-muted-foreground">
                {item.rationale}
              </span>
            </>
          )}
        </div>
      </div>

      {/* Scores */}
      <div className="flex items-center gap-2 self-center pl-3">
        <ImpactBadge value={item.impact} />
        <SentimentBadge value={item.sentiment} />
      </div>
    </article>
  );
}
