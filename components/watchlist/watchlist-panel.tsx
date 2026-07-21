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
  /** Pie del rail (server-rendered), p.ej. el calendario de earnings. */
  footer?: React.ReactNode;
};

// Refresh cadence. 60s — UX original.
const REFRESH_MS = 60_000;

export function WatchlistPanel({ items, initialQuotes = {}, footer }: Props) {
  const [quotes, setQuotes] = useState<QuotesMap>(initialQuotes);
  // null hasta el primer fetch del cliente — Date.now() en el initializer
  // sería una llamada impura durante render (regla del compilador de React).
  const [lastTick, setLastTick] = useState<number | null>(null);
  const symbolsKey = useMemo(
    () => items.map((it) => it.symbol).sort().join(","),
    [items],
  );

  useEffect(() => {
    // Sin símbolos no hay nada que refrescar. No reseteamos estado aquí
    // (setState síncrono en efecto): el stale queda oculto por derivación
    // en render — las rows se pintan por item y shownTick filtra el tick.
    if (!symbolsKey) return;
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
        // MERGE, nunca reemplazo: getQuotesMap devuelve null por símbolo
        // cuando Finnhub falla o ratelimita ese fetch concreto, y machacar
        // el mapa entero borraba de pantalla precios que ya teníamos (filas
        // en "—" hasta el siguiente tick bueno). El último valor conocido
        // es mejor que un hueco; el flash de la row ya comunica frescura.
        setQuotes((prev) => {
          const next = { ...prev };
          for (const [sym, q] of Object.entries(data.quotes)) {
            if (q) next[sym] = q;
            else if (!(sym in next)) next[sym] = null;
          }
          return next;
        });
        setLastTick(Date.now());
      } catch {
        // Silencioso — el último valor sigue visible.
      }
    }

    // Fetch inmediato también con initialQuotes del SSR: fija lastTick con
    // datos reales y /api/quotes lleva s-maxage=30, así que el hit
    // pos-hidratación suele salir de la CDN.
    fetchQuotes();

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
  }, [symbolsKey]);

  // Derivado: sin items no se muestra tick aunque quede estado stale.
  const shownTick = items.length ? lastTick : null;

  return (
    <aside className="flex w-72 flex-col border-l border-border/60 bg-card/30">
      <div className="sticky top-0 z-10 flex items-center justify-between border-b border-border/60 bg-card/55 px-5 py-2.5 backdrop-blur-md">
        <div className="eyebrow text-muted-foreground">Watchlist</div>
        <div className="flex items-center gap-2">
          {shownTick ? <LastTick ts={shownTick} /> : null}
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
      {footer}
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

  // Precio destructurado fuera del efecto: la dep es el primitivo exacto
  // que se lee, no el objeto `quote` (identidad nueva en cada refresh).
  const price = quote?.price ?? null;
  useEffect(() => {
    if (price == null) return;
    const prev = prevPrice.current;
    if (prev != null && prev !== price) {
      setFlash(price > prev ? "up" : "down");
      const id = setTimeout(() => setFlash(null), 1400);
      prevPrice.current = price;
      return () => clearTimeout(id);
    }
    prevPrice.current = price;
  }, [price]);

  const dp = quote?.changePercent ?? null;
  const tone =
    dp == null
      ? "text-muted-foreground"
      : dp > 0
        ? "text-emerald-700 dark:text-emerald-300"
        : dp < 0
          ? "text-rose-700 dark:text-rose-300"
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

// Locale-aware price formatter. Intl gives us proper thousands separators
// (1,234.56) and rounds to a sensible precision tier:
//   ≥10,000  →  0 decimals  (e.g. BRK-A 678,432)
//   ≥1,000   →  1 decimal   (avoids 1234.56 noise on four-digit prices)
//   <1,000   →  2 decimals  (standard equity quote)
//   <1       →  4 decimals  (sub-dollar tickers and OTC)
// Built with en-US so the layout stays consistent regardless of the
// browser locale; switching locale later means changing one constant.
const PRICE_FMT_BIG = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});
const PRICE_FMT_MID = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});
const PRICE_FMT_STD = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const PRICE_FMT_SUB = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 4,
  maximumFractionDigits: 4,
});

function formatPrice(p: number): string {
  if (p >= 10_000) return PRICE_FMT_BIG.format(p);
  if (p >= 1_000) return PRICE_FMT_MID.format(p);
  if (p >= 1) return PRICE_FMT_STD.format(p);
  return PRICE_FMT_SUB.format(p);
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
