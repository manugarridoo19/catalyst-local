"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { formatDistanceToNowStrict } from "date-fns";
import { ImpactBadge, SentimentBadge } from "@/components/feed/score-badges";
import { CategoryBadge } from "@/components/feed/category-badge";
import { NewsExpanded, cleanSource, sentimentClasses } from "@/components/feed/news-shared";
import type { FeedItem } from "@/lib/feed-types";
import { cn } from "@/lib/utils";

type Props = {
  symbol: string;
  items: FeedItem[];
};

const CATEGORY_FILTERS = [
  { id: "all" as const, label: "All" },
  { id: "EARNINGS" as const, label: "Earnings" },
  { id: "ANALYST" as const, label: "Analyst" },
  { id: "MA" as const, label: "M&A" },
  { id: "GUIDANCE" as const, label: "Guidance" },
  { id: "PRODUCT" as const, label: "Product" },
];

type CategoryFilter = (typeof CATEGORY_FILTERS)[number]["id"];

// Lista visual de noticias del ticker. Click toggles expand inline. Si
// llegas con ?news=ID, esa noticia aparece expandida y hace scroll.
export function NewsSidePanel({ symbol, items }: Props) {
  const router = useRouter();
  const search = useSearchParams();
  const initialFocused = (() => {
    const n = Number(search.get("news"));
    return Number.isFinite(n) && n > 0 ? n : null;
  })();
  const [expanded, setExpanded] = useState<Set<number>>(() => {
    const s = new Set<number>();
    if (initialFocused) s.add(initialFocused);
    return s;
  });
  const [filter, setFilter] = useState<CategoryFilter>("all");
  const focusedRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (initialFocused && focusedRef.current) {
      focusedRef.current.scrollIntoView({ behavior: "instant", block: "start" });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function toggle(id: number) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    if (id === initialFocused) {
      const params = new URLSearchParams(search.toString());
      params.delete("news");
      router.replace(`/ticker/${symbol}${params.size ? `?${params}` : ""}`, {
        scroll: false,
      });
    }
  }

  const filtered =
    filter === "all" ? items : items.filter((it) => it.category === filter);

  return (
    <aside className="flex h-full flex-col bg-card/20">
      <div className="flex items-center justify-between border-b border-border/60 px-4 py-2.5">
        <div className="flex items-center gap-2">
          <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-muted-foreground">
            {symbol} news
          </div>
          <span className="tick rounded-sm border border-border/60 bg-card/60 px-1.5 py-0.5 font-mono text-[10px] text-foreground">
            {filtered.length}
          </span>
        </div>
      </div>

      {/* Category filter chips */}
      <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-border/40 bg-card/10 px-3 py-2 font-mono text-[10px]">
        {CATEGORY_FILTERS.map((f) => (
          <button
            key={f.id}
            onClick={() => setFilter(f.id)}
            className={cn(
              "shrink-0 rounded-sm border px-2 py-0.5 uppercase tracking-[0.18em] transition-all",
              filter === f.id
                ? "border-primary/60 bg-primary/10 text-primary"
                : "border-border/60 text-muted-foreground hover:border-foreground/30 hover:text-foreground",
            )}
          >
            {f.label}
          </button>
        ))}
      </div>

      <div className="cat-scroll flex-1 overflow-y-auto">
        {filtered.length === 0 ? (
          <div className="flex h-full items-center justify-center p-8 text-center text-xs text-muted-foreground">
            No news for this filter.
          </div>
        ) : (
          filtered.map((it, idx) => (
            <NewsRow
              key={it.id}
              item={it}
              expanded={expanded.has(it.id)}
              focused={it.id === initialFocused}
              onToggle={() => toggle(it.id)}
              ref={it.id === initialFocused ? focusedRef : undefined}
              staggerIndex={Math.min(idx, 20)}
            />
          ))
        )}
      </div>
    </aside>
  );
}

const NewsRow = function NewsRow({
  item,
  expanded,
  focused,
  onToggle,
  ref,
  staggerIndex,
}: {
  item: FeedItem;
  expanded: boolean;
  focused: boolean;
  onToggle: () => void;
  ref?: React.Ref<HTMLDivElement>;
  staggerIndex: number;
}) {
  const ago = formatDistanceToNowStrict(new Date(item.publishedAt), {
    addSuffix: false,
  });
  const { tone: sentimentTone, bg: sentimentBg } = sentimentClasses(item.sentiment);

  return (
    <div
      ref={ref}
      style={{ "--stagger-i": staggerIndex } as React.CSSProperties}
      className={cn(
        "stagger-in relative border-b border-border/30 bg-gradient-to-r border-l-[3px]",
        sentimentTone,
        sentimentBg,
        focused && "bg-primary/[0.04]",
        expanded && "bg-card/40",
      )}
    >
      <button
        type="button"
        onClick={onToggle}
        className="block w-full px-4 py-3 text-left transition-colors hover:bg-foreground/[0.025]"
      >
        <div className="mb-1.5 flex items-center justify-between gap-2">
          <CategoryBadge value={item.category} />
          <div className="flex items-center gap-1.5">
            <ImpactBadge value={item.impact} size="sm" />
            <SentimentBadge value={item.sentiment} size="sm" />
          </div>
        </div>
        <h4
          className={cn(
            "font-editorial text-[14px] font-medium leading-[1.35] text-foreground transition-colors",
            !expanded && "line-clamp-2",
          )}
        >
          {item.headline}
        </h4>
        <div className="mt-1.5 flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground/80">
          <span className="truncate">{cleanSource(item.source)}</span>
          <span className="opacity-40">·</span>
          <span className="tick whitespace-nowrap">{ago}</span>
        </div>
      </button>

      {expanded && (
        <div className="card-expand border-t border-border/30 bg-card/40 px-4 py-3">
          <NewsExpanded item={item} compact />
        </div>
      )}
    </div>
  );
};
