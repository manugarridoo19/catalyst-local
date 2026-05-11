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

const FILTERS = [
  { id: "all" as const, label: "All" },
  { id: "watchlist" as const, label: "Watchlist" },
  { id: "high" as const, label: "High impact" },
  { id: "earnings" as const, label: "Earnings" },
  { id: "ma" as const, label: "M&A" },
  { id: "analyst" as const, label: "Analyst" },
  { id: "guidance" as const, label: "Guidance" },
];

type FilterId = (typeof FILTERS)[number]["id"];

export function FeedList({ initial, watchlist = [] }: Props) {
  const [items, setItems] = useState<FeedItem[]>(initial);
  const [freshIds, setFreshIds] = useState<Set<number>>(() => new Set());
  const [filter, setFilter] = useState<FilterId>("all");
  const [expandedId, setExpandedId] = useState<number | null>(null);

  useEffect(() => {
    const pusher = getPusherClient();
    if (!pusher) return;
    const channel = pusher.subscribe(NEWS_CHANNEL);
    const onNew = (data: LivePayload) => {
      // Detectamos cuáles items son GENUINAMENTE nuevos (no estaban antes)
      // para evitar re-spamear toast/animación cuando llega el segundo
      // broadcast (score-orphans rebroadcast con score). Usamos el
      // setItems callback para tener acceso al estado anterior.
      let actuallyNew: FeedItem[] = [];
      setItems((prev) => {
        const existingIds = new Set(prev.map((p) => p.id));
        actuallyNew = data.items.filter((it) => !existingIds.has(it.id));
        return mergeFeed(data.items, prev);
      });

      if (actuallyNew.length === 0) return;

      setFreshIds((prev) => {
        const next = new Set(prev);
        for (const it of actuallyNew) next.add(it.id);
        return next;
      });
      setTimeout(() => {
        setFreshIds((prev) => {
          const next = new Set(prev);
          for (const it of actuallyNew) next.delete(it.id);
          return next;
        });
      }, 2800);

      const hit = actuallyNew.find((it) =>
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
    if (filter === "earnings") return items.filter((it) => it.category === "EARNINGS");
    if (filter === "ma") return items.filter((it) => it.category === "MA");
    if (filter === "analyst") return items.filter((it) => it.category === "ANALYST");
    if (filter === "guidance") return items.filter((it) => it.category === "GUIDANCE");
    return items;
  }, [items, filter, watchlist]);

  return (
    <div className="flex h-full flex-col">
      {/* Toolbar */}
      <div className="flex items-center justify-between gap-4 border-b border-border/70 bg-card/30 px-5 py-2.5 backdrop-blur-sm">
        <div className="flex items-center gap-3">
          <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-muted-foreground">
            Live feed
          </div>
          <span className="tick rounded-sm border border-border/60 bg-card/60 px-1.5 py-0.5 font-mono text-[10px] text-foreground">
            {filtered.length}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-1 font-mono text-[11px]">
          {FILTERS.map((f) => (
            <FilterChip
              key={f.id}
              active={filter === f.id}
              disabled={f.id === "watchlist" && watchlist.length === 0}
              onClick={() => {
                setFilter(f.id);
                setExpandedId(null);
              }}
            >
              {f.label}
            </FilterChip>
          ))}
        </div>
      </div>

      {/* Cards */}
      <div className="cat-scroll flex-1 overflow-y-auto">
        {filtered.length === 0 ? (
          <EmptyState />
        ) : (
          filtered.map((it, idx) => (
            <NewsCard
              key={it.id}
              item={it}
              fresh={freshIds.has(it.id)}
              expanded={expandedId === it.id}
              onToggle={() =>
                setExpandedId((prev) => (prev === it.id ? null : it.id))
              }
              staggerIndex={Math.min(idx, 24)}
            />
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
        No matches for this filter
      </div>
      <p className="font-editorial max-w-sm text-base italic leading-relaxed text-muted-foreground/80">
        Cambia el filtro o espera a que entre la próxima ronda de news.
      </p>
    </div>
  );
}

// Upsert por id: items ya presentes se ACTUALIZAN con campos nuevos
// (típico: el primer broadcast llega sin score y el segundo trae score),
// los nuevos se insertan al inicio. Sin esto, un re-broadcast con score
// quedaba descartado y los badges Signif/Sent nunca aparecían.
function mergeFeed(incoming: FeedItem[], existing: FeedItem[]): FeedItem[] {
  const byId = new Map(existing.map((e) => [e.id, e] as const));
  const novel: FeedItem[] = [];
  for (const it of incoming) {
    const prev = byId.get(it.id);
    if (prev) {
      // Merge — preferimos los campos non-null del incoming (suelen ser el
      // score), pero mantenemos los del existing si el incoming los trae
      // null (evita borrar un score válido con un re-broadcast estale).
      byId.set(it.id, {
        ...prev,
        ...it,
        impact: it.impact ?? prev.impact,
        sentiment: it.sentiment ?? prev.sentiment,
        rationale: it.rationale ?? prev.rationale,
        category: it.category ?? prev.category,
      });
    } else {
      novel.push(it);
      byId.set(it.id, it);
    }
  }
  // Reconstruimos el orden: nuevos al inicio, luego los existentes en su
  // orden actual (con los updates aplicados).
  const updated = existing.map((e) => byId.get(e.id) ?? e);
  return [...novel, ...updated].slice(0, 500);
}
