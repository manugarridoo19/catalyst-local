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

type Props = {
  initial: FeedItem[];
  watchlist?: string[];
};

type LivePayload = { items: FeedItem[] };

export function FeedList({ initial, watchlist = [] }: Props) {
  const [items, setItems] = useState<FeedItem[]>(initial);
  const [filter, setFilter] = useState<"all" | "watchlist" | "high">("all");

  useEffect(() => {
    const pusher = getPusherClient();
    if (!pusher) return;
    const channel = pusher.subscribe(NEWS_CHANNEL);
    const onNew = (data: LivePayload) => {
      setItems((prev) => mergeFeed(data.items, prev));
      // Aviso solo si alguna noticia toca un ticker de la watchlist.
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
      <div className="flex items-center justify-between border-b border-border bg-card/50 px-4 py-2">
        <div className="font-mono text-xs uppercase tracking-widest text-muted-foreground">
          Live feed · {filtered.length}
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

      <div className="flex-1 overflow-y-auto">
        {filtered.length === 0 ? (
          <EmptyState />
        ) : (
          filtered.map((it) => <NewsCard key={it.id} item={it} />)
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
      className={`rounded border px-2 py-0.5 uppercase tracking-wide transition-colors ${
        active
          ? "border-amber-400/60 bg-amber-400/10 text-amber-200"
          : "border-border text-muted-foreground hover:text-foreground"
      } disabled:cursor-not-allowed disabled:opacity-40`}
    >
      {children}
    </button>
  );
}

function EmptyState() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center text-muted-foreground">
      <div className="font-mono text-xs uppercase tracking-widest">
        No hay noticias todavía
      </div>
      <p className="max-w-xs text-sm">
        El cron alimenta el feed cada minuto. Lanza{" "}
        <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">
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
