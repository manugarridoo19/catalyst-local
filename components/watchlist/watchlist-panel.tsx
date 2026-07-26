"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Pencil } from "lucide-react";
import { TickerLogo } from "@/components/ticker/ticker-logo";
import { buildPortfolio, type PricedPosition } from "@/lib/portfolio";
import { cn } from "@/lib/utils";

export type WatchlistItem = {
  symbol: string;
  name: string | null;
  sector: string | null;
  logoUrl: string | null;
  /** NULL = solo seguimiento · 0 = cerrada · >0 = posición viva. */
  shares?: number | null;
  avgCost?: number | null;
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

export function WatchlistPanel({ items: initialItems, initialQuotes = {}, footer }: Props) {
  const [quotes, setQuotes] = useState<QuotesMap>(initialQuotes);
  // Las filas son estado local porque el PATCH de una posición devuelve la
  // lista entera: así el peso de TODAS las demás se recalcula al instante
  // (cambiar una posición cambia el denominador) sin recargar la página.
  const [items, setItems] = useState<WatchlistItem[]>(initialItems);
  const [editing, setEditing] = useState<string | null>(null);

  // Sincronizar con el servidor SÓLO cuando cambia el CONJUNTO de símbolos
  // (alta o baja desde ⌘K). Si dependiera del array entero, un re-render
  // del padre con el payload original revertiría la posición recién
  // guardada.
  //
  // Ajuste en fase de render y no en un efecto: es el patrón que React
  // documenta para "resetear estado cuando cambia una prop". Con useEffect
  // habría un frame pintado con la lista vieja y una cascada de renders
  // (que es justo lo que marca react-hooks/set-state-in-effect).
  const serverKey = initialItems.map((i) => i.symbol).join(",");
  const [syncedKey, setSyncedKey] = useState(serverKey);
  if (syncedKey !== serverKey) {
    setSyncedKey(serverKey);
    setItems(initialItems);
  }
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

  // MISMA función que usa la revisión de cartera del /ask. Si el rail
  // calculara sus pesos por su cuenta, tarde o temprano la pantalla y la
  // revisión dirían cosas distintas sobre la misma posición.
  const portfolio = useMemo(
    () =>
      buildPortfolio(
        items.map((i) => ({
          symbol: i.symbol,
          name: i.name,
          sector: i.sector,
          shares: i.shares ?? null,
          avgCost: i.avgCost ?? null,
        })),
        quotes,
      ),
    [items, quotes],
  );
  const bySymbol = useMemo(
    () => new Map(portfolio.positions.map((p) => [p.symbol, p])),
    [portfolio],
  );

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
      {portfolio.positions.length ? (
        <div className="flex items-baseline justify-between border-b border-border/40 px-5 py-1.5 font-mono text-[10.5px]">
          <span className="tabular-nums text-foreground/80">
            {formatPrice(portfolio.totalValue)}
          </span>
          <div className="flex items-center gap-2 tabular-nums">
            {portfolio.totalUnrealizedPct !== null ? (
              <span className={pnlTone(portfolio.totalUnrealizedPct)}>
                {signed(portfolio.totalUnrealizedPct)}
              </span>
            ) : null}
            {portfolio.dayChangePct !== null ? (
              <span
                className={cn("text-[10px]", pnlTone(portfolio.dayChangePct))}
                title="Movimiento de hoy ponderado por peso"
              >
                hoy {signed(portfolio.dayChangePct)}
              </span>
            ) : null}
          </div>
        </div>
      ) : null}
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
                position={bySymbol.get(it.symbol) ?? null}
                editing={editing === it.symbol}
                onToggleEdit={() =>
                  setEditing((cur) => (cur === it.symbol ? null : it.symbol))
                }
                onSaved={(next) => {
                  setItems(next);
                  setEditing(null);
                }}
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
  position,
  editing,
  onToggleEdit,
  onSaved,
}: {
  item: WatchlistItem;
  quote: Quote | null;
  position: PricedPosition | null;
  editing: boolean;
  onToggleEdit: () => void;
  onSaved: (items: WatchlistItem[]) => void;
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
        "group relative border-b border-border/30 transition-colors duration-200 hover:bg-foreground/[0.025]",
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
          {/* Peso y P&L sólo cuando hay posición. Una watchlist de puro
              seguimiento debe seguir viéndose exactamente igual que antes
              de que existiera la cartera. */}
          {position ? (
            <div className="mt-0.5 flex items-center gap-1.5 font-mono text-[10px] tabular-nums">
              <span className="text-muted-foreground/70">
                {position.weightPct?.toFixed(1) ?? "—"}%
              </span>
              {position.unrealizedPct !== null ? (
                <span className={pnlTone(position.unrealizedPct)}>
                  {signed(position.unrealizedPct)}
                </span>
              ) : (
                <span className="text-muted-foreground/40">sin coste</span>
              )}
            </div>
          ) : null}
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

      {/* Fuera del <Link>: un botón anidado dentro de un ancla es inválido
          y el clic navegaría en vez de abrir el editor. */}
      <button
        type="button"
        onClick={onToggleEdit}
        aria-label={`Editar posición de ${item.symbol}`}
        className={cn(
          "absolute right-1 top-1 rounded-sm p-1 text-muted-foreground/40 opacity-0 transition-opacity hover:text-primary focus-visible:opacity-100 group-hover:opacity-100",
          editing && "opacity-100 text-primary",
        )}
      >
        <Pencil className="h-3 w-3" />
      </button>

      {editing ? (
        <PositionEditor item={item} onSaved={onSaved} onCancel={onToggleEdit} />
      ) : null}
    </li>
  );
}

