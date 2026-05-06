import Link from "next/link";
import { formatDistanceToNowStrict } from "date-fns";
import { ImpactBadge, SentimentBadge } from "./score-badges";
import type { FeedItem } from "@/lib/feed-types";
import { cn } from "@/lib/utils";

export function NewsCard({ item, dense = true }: { item: FeedItem; dense?: boolean }) {
  const ago = formatDistanceToNowStrict(new Date(item.publishedAt), {
    addSuffix: false,
  });
  return (
    <article
      className={cn(
        "group grid grid-cols-[auto_1fr_auto] items-start gap-3 border-b border-border/50 px-4 transition-colors hover:bg-muted/30",
        dense ? "py-2.5" : "py-4",
      )}
    >
      {/* Tickers chips */}
      <div className="flex flex-wrap gap-1 pt-0.5">
        {item.tickers.length === 0 ? (
          <span className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
            mkt
          </span>
        ) : (
          item.tickers.slice(0, 3).map((t) => (
            <Link
              key={t}
              href={`/ticker/${t}`}
              className="rounded border border-border bg-card px-1.5 py-0.5 font-mono text-[11px] font-semibold tabular-nums text-foreground hover:border-amber-400/60 hover:text-amber-300"
            >
              {t}
            </Link>
          ))
        )}
        {item.tickers.length > 3 && (
          <span className="self-center font-mono text-[10px] text-muted-foreground">
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
          className="block truncate text-sm font-medium text-foreground transition-colors group-hover:text-amber-200"
          title={item.headline}
        >
          {item.headline}
        </a>
        <div className="mt-1 flex items-center gap-2 text-[11px] text-muted-foreground">
          <span className="font-mono uppercase tracking-wide">{item.source.replace(/^(rss:|finnhub:|marketaux:)/, "")}</span>
          <span>·</span>
          <span className="font-mono tabular-nums">{ago}</span>
          {item.rationale && (
            <>
              <span>·</span>
              <span className="truncate italic">{item.rationale}</span>
            </>
          )}
        </div>
      </div>

      {/* Scores */}
      <div className="flex items-center gap-2 self-center">
        <ImpactBadge value={item.impact} />
        <SentimentBadge value={item.sentiment} />
      </div>
    </article>
  );
}
