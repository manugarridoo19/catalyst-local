"use client";

import Link from "next/link";
import { formatDistanceToNowStrict } from "date-fns";
import { ArrowRight } from "lucide-react";
import { ImpactBadge, SentimentBadge } from "./score-badges";
import { CategoryBadge } from "./category-badge";
import { NewsExpanded, cleanSource, sentimentBgClass } from "./news-shared";
import { TickerLogo } from "@/components/ticker/ticker-logo";
import type { FeedItem } from "@/lib/feed-types";
import { cn } from "@/lib/utils";

// Source → short label + chroma tint, used only when there's no primary
// ticker (macro / MKT mode).
const SOURCE_LABEL: Record<string, { label: string; tint: string }> = {
  "rss:marketwatch": { label: "MW", tint: "from-amber-400/40 to-amber-600/15" },
  "rss:yahoo-finance": { label: "YF", tint: "from-violet-400/40 to-violet-600/15" },
  "rss:cnbc-business": { label: "CNBC", tint: "from-rose-400/40 to-rose-600/15" },
  "rss:seeking-alpha": { label: "SA", tint: "from-orange-400/40 to-orange-600/15" },
  "rss:investing-com": { label: "INV", tint: "from-cyan-400/40 to-cyan-600/15" },
  "rss:marketbeat": { label: "MB", tint: "from-emerald-400/40 to-emerald-600/15" },
  "rss:marketbeat-ratings": { label: "MB★", tint: "from-emerald-400/40 to-emerald-600/15" },
  "rss:benzinga": { label: "BZ", tint: "from-fuchsia-400/40 to-fuchsia-600/15" },
  "rss:benzinga-news": { label: "BZ", tint: "from-fuchsia-400/40 to-fuchsia-600/15" },
  "rss:motley-fool": { label: "FOOL", tint: "from-yellow-400/40 to-yellow-600/15" },
  "rss:reuters-business": { label: "RTRS", tint: "from-orange-400/40 to-orange-600/15" },
  "rss:ft-companies": { label: "FT", tint: "from-pink-400/40 to-pink-600/15" },
  "rss:bloomberg": { label: "BBG", tint: "from-orange-400/40 to-orange-600/15" },
  "rss:barrons": { label: "BARR", tint: "from-blue-400/40 to-blue-600/15" },
  "rss:wsj-markets": { label: "WSJ", tint: "from-zinc-400/40 to-zinc-600/15" },
  "rss:zacks": { label: "ZCKS", tint: "from-blue-400/40 to-blue-600/15" },
  "rss:thestreet": { label: "TST", tint: "from-red-400/40 to-red-600/15" },
  "rss:forbes-markets": { label: "FRBS", tint: "from-slate-400/40 to-slate-600/15" },
  "rss:etftrends": { label: "ETF", tint: "from-indigo-400/40 to-indigo-600/15" },
  "rss:kiplinger": { label: "KIP", tint: "from-teal-400/40 to-teal-600/15" },
  "rss:tipranks": { label: "TIP", tint: "from-purple-400/40 to-purple-600/15" },
  "rss:sec-8k": { label: "8-K", tint: "from-orange-400/40 to-orange-600/15" },
};

function sourceChip(source: string) {
  const direct = SOURCE_LABEL[source];
  if (direct) return direct;
  if (source.startsWith("finnhub:")) return { label: "FH", tint: "from-sky-400/40 to-sky-600/15" };
  if (source.startsWith("marketaux:")) return { label: "MX", tint: "from-teal-400/40 to-teal-600/15" };
  if (source.startsWith("gnews:")) return { label: "GN", tint: "from-blue-400/40 to-blue-600/15" };
  return { label: "MKT", tint: "from-zinc-400/40 to-zinc-600/15" };
}

type Props = {
  item: FeedItem;
  fresh?: boolean;
  expanded?: boolean;
  onToggle?: () => void;
  staggerIndex?: number;
};

