"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Loader2, Pencil, Plus, X } from "lucide-react";
import {
  buildPortfolio,
  sharesFromAmount,
  type PricedPosition,
  type QuoteLike,
} from "@/lib/portfolio";
import { cn } from "@/lib/utils";

// Tabla de cartera. Toda la aritmética sale de `buildPortfolio`, la MISMA
// función que alimenta el rail y la revisión de /ask: si esta tabla hiciera
// sus propias cuentas, tarde o temprano diría un peso distinto del que el
// modelo cita como hecho, y ése es el tipo de discrepancia que hace que
// dejes de fiarte del tablero entero.

export type PortfolioItem = {
  symbol: string;
  name: string | null;
  sector: string | null;
  logoUrl: string | null;
  shares: number | null;
  avgCost: number | null;
};

type QuotesMap = Record<string, QuoteLike>;

const REFRESH_MS = 60_000;

/** Columna por la que se ordena. "hoy" es el que más se usa para la
 *  pregunta de "¿cómo va la cartera hoy?", pero el orden por defecto es
 *  el peso: es el que explica cuánto importa cada fila. */
type SortKey = "weight" | "today" | "pnl" | "symbol";

export function PortfolioTable({
  initialItems,
  initialQuotes,
}: {
  initialItems: PortfolioItem[];
  initialQuotes: QuotesMap;
}) {
  const [items, setItems] = useState(initialItems);
  const [quotes, setQuotes] = useState<QuotesMap>(initialQuotes);
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [sort, setSort] = useState<SortKey>("weight");

  const symbolsKey = useMemo(
    () => items.map((i) => i.symbol).sort().join(","),
    [items],
  );

  useEffect(() => {
    if (!symbolsKey) return;
    let cancelled = false;
    async function fetchQuotes() {
      if (document.visibilityState === "hidden") return;
      try {
        const r = await fetch(`/api/quotes?symbols=${encodeURIComponent(symbolsKey)}`, {
          cache: "no-store",
        });
        if (!r.ok || cancelled) return;
        const data = (await r.json()) as { quotes: QuotesMap };
        if (cancelled) return;
        // MERGE, nunca reemplazo: un null transitorio de Finnhub no debe
        // borrar de pantalla un precio que ya teníamos (misma lección que
        // el rail — ver watchlist-panel.tsx).
        setQuotes((prev) => {
          const next = { ...prev };
          for (const [sym, q] of Object.entries(data.quotes)) {
            if (q) next[sym] = q;
            else if (!(sym in next)) next[sym] = null;
          }
          return next;
        });
      } catch {
        // Silencioso: el último valor conocido sigue en pantalla.
      }
    }
    fetchQuotes();
    const timer = setInterval(fetchQuotes, REFRESH_MS);
    const onVis = () => {
      if (document.visibilityState === "visible") fetchQuotes();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [symbolsKey]);

  const portfolio = useMemo(
    () =>
      buildPortfolio(
        items.map((i) => ({
          symbol: i.symbol,
          name: i.name,
          sector: i.sector,
          shares: i.shares,
          avgCost: i.avgCost,
        })),
        quotes,
      ),
    [items, quotes],
  );

  const sorted = useMemo(() => {
    const rows = [...portfolio.positions];
    const num = (v: number | null) => (v === null ? -Infinity : v);
    switch (sort) {
      case "today":
        return rows.sort((a, b) => num(b.dayChangeAbs) - num(a.dayChangeAbs));
      case "pnl":
        return rows.sort((a, b) => num(b.unrealizedAbs) - num(a.unrealizedAbs));
      case "symbol":
        return rows.sort((a, b) => a.symbol.localeCompare(b.symbol));
      default:
        return rows.sort((a, b) => num(b.weightPct) - num(a.weightPct));
    }
  }, [portfolio.positions, sort]);

  const bySymbol = useMemo(
    () => new Map(items.map((i) => [i.symbol, i])),
    [items],
  );
  const watchOnly = items.filter((i) => i.shares === null);

  return (
    <div className="flex flex-col gap-5">
      <Totals p={portfolio} />

      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-1.5">
          <span className="font-mono text-[9.5px] uppercase tracking-[0.14em] text-muted-foreground/50">
            ordenar
          </span>
          {(
            [
              ["weight", "peso"],
              ["today", "hoy"],
              ["pnl", "P&L"],
              ["symbol", "A-Z"],
            ] as Array<[SortKey, string]>
          ).map(([k, label]) => (
            <button
              key={k}
              type="button"
              onClick={() => setSort(k)}
              className={cn(
                "rounded-sm border px-1.5 py-0.5 font-mono text-[10px] transition-colors",
                sort === k
                  ? "border-primary/50 text-primary"
                  : "border-border/40 text-muted-foreground/70 hover:text-foreground",
              )}
            >
              {label}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={() => setAdding((v) => !v)}
          className="flex items-center gap-1.5 rounded-sm border border-border/60 px-2 py-1 font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground transition-colors hover:border-primary/50 hover:text-primary"
        >
          {adding ? <X className="h-3 w-3" /> : <Plus className="h-3 w-3" />}
          {adding ? "cancelar" : "añadir"}
        </button>
      </div>

      {adding ? (
        <AddPosition
          onAdded={(next, symbol) => {
            setItems(next);
            setAdding(false);
            setEditing(symbol);
          }}
        />
      ) : null}

      {portfolio.positions.length === 0 ? (
        <div className="rounded-sm border border-border/60 bg-card/40 px-4 py-8 text-center">
          <p className="font-editorial text-[13px] text-muted-foreground">
            Aún no has registrado ninguna posición.
          </p>
          <p className="mx-auto mt-1 max-w-[46ch] font-mono text-[10.5px] leading-relaxed text-muted-foreground/60">
            Pulsa «añadir» para registrar un valor, o edita uno de los que ya
            sigues abajo. Puedes meter el número de acciones o el importe que
            invertiste: con el precio de entrada, lo uno sale de lo otro.
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[860px] border-collapse font-mono text-[11.5px]">
            <thead>
              <tr className="border-b border-border/60 text-left">
                <Th className="w-[150px]">valor</Th>
                <Th align="right">acciones</Th>
                <Th align="right">entrada</Th>
                <Th align="right">precio</Th>
                <Th align="right">hoy</Th>
                <Th align="right">hoy $</Th>
                <Th align="right">invertido</Th>
                <Th align="right">valor actual</Th>
                <Th align="right">P&amp;L</Th>
                <Th align="right">peso</Th>
                <Th align="right" className="w-8" />
              </tr>
            </thead>
            <tbody>
              {sorted.map((pos) => (
                <Row
                  key={pos.symbol}
                  pos={pos}
                  item={bySymbol.get(pos.symbol)}
                  editing={editing === pos.symbol}
                  price={quotes[pos.symbol]?.price ?? null}
                  onToggleEdit={() =>
                    setEditing((cur) => (cur === pos.symbol ? null : pos.symbol))
                  }
                  onSaved={(next) => {
                    setItems(next);
                    setEditing(null);
                  }}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {watchOnly.length ? (
        <section>
          <h2 className="eyebrow mb-2 text-[10px] text-foreground">
            Solo seguimiento
          </h2>
          <p className="mb-2 font-mono text-[10px] text-muted-foreground/60">
            Los sigues pero no los tienes. No entran en pesos, ni en P&amp;L, ni
            en la revisión de cartera.
          </p>
          <ul className="flex flex-wrap gap-1.5">
            {watchOnly.map((i) => (
              <li key={i.symbol}>
                <button
                  type="button"
                  onClick={() => setEditing(i.symbol)}
                  className={cn(
                    "rounded-sm border px-2 py-1 font-mono text-[11px] transition-colors",
                    editing === i.symbol
                      ? "border-primary/50 text-primary"
                      : "border-border/40 text-muted-foreground hover:border-primary/40 hover:text-primary",
                  )}
                >
                  {i.symbol}
                </button>
              </li>
            ))}
          </ul>
          {watchOnly.some((i) => i.symbol === editing) ? (
            <div className="mt-2 max-w-lg">
              <PositionEditor
                item={bySymbol.get(editing!)!}
                price={quotes[editing!]?.price ?? null}
                onSaved={(next) => {
                  setItems(next);
                  setEditing(null);
                }}
                onCancel={() => setEditing(null)}
              />
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────

function Totals({ p }: { p: ReturnType<typeof buildPortfolio> }) {
  return (
    <div className="grid grid-cols-2 gap-px overflow-hidden rounded-sm border border-border/60 bg-border/40 sm:grid-cols-4">
      <Stat label="valor de la cartera" value={money(p.totalValue)} />
      <Stat
        label="hoy"
        value={p.dayChangeAbs !== null ? signedMoney(p.dayChangeAbs) : "—"}
        sub={p.dayChangePct !== null ? signedPct(p.dayChangePct) : undefined}
        tone={p.dayChangeAbs}
      />
      <Stat
        label="P&L no realizado"
        value={p.totalUnrealizedAbs !== null ? signedMoney(p.totalUnrealizedAbs) : "—"}
        sub={p.totalUnrealizedPct !== null ? signedPct(p.totalUnrealizedPct) : undefined}
        tone={p.totalUnrealizedAbs}
      />
      <Stat label="invertido" value={p.totalCost ? money(p.totalCost) : "—"} />
    </div>
  );
}

function Stat({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: number | null;
}) {
  return (
    <div className="bg-card/40 px-3 py-2.5">
      <div className="font-mono text-[9px] uppercase tracking-[0.14em] text-muted-foreground/55">
        {label}
      </div>
      <div
        className={cn(
          "mt-0.5 font-mono text-[15px] font-semibold tabular-nums",
          tone === undefined ? "text-foreground" : toneClass(tone ?? null),
        )}
      >
        {value}
      </div>
      {sub ? (
        <div
          className={cn(
            "font-mono text-[10.5px] tabular-nums",
            tone === undefined ? "text-muted-foreground" : toneClass(tone ?? null),
          )}
        >
          {sub}
        </div>
      ) : null}
    </div>
  );
}

function Th({
  children,
  align = "left",
  className,
}: {
  children?: React.ReactNode;
  align?: "left" | "right";
  className?: string;
}) {
  return (
    <th
      className={cn(
        "px-2 py-1.5 font-mono text-[9px] font-normal uppercase tracking-[0.14em] text-muted-foreground/55",
        align === "right" && "text-right",
        className,
      )}
    >
      {children}
    </th>
  );
}

function Row({
  pos,
  item,
  editing,
  price,
  onToggleEdit,
  onSaved,
}: {
  pos: PricedPosition;
  item: PortfolioItem | undefined;
  editing: boolean;
  price: number | null;
  onToggleEdit: () => void;
  onSaved: (items: PortfolioItem[]) => void;
}) {
  return (
    <>
      <tr className="border-b border-border/25 hover:bg-foreground/[0.02]">
        <td className="px-2 py-2">
          <Link
            href={`/ticker/${pos.symbol}`}
            className="font-bold text-foreground hover:text-primary"
          >
            {pos.symbol}
          </Link>
          <div className="truncate font-editorial text-[11px] leading-tight text-muted-foreground/70">
            {pos.name ?? pos.sector ?? "—"}
          </div>
        </td>
        <Td>{fmtShares(pos.shares)}</Td>
        <Td>{pos.avgCost !== null ? money(pos.avgCost) : "—"}</Td>
        <Td>{pos.price !== null ? money(pos.price) : "—"}</Td>
        <Td tone={pos.dayChangePct}>
          {pos.dayChangePct !== null ? signedPct(pos.dayChangePct) : "—"}
        </Td>
        <Td tone={pos.dayChangeAbs}>
          {pos.dayChangeAbs !== null ? signedMoney(pos.dayChangeAbs) : "—"}
        </Td>
        <Td>{pos.costBasis !== null ? money(pos.costBasis) : "—"}</Td>
        <Td>{pos.marketValue !== null ? money(pos.marketValue) : "—"}</Td>
        <Td tone={pos.unrealizedAbs}>
          {pos.unrealizedAbs !== null ? (
            <>
              {signedMoney(pos.unrealizedAbs)}
              <span className="ml-1 text-[10px] opacity-70">
                {pos.unrealizedPct !== null ? signedPct(pos.unrealizedPct) : ""}
              </span>
            </>
          ) : (
            <span className="text-muted-foreground/40">sin coste</span>
          )}
        </Td>
        <Td>{pos.weightPct !== null ? `${pos.weightPct.toFixed(1)}%` : "—"}</Td>
        <td className="px-2 py-2 text-right">
          <button
            type="button"
            onClick={onToggleEdit}
            aria-label={`Editar posición de ${pos.symbol}`}
            className={cn(
              "rounded-sm p-1 text-muted-foreground/40 transition-colors hover:text-primary",
              editing && "text-primary",
            )}
          >
            <Pencil className="h-3 w-3" />
          </button>
        </td>
      </tr>
      {editing && item ? (
        <tr>
          <td colSpan={11} className="px-2 pb-3">
            <PositionEditor
              item={item}
              price={price}
              onSaved={onSaved}
              onCancel={onToggleEdit}
            />
          </td>
        </tr>
      ) : null}
    </>
  );
}

function Td({
  children,
  tone,
}: {
  children: React.ReactNode;
  tone?: number | null;
}) {
  return (
    <td
      className={cn(
        "px-2 py-2 text-right tabular-nums",
        tone === undefined ? "text-foreground/85" : toneClass(tone ?? null),
      )}
    >
      {children}
    </td>
  );
}

// ─────────────────────────────────────────────────────────────────────────

/**
 * Editor de posición con DOS modos de entrada.
 *
 * El modo "importe" existe porque casi nadie recuerda su posición en número
 * de acciones: se recuerda como "metí 500 a 120". Se convierte a acciones
 * al guardar (`sharesFromAmount`) porque el esquema guarda `shares` +
 * `avg_cost` como forma canónica — de ahí salen el valor de mercado y el
 * P&L, y una cantidad invertida sola no permite calcular ninguno de los
 * dos cuando el precio se mueve.
 */
function PositionEditor({
  item,
  price,
  onSaved,
  onCancel,
}: {
  item: PortfolioItem;
  price: number | null;
  onSaved: (items: PortfolioItem[]) => void;
  onCancel: () => void;
}) {
  const [mode, setMode] = useState<"shares" | "amount">(
    item.shares === null ? "amount" : "shares",
  );
  const [shares, setShares] = useState(item.shares?.toString() ?? "");
  const [amount, setAmount] = useState(
    item.shares !== null && item.avgCost !== null
      ? (item.shares * item.avgCost).toFixed(2)
      : "",
  );
  const [cost, setCost] = useState(item.avgCost?.toString() ?? "");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const parsedCost = num(cost);
  const parsedAmount = num(amount);
  const derivedShares =
    mode === "amount" && parsedAmount !== null && parsedCost !== null
      ? sharesFromAmount(parsedAmount, parsedCost)
      : null;
  const effectiveShares = mode === "shares" ? num(shares) : derivedShares;

  async function save(clear = false) {
    if (saving) return;
    let s: number | null = null;
    let c: number | null = null;
    if (!clear) {
      c = parsedCost;
      if (mode === "amount") {
        if (parsedAmount !== null && c === null) {
          setErr("Con el importe hace falta el precio de entrada");
          return;
        }
        s = derivedShares;
      } else {
        s = num(shares);
      }
      if (s === null && c === null) {
        setErr("Introduce al menos acciones o importe");
        return;
      }
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
      const data = (await r.json()) as { items: PortfolioItem[] };
      onSaved(data.items);
    } catch {
      setErr("Error de red");
    } finally {
      setSaving(false);
    }
  }

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") void save();
    if (e.key === "Escape") onCancel();
  };

  return (
    <div className="rounded-sm border border-border/60 bg-background/50 px-3 py-2.5">
      <div className="mb-2 flex items-center gap-1.5">
        <span className="font-mono text-[9.5px] uppercase tracking-[0.14em] text-muted-foreground/50">
          {item.symbol} · registrar por
        </span>
        {(
          [
            ["shares", "acciones"],
            ["amount", "importe"],
          ] as Array<["shares" | "amount", string]>
        ).map(([k, label]) => (
          <button
            key={k}
            type="button"
            onClick={() => setMode(k)}
            className={cn(
              "rounded-sm border px-1.5 py-0.5 font-mono text-[10px] transition-colors",
              mode === k
                ? "border-primary/50 text-primary"
                : "border-border/40 text-muted-foreground/70 hover:text-foreground",
            )}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {mode === "shares" ? (
          <Field
            label="acciones"
            value={shares}
            onChange={setShares}
            onKeyDown={onKey}
            autoFocus
          />
        ) : (
          <Field
            label="importe invertido"
            value={amount}
            onChange={setAmount}
            onKeyDown={onKey}
            autoFocus
          />
        )}
        <Field
          label="precio de entrada"
          value={cost}
          onChange={setCost}
          onKeyDown={onKey}
        />
        <button
          type="button"
          onClick={() => void save()}
          disabled={saving}
          className="rounded-sm border border-primary/50 px-2.5 py-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-primary transition-colors hover:bg-primary/10 disabled:opacity-40"
        >
          {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : "guardar"}
        </button>
        <button
          type="button"
          onClick={() => void save(true)}
          disabled={saving}
          className="rounded-sm border border-border/50 px-2.5 py-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground transition-colors hover:border-rose-600/40 hover:text-rose-700 disabled:opacity-40 dark:hover:text-rose-300"
          title="Quitar la posición y dejarlo solo en seguimiento"
        >
          quitar
        </button>
      </div>

      {/* Previsualización en vivo: con el modo importe, ver las acciones
          que salen es la única forma de detectar que te has equivocado de
          precio de entrada antes de guardar. */}
      <p className="mt-1.5 font-mono text-[10px] text-muted-foreground/60">
        {err ? (
          <span className="text-rose-700 dark:text-rose-300">{err}</span>
        ) : effectiveShares !== null ? (
          <>
            {mode === "amount"
              ? `≈ ${fmtShares(effectiveShares)} acciones`
              : parsedCost !== null
                ? `≈ ${money(effectiveShares * parsedCost)} invertidos`
                : "sin precio de entrada no hay P&L"}
            {price !== null
              ? ` · valor hoy ${money(effectiveShares * price)}`
              : ""}
          </>
        ) : (
          "vacío = quitar · Esc cancela"
        )}
      </p>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  onKeyDown,
  autoFocus,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
  autoFocus?: boolean;
}) {
  return (
    <label className="flex flex-col gap-0.5">
      <span className="font-mono text-[9px] uppercase tracking-[0.12em] text-muted-foreground/45">
        {label}
      </span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        inputMode="decimal"
        autoFocus={autoFocus}
        className="w-36 rounded-sm border border-border/60 bg-transparent px-2 py-1 font-mono text-[12px] tabular-nums outline-none focus:border-primary/50"
      />
    </label>
  );
}

function AddPosition({
  onAdded,
}: {
  onAdded: (items: PortfolioItem[], symbol: string) => void;
}) {
  const [symbol, setSymbol] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function add() {
    const s = symbol.trim().toUpperCase();
    if (!s || saving) return;
    setSaving(true);
    setErr(null);
    try {
      // Reutiliza el alta de watchlist: dar de alta el ticker ahí es lo que
      // mantiene la integridad del universo (`addToWatchlist` inserta en
      // `tickers`) y hace que Catalyst empiece a seguir sus noticias. Tener
      // una posición sin seguir el valor no tendría sentido.
      const r = await fetch("/api/watchlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol: s }),
      });
      if (!r.ok) {
        setErr("Símbolo no válido");
        return;
      }
      const data = (await r.json()) as { items: PortfolioItem[] };
      onAdded(data.items, s);
    } catch {
      setErr("Error de red");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-sm border border-border/60 bg-card/40 px-3 py-2.5">
      <input
        value={symbol}
        onChange={(e) => setSymbol(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") void add();
        }}
        placeholder="ticker (p. ej. NVDA)"
        maxLength={10}
        autoFocus
        className="w-44 rounded-sm border border-border/60 bg-transparent px-2 py-1 font-mono text-[12px] uppercase outline-none focus:border-primary/50"
      />
      <button
        type="button"
        onClick={() => void add()}
        disabled={saving || !symbol.trim()}
        className="rounded-sm border border-primary/50 px-2.5 py-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-primary transition-colors hover:bg-primary/10 disabled:opacity-40"
      >
        {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : "añadir"}
      </button>
      {err ? (
        <span className="font-mono text-[10px] text-rose-700 dark:text-rose-300">
          {err}
        </span>
      ) : (
        <span className="font-mono text-[10px] text-muted-foreground/55">
          se añade a la watchlist y se abre el editor de posición
        </span>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────

function num(v: string): number | null {
  const t = v.trim().replace(",", ".");
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

function toneClass(n: number | null): string {
  if (n === null) return "text-muted-foreground";
  if (n > 0) return "text-emerald-700 dark:text-emerald-300";
  if (n < 0) return "text-rose-700 dark:text-rose-300";
  return "text-muted-foreground";
}

const MONEY = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

function money(n: number): string {
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}M`;
  return `${sign}$${MONEY.format(abs)}`;
}

function signedMoney(n: number): string {
  return `${n > 0 ? "+" : ""}${money(n)}`;
}

function signedPct(n: number): string {
  return `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
}

/** Fraccionario sólo cuando lo hay: "12" en vez de "12.0000", pero
 *  "3.5714" cuando la posición viene de dividir un importe. */
function fmtShares(n: number): string {
  if (Number.isInteger(n)) return n.toLocaleString("en-US");
  return n.toLocaleString("en-US", { maximumFractionDigits: 4 });
}