/** Editor inline de una posición. Guarda con PATCH /api/watchlist, que
 *  devuelve la watchlist entera — necesario porque tocar una posición
 *  recalcula el peso de todas las demás. */
function PositionEditor({
  item,
  onSaved,
  onCancel,
}: {
  item: WatchlistItem;
  onSaved: (items: WatchlistItem[]) => void;
  onCancel: () => void;
}) {
  const [shares, setShares] = useState(item.shares?.toString() ?? "");
  const [cost, setCost] = useState(item.avgCost?.toString() ?? "");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function save() {
    if (saving) return;
    // Campo vacío = borrar el dato, no cero. Es la diferencia entre "ya no
    // registro esta posición" y "tengo 0 acciones", que el esquema
    // distingue a propósito.
    const s = shares.trim() === "" ? null : Number(shares.replace(",", "."));
    const c = cost.trim() === "" ? null : Number(cost.replace(",", "."));
    if ((s !== null && !Number.isFinite(s)) || (c !== null && !Number.isFinite(c))) {
      setErr("Números no válidos");
      return;
    }
    setSaving(true);
    setErr(null);
    try {
      const r = await fetch("/api/watchlist", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol: item.symbol, shares: s, avgCost: c }),
      });
      if (!r.ok) {
        setErr("No se pudo guardar");
        return;
      }
      const data = (await r.json()) as { items: WatchlistItem[] };
      onSaved(data.items);
    } catch {
      setErr("Error de red");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="border-t border-border/30 bg-background/40 px-5 py-2">
      <div className="flex items-center gap-1.5">
        <input
          value={shares}
          onChange={(e) => setShares(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void save();
            if (e.key === "Escape") onCancel();
          }}
          inputMode="decimal"
          placeholder="acciones"
          aria-label="Número de acciones"
          autoFocus
          className="w-full min-w-0 rounded-sm border border-border/60 bg-transparent px-1.5 py-1 font-mono text-[11px] tabular-nums outline-none focus:border-primary/50"
        />
        <input
          value={cost}
          onChange={(e) => setCost(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void save();
            if (e.key === "Escape") onCancel();
          }}
          inputMode="decimal"
          placeholder="coste medio"
          aria-label="Coste medio por acción"
          className="w-full min-w-0 rounded-sm border border-border/60 bg-transparent px-1.5 py-1 font-mono text-[11px] tabular-nums outline-none focus:border-primary/50"
        />
        <button
          type="button"
          onClick={() => void save()}
          disabled={saving}
          className="shrink-0 rounded-sm border border-border/60 px-1.5 py-1 font-mono text-[9px] uppercase tracking-[0.14em] text-muted-foreground hover:border-primary/50 hover:text-primary disabled:opacity-40"
        >
          {saving ? "…" : "OK"}
        </button>
      </div>
      {err ? (
        <p className="mt-1 font-mono text-[9.5px] text-rose-700 dark:text-rose-300">
          {err}
        </p>
      ) : (
        <p className="mt-1 font-mono text-[9px] text-muted-foreground/45">
          vacío = quitar · Esc cancela
        </p>
      )}
    </div>
  );
}

function pnlTone(n: number): string {
  if (n > 0) return "text-emerald-700 dark:text-emerald-300";
  if (n < 0) return "text-rose-700 dark:text-rose-300";
  return "text-muted-foreground";
}

function signed(n: number): string {
  return `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`;
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
