"use client";

import { useEffect, useMemo, useState } from "react";
import {
  getPusherClient,
  NEWS_CHANNEL,
  NEWS_EVENT,
} from "@/lib/pusher/client";
import type { FeedItem } from "@/lib/feed-types";
import { NewsCard } from "./news-card";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

type Props = {
  initial: FeedItem[];
  watchlist?: string[];
};

type LivePayload = { items: FeedItem[] };

export function FeedList({ initial, watchlist = [] }: Props) {
  const [items, setItems] = useState<FeedItem[]>(initial);
  const [freshIds, setFreshIds] = useState<Set<number>>(() => new Set());
  const [filter, setFilter] = useState<"all" | "watchlist" | "high">("all");

  useEffect(() => {
    const pusher = getPusherClient();
    if (!pusher) return;
    const channel = pusher.subscribe(NEWS_CHANNEL);
    const onNew = (data: LivePayload) => {
      setItems((prev) => mergeFeed(data.items, prev));
      // Marca como "fresh" durante el ciclo de la animación CSS.
      setFreshIds((prev) => {
        const next = new Set(prev);
        for (const it of data.items) next.add(it.id);
        return next;
      });
      setTimeout(() => {
        setFreshIds((prev) => {
          const next = new Set(prev);
          for (const it of data.items) next.delete(it.id);
          return next;
        });
      }, 2400);

      const hit = data.items.find((it) =>
        it.tickers.some((t) => watchlist.includes(t)),
      );
      if (hit) {
        toast.info(`${hit.tickers[0] ?? "MKT"} · ${hit.headline}`, {
          description: hit.rationale ?? undefined,
        });
      }
    };
    channel.bind(NEWS_EVENT, onNew);
    return () => {
      channel.unbind(NEWS_EVENT, onNew);
      pusher.unsubscribe(NEWS_CHANNEL);
    };
  }, [watchlist]);

  const filtered = useMemo(() => {
    if (filter === "watchlist" && watchlist.length) {
      const set = new Set(watchlist);
      return items.filter((it) => it.tickers.some((t) => set.has(t)));
    }
    if (filter === "high") {
      return items.filter((it) => (it.impact ?? 0) >= 4);
    }
    return items;
  }, [items, filter, watchlist]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-border/70 bg-card/30 px-5 py-2">
        <div className="flex items-center gap-3">
          <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-muted-foreground">
            Live feed
          </div>
          <span className="tick rounded-sm border border-border/60 bg-card/60 px-1.5 py-0.5 font-mono text-[10px] text-foreground">
            {filtered.length}
          </span>
        </div>
        <div className="flex items-center gap-1 font-mono text-[11px]">
          <FilterChip active={filter === "all"} onClick={() => setFilter("all")}>
            All
          </FilterChip>
          <FilterChip
            active={filter === "watchlist"}
            disabled={!watchlist.length}
            onClick={() => setFilter("watchlist")}
          >
            Watchlist
          </FilterChip>
          <FilterChip
            active={filter === "high"}
            onClick={() => setFilter("high")}
          >
            High impact
          </FilterChip>
        </div>
      </div>

      <div className="cat-scroll flex-1 overflow-y-auto">
        {filtered.length === 0 ? (
          <EmptyState />
        ) : (
          filtered.map((it) => (
            <NewsCard key={it.id} item={it} fresh={freshIds.has(it.id)} />
          ))
        )}
      </div>
    </div>
  );
}

function FilterChip({
  active,
  disabled,
  onClick,
  children,
}: {
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "rounded-sm border px-2 py-0.5 uppercase tracking-[0.18em] transition-all duration-150",
        active
          ? "border-primary/60 bg-primary/10 text-primary shadow-[0_0_14px_oklch(0.78_0.13_75/0.25)]"
          : "border-border/70 text-muted-foreground hover:border-foreground/30 hover:text-foreground",
        "disabled:cursor-not-allowed disabled:opacity-40",
      )}
    >
      {children}
    </button>
  );
}

function EmptyState() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-10 text-center">
      <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-muted-foreground">
        Awaiting first signal
      </div>
      <p className="font-editorial max-w-sm text-base italic leading-relaxed text-muted-foreground/80">
        El cron alimenta este feed cada cinco minutos en producción.
        Lanza{" "}
        <code className="rounded-sm bg-card px-1.5 py-0.5 font-mono text-xs not-italic text-foreground">
          pnpm cron:local
        </code>{" "}
        para forzar la primera carga.
      </p>
    </div>
  );
}

function mergeFeed(incoming: FeedItem[], existing: FeedItem[]): FeedItem[] {
  const seen = new Set(existing.map((e) => e.id));
  const novel = incoming.filter((it) => !seen.has(it.id));
  return [...novel, ...existing].slice(0, 500);
}
