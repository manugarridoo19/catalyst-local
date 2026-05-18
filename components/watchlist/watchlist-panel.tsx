"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { TickerLogo } from "@/components/ticker/ticker-logo";
import { cn } from "@/lib/utils";

export type WatchlistItem = {
  symbol: string;
  name: string | null;
  sector: string | null;
  logoUrl: string | null;
};

export type Quote = {
  price: number;
  change: number;
  changePercent: number;
  prevClose: number;
};

type QuotesMap = Record<string, Quote | null>;

type Props = {
  items: WatchlistItem[];
  initialQuotes?: QuotesMap;
};

// Refresh cadence. 60s — UX original.
const REFRESH_MS = 60_000;

export function WatchlistPanel({ items, initialQuotes = {} }: Props) {
  const [quotes, setQuotes] = useState<QuotesMap>(initialQuotes);
  const [lastTick, setLastTick] = useState<number | null>(
    Object.keys(initialQuotes).length ? Date.now() : null,
  );
  const symbolsKey = useMemo(
    () => items.map((it) => it.symbol).sort().join(","),
    [items],
  );

  useEffect(() => {
    if (!symbolsKey) {
      setQuotes({});
      setLastTick(null);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function fetchQuotes() {
      if (document.visibilityState === "hidden") return;
      try {
        const res = await fetch(`/api/quotes?symbols=${encodeURIComponent(symbolsKey)}`, {
          cache: "no-store",
        });
        if (!res.ok || cancelled) return;
        const data = (await res.json()) as { quotes: QuotesMap };
        if (cancelled) return;
        setQuotes(data.quotes);
        setLastTick(Date.now());
      } catch {
        // Silencioso — el último valor sigue visible.
      }
    }

    if (!Object.keys(initialQuotes).length) {
      fetchQuotes();
    }

    timer = setInterval(fetchQuotes, REFRESH_MS);
    const onVis = () => {
      if (document.visibilityState === "visible") fetchQuotes();
    };
    document.addEventListener("visibilitychange", onVis);

    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [symbolsKey, initialQuotes]);

  return (
    <aside className="flex w-72 flex-col border-l border-border/60 bg-card/30">
      <div className="sticky top-0 z-10 flex items-center justify-between border-b border-border/60 bg-card/55 px-5 py-2.5 backdrop-blur-md">
        <div className="eyebrow text-muted-foreground">Watchlist</div>
        <div className="flex items-center gap-2">
          {lastTick ? <LastTick ts={lastTick} /> : null}
          <span
            className="tick font-mono text-[11px] font-semibold tabular-nums text-foreground/80"
            aria-label={`${items.length} symbols`}
          >
            {items.length.toString().padStart(2, "0")}
          </span>
        </div>
      </div>
      <div className="cat-scroll flex-1 overflow-y-auto">
        {items.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
            <div className="eyebrow text-muted-foreground/60">Empty</div>
            <p className="font-editorial max-w-[18ch] text-[14px] leading-relaxed text-muted-foreground/85">
              Press{" "}
              <kbd className="rounded border border-border/60 bg-background/60 px-1.5 py-0.5 font-mono text-[10px] not-italic">
                ⌘K
              </kbd>{" "}
              to search and pin tickers.
            </p>
          </div>
        ) : (
          <ul>
            {items.map((it) => (
              <WatchlistRow
                key={it.symbol}
                item={it}
                quote={quotes[it.symbol] ?? null}
              />
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
}

function WatchlistRow({
  item,
  quote,
}: {
  item: WatchlistItem;
  quote: Quote | null;
}) {
  // Track previous price so we can flash the row briefly when it moves.
  // The flash is on the row background, not the digits, so the number
  // doesn't reflow or shimmer.
  const [flash, setFlash] = useState<"up" | "down" | null>(null);
  const prevPrice = useRef<number | null>(quote?.price ?? null);

  useEffect(() => {
    if (!quote) return;
    const prev = prevPrice.current;
    if (prev != null && prev !== quote.price) {
      setFlash(quote.price > prev ? "up" : "down");
      const id = setTimeout(() => setFlash(null), 1400);
      prevPrice.current = quote.price;
      return () => clearTimeout(id);
    }
    prevPrice.current = quote.price;
  }, [quote?.price]);

  const dp = quote?.changePercent ?? null;
  const tone =
    dp == null
      ? "text-muted-foreground"
      : dp > 0
        ? "text-emerald-300"
        : dp < 0
          ? "text-rose-300"
          : "text-muted-foreground";
  const sign = dp != null && dp > 0 ? "+" : "";

  return (
    <li
      className={cn(
        "border-b border-border/30 transition-colors duration-200 hover:bg-foreground/[0.025]",
        flash === "up" && "flash-up",
        flash === "down" && "flash-down",
      )}
    >
      <Link
        href={`/ticker/${item.symbol}`}
        className="grid grid-cols-[auto_1fr_auto] items-center gap-3 px-5 py-3"
      >
        <TickerLogo symbol={item.symbol} logoUrl={item.logoUrl} size="sm" />
        <div className="min-w-0">
          <div className="tick truncate font-mono text-[13px] font-bold uppercase leading-tight text-foreground transition-colors duration-150 hover:text-primary">
            {item.symbol}
          </div>
          <div className="font-editorial truncate text-[12px] leading-tight text-muted-foreground/85">
            {item.name ?? "—"}
          </div>
        </div>
        <div className="flex flex-col items-end gap-0.5 font-mono">
          <span className="tick text-[13px] font-semibold tabular-nums text-foreground">
            {quote ? formatPrice(quote.price) : "—"}
          </span>
          <span
            className={cn(
              "tick text-[11px] font-medium tabular-nums transition-colors duration-200",
              tone,
            )}
          >
            {dp != null ? `${sign}${dp.toFixed(2)}%` : "—"}
          </span>
        </div>
      </Link>
    </li>
  );
}

function formatPrice(p: number): string {
  if (p >= 1000) return p.toFixed(0);
  return p.toFixed(2);
}

function LastTick({ ts }: { ts: number }) {
  const [label, setLabel] = useState("now");
  useEffect(() => {
    const tick = () => {
      const sec = Math.floor((Date.now() - ts) / 1000);
      if (sec < 5) setLabel("now");
      else if (sec < 60) setLabel(`${sec}s`);
      else setLabel(`${Math.floor(sec / 60)}m`);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [ts]);
  return (
    <span
      className="eyebrow-sm text-muted-foreground/65"
      title="Last quotes refresh"
    >
      {label}
    </span>
  );
}
