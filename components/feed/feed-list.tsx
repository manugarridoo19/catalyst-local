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
import {
  LIVE_FEED_CATEGORIES,
  NEWS_TAB_CATEGORIES,
  type NewsCategory,
} from "@/lib/categorizer";

type Mode = "live" | "news";

type Props = {
  initial: FeedItem[];
  watchlist?: string[];
  mode?: Mode;
};

type LivePayload = { items: FeedItem[] };

const LIVE_FILTERS = [
  { id: "all" as const, label: "All" },
  { id: "watchlist" as const, label: "Watchlist" },
  { id: "high" as const, label: "High impact" },
  { id: "earnings" as const, label: "Earnings" },
  { id: "ma" as const, label: "M&A" },
  { id: "analyst" as const, label: "Analyst" },
  { id: "guidance" as const, label: "Guidance" },
];

const NEWS_FILTERS = [
  { id: "all" as const, label: "All" },
  { id: "watchlist" as const, label: "Watchlist" },
  { id: "macro" as const, label: "Macro" },
  { id: "other" as const, label: "Other" },
];

type FilterId =
  | (typeof LIVE_FILTERS)[number]["id"]
  | (typeof NEWS_FILTERS)[number]["id"];

export function FeedList({ initial, watchlist = [], mode = "live" }: Props) {
  const [items, setItems] = useState<FeedItem[]>(initial);
  const [freshIds, setFreshIds] = useState<Set<number>>(() => new Set());
  const [filter, setFilter] = useState<FilterId>("all");
  const [expandedId, setExpandedId] = useState<number | null>(null);

  // Set de categorías permitidas en esta vista. Aplicado tanto al state
  // inicial (server ya filtra, pero por defensa) como a cada broadcast
  // entrante por Pusher — el cron publica a un solo canal y cada tab
  // descarta lo que no le toca.
  const allowedCategories = useMemo<Set<string>>(
    () =>
      new Set(
        (mode === "news"
          ? (NEWS_TAB_CATEGORIES as string[])
          : (LIVE_FEED_CATEGORIES as string[])),
      ),
    [mode],
  );

  const matchesCategory = (it: FeedItem): boolean => {
    if (mode === "news") {
      // News tab acepta MACRO, OTHER y items sin categoría conocida.
      return it.category == null || allowedCategories.has(it.category);
    }
    return it.category != null && allowedCategories.has(it.category);
  };

  useEffect(() => {
    const pusher = getPusherClient();
    if (!pusher) return;
    const channel = pusher.subscribe(NEWS_CHANNEL);
    const onNew = (data: LivePayload) => {
      // Live feed = solo today (UTC); News tab = 15 días.
      const cutoff =
        mode === "news"
          ? Date.now() - 15 * 24 * 3600 * 1000
          : Date.UTC(
              new Date().getUTCFullYear(),
              new Date().getUTCMonth(),
              new Date().getUTCDate(),
            );
      const inWindow = data.items.filter(
        (it) =>
          new Date(it.publishedAt).getTime() >= cutoff &&
          matchesCategory(it) &&
          // Ambos modos requireTicker=true en SSR; aplicamos el mismo
          // filtro al broadcast para que los rebroadcasts de items sin
          // ticker (FT/Yahoo company announcements sin alias) no se
          // cuelen en el feed via realtime.
          it.tickers.length > 0,
      );
      if (!inWindow.length) return;

      // Detectamos cuáles items son GENUINAMENTE nuevos (no estaban antes)
      // para evitar re-spamear toast/animación cuando llega el segundo
      // broadcast (score-orphans rebroadcast con score). Usamos el
      // setItems callback para tener acceso al estado anterior.
      let actuallyNew: FeedItem[] = [];
      setItems((prev) => {
        const existingIds = new Set(prev.map((p) => p.id));
        actuallyNew = inWindow.filter((it) => !existingIds.has(it.id));
        return mergeFeed(inWindow, prev);
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
  }, [watchlist, mode]);

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
    if (filter === "macro") return items.filter((it) => it.category === "MACRO");
    if (filter === "other")
      return items.filter((it) => it.category === "OTHER" || it.category == null);
    return items;
  }, [items, filter, watchlist]);

  const filters = mode === "news" ? NEWS_FILTERS : LIVE_FILTERS;
  const toolbarLabel = mode === "news" ? "News" : "Live feed";

  return (
    <div className="flex h-full flex-col">
      {/* Toolbar */}
      <div className="flex items-center justify-between gap-4 border-b border-border/70 bg-card/30 px-5 py-2.5 backdrop-blur-sm">
        <div className="flex items-center gap-3">
          <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-muted-foreground">
            {toolbarLabel}
          </div>
          <span className="tick rounded-sm border border-border/60 bg-card/60 px-1.5 py-0.5 font-mono text-[10px] text-foreground">
            {filtered.length}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-1 font-mono text-[11px]">
          {filters.map((f) => (
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