export function NewsCard({
  item,
  fresh = false,
  expanded = false,
  onToggle,
  staggerIndex = 0,
}: Props) {
  const ago = formatDistanceToNowStrict(new Date(item.publishedAt), {
    addSuffix: false,
  });
  const primary = item.primarySymbol ?? item.tickers[0] ?? null;
  const chip = sourceChip(item.source);
  const isHighImpact = (item.impact ?? 0) >= 4;
  const sentimentBg = sentimentBgClass(item.sentiment);

  return (
    <article
      style={{ "--stagger-i": staggerIndex } as React.CSSProperties}
      className={cn(
        "stagger-in group relative border-b border-border/30",
        sentimentBg,
        fresh && "news-fresh",
        expanded && "bg-card/50",
      )}
    >
      {/* High-impact rail — single 2px copper bar on the far-left, only
          when impact ≥ 4. Replaces the previous sentiment side-stripe
          (banned pattern) and reserves the marker for a genuine signal. */}
      {isHighImpact && (
        <span
          aria-hidden
          className="pointer-events-none absolute inset-y-0 left-0 w-[2px] bg-primary/80"
        />
      )}

      {/* Card head — different click zones:
            logo + ticker → navigate to ticker profile
            headline    → expand inline */}
      <div
        className={cn(
          "relative grid grid-cols-[auto_1fr_auto] items-center gap-4 px-5 py-4 transition-colors duration-200",
          "hover:bg-foreground/[0.02]",
        )}
      >
        {/* Left: logo + ticker uppercase */}
        {primary ? (
          <Link
            href={`/ticker/${primary}`}
            prefetch={false}
            className="group/logo flex w-32 items-center gap-3"
            title={`Open ${primary} profile`}
          >
            <TickerLogo
              symbol={primary}
              logoUrl={item.primaryLogo ?? undefined}
              size="md"
              className="transition-transform duration-200 group-hover/logo:scale-[1.06] group-hover/logo:ring-2 group-hover/logo:ring-primary/40"
            />
            <div className="flex min-w-0 flex-col leading-tight">
              <span className="tick truncate font-mono text-sm font-bold uppercase text-foreground transition-colors group-hover/logo:text-primary">
                {primary}
              </span>
              {item.tickers.length > 1 && (
                <span className="tick mt-0.5 font-mono text-[10px] leading-none text-muted-foreground/70">
                  +{item.tickers.length - 1}
                </span>
              )}
            </div>
          </Link>
        ) : (
          <div className="flex w-32 items-center gap-3">
            <div
              className={cn(
                "flex h-9 w-9 items-center justify-center rounded-md border border-border/60 bg-gradient-to-br font-mono text-[9px] font-bold uppercase tracking-wider text-foreground",
                chip.tint,
              )}
            >
              {chip.label}
            </div>
            <span className="tick truncate font-mono text-sm font-bold uppercase text-foreground">
              {chip.label}
            </span>
          </div>
        )}

        {/* Middle: headline + meta — clicking expands */}
        <button
          type="button"
          onClick={onToggle}
          className="group/expand min-w-0 cursor-pointer text-left"
          aria-expanded={expanded}
        >
          <div className="flex items-start gap-2">
            <CategoryBadge value={item.category} className="mt-0.5 shrink-0" />
            <h3
              className={cn(
                "font-editorial font-medium text-foreground transition-colors duration-200 group-hover/expand:text-primary",
                isHighImpact ? "text-[17px] leading-[1.3]" : "text-[15px] leading-[1.34]",
                expanded ? "" : "line-clamp-2",
              )}
            >
              {item.headline}
            </h3>
          </div>
          {item.body && !expanded && (
            <p className="font-editorial mt-1 line-clamp-1 text-[13px] italic leading-relaxed text-muted-foreground/75">
              {item.body}
            </p>
          )}
          <div className="eyebrow mt-2 flex items-center gap-2 text-[10px]">
            <span className="truncate normal-case tracking-[0.16em]">
              {cleanSource(item.source)}
            </span>
            <span className="opacity-30">·</span>
            <span className="tick whitespace-nowrap normal-case tracking-[0.12em]">
              {ago}
            </span>
          </div>
        </button>

        {/* Right: scores — sentiment bar + impact dot scale */}
        <div className="flex flex-col items-end gap-2 self-center pl-3">
          <SentimentBadge value={item.sentiment} />
          <div className="flex items-center gap-1.5">
            <span className="eyebrow-sm text-muted-foreground/55">Signif</span>
            <ImpactBadge value={item.impact} size="sm" />
          </div>
        </div>
      </div>

      {/* Expanded body */}
      {expanded && (
        <div className="card-expand border-t border-border/30 bg-card/30 px-5 py-4">
          <div className="ml-32 mr-4 max-w-3xl">
            <NewsExpanded
              item={item}
              extra={
                primary ? (
                  <Link
                    href={`/ticker/${primary}?news=${item.id}`}
                    onClick={(e) => e.stopPropagation()}
                    className="inline-flex items-center gap-1.5 rounded-sm border border-border/70 bg-card/60 px-3 py-1.5 font-mono text-[11px] font-semibold uppercase tracking-[0.18em] text-foreground transition-all duration-150 hover:-translate-y-px hover:border-primary/50 hover:text-primary"
                  >
                    Open {primary}
                    <ArrowRight className="h-3 w-3 transition-transform duration-150 group-hover:translate-x-0.5" />
                  </Link>
                ) : null
              }
            />
          </div>
        </div>
      )}
    </article>
  );
}
