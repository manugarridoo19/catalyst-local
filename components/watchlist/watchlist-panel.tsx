"use client";

import { useEffect, useMemo, useState } from "react";
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

// Refresh cadence. 60s — UX original. Tras mover el cron a GitHub Actions
// el path crítico de Vercel CPU es solo polling + SSR; con watchlist típica
// <10 símbolos esto es ~480 invocs/día/tab pero cada call es una function
// liviana que solo hace fetch a Finnhub + JSON.stringify (~50ms Active CPU).
// La cuota Finnhub (60/min) sigue siendo el cap real.
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
      if (document.visibilityState === "hidden") {
        // No quemamos cuota cuando el tab está oculto. Reintentamos cuando
        // vuelva a ser visible (visibilitychange handler abajo).
        return;
      }
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

    // Tick inicial solo si NO tenemos initial server-fetched data, para
    // evitar refetch innecesario inmediatamente tras el SSR.
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
    <aside className="flex w-72 flex-col border-l border-border/70 bg-card/30">
      <div className="flex items-center justify-between border-b border-border/70 px-5 py-2">
        <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-muted-foreground">
          Watchlist
        </div>
        <div className="flex items-center gap-2">
          {lastTick ? (
            <LastTick ts={lastTick} />
          ) : null}
          <span className="tick rounded-sm border border-border/60 bg-card/60 px-1.5 py-0.5 font-mono text-[10px] text-foreground">
            {items.length}
          </span>
        </div>
      </div>
      <div className="cat-scroll flex-1 overflow-y-auto">
        {items.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
            <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-muted-foreground">
              Empty
            </span>
            <p className="font-editorial text-sm italic text-muted-foreground/80">
              Pulsa{" "}
              <kbd className="rounded-sm border border-border bg-background/60 px-1 font-mono text-[10px] not-italic">
                ⌘K
              </kbd>{" "}
              para buscar y añadir tickers.
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
    <li className="border-b border-border/40 transition-colors hover:bg-foreground/[0.025]">
      <Link
        href={`/ticker/${item.symbol}`}
        className="flex items-center gap-3 px-5 py-3"
      >
        <TickerLogo symbol={item.symbol} logoUrl={item.logoUrl} size="sm" />
        <div className="min-w-0 flex-1">
          <div className="tick font-mono text-sm font-bold uppercase text-foreground transition-colors hover:text-primary">
            {item.symbol}
          </div>
          <div className="font-editorial truncate text-xs leading-tight text-muted-foreground">
            {item.name ?? "—"}
          </div>
        </div>
        <div className="flex flex-col items-end gap-0.5 font-mono">
          <span className="tick text-sm font-semibold tabular-nums text-foreground">
            {quote ? formatPrice(quote.price) : "—"}
          </span>
          <span className={cn("text-[11px] tabular-nums", tone)}>
            {dp != null ? `${sign}${dp.toFixed(2)}%` : "—"}
          </span>
        </div>
      </Link>
    </li>
  );
}

function formatPrice(p: number): string {
  // Cripto / OTC pueden tener precios <1; equities mayoría >$5. Dos
  // decimales son enough y consistentes con Bloomberg/Reuters.
  if (p >= 1000) return p.toFixed(0);
  if (p >= 100) return p.toFixed(2);
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
      className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground/70"
      title="Last quotes refresh"
    >
      {label}
    </span>
  );
}
