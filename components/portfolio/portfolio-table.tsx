"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Loader2, Minus, Pencil, Plus, X } from "lucide-react";
import {
  addToPosition,
  buildPortfolio,
  journalCash,
  reducePosition,
  sharesFromAmount,
  type JournalCash,
  type PricedPosition,
  type QuoteLike,
} from "@/lib/portfolio";
// Type-only: se borra al compilar, así que este componente de cliente NO
// arrastra `lib/db` al bundle. Mismo patrón que `AskResponse` en /ask.
import type { PositionTrade } from "@/lib/db/queries";
import {
  HORIZONS,
  HORIZON_HINT,
  HORIZON_LABEL,
  type TradeHorizon,
} from "@/lib/coach/horizon";
import {
  AXIS_HINT,
  AXIS_LABEL,
  CAPITAL,
  CICLO,
  MADUREZ,
  PRESETS,
  PRESET_LABEL,
  PRESET_NAMES,
  coreOf,
  describeAxes,
  parseAxes,
  type Axes,
} from "@/lib/coach/frames";
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
  /** Qué clase de empresa crees que es, en tres ejes. Decide qué señal es
   *  ruido y cuál es mortal para ESTA posición — ver `lib/coach/frames.ts`. */
  axes: Axes | null;
  /** Lo que crees HOY sobre la posición. Distinta de la tesis del diario:
   *  aquélla es lo que escribiste AL OPERAR y no se toca; ésta describe el
   *  presente y se actualiza. Es la única que pueden tener las posiciones
   *  anteriores al diario — ver `watchlist.thesis` en el esquema. */
  thesis: string | null;
  thesisHorizon: TradeHorizon | null;
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
  initialTrades,
  initialJournal,
}: {
  initialItems: PortfolioItem[];
  initialQuotes: QuotesMap;
  initialTrades: PositionTrade[];
  /** Caja del diario agregada EN EL SERVIDOR sobre el diario completo
   *  (getJournalCash). `null` sólo si la BD falló al servir la página. */
  initialJournal: JournalCash | null;
}) {
  const [items, setItems] = useState(initialItems);
  const [quotes, setQuotes] = useState<QuotesMap>(initialQuotes);
  const [trades, setTrades] = useState(initialTrades);
  const [journal, setJournal] = useState(initialJournal);
  const [editing, setEditing] = useState<string | null>(null);
  const [buying, setBuying] = useState<string | null>(null);
  const [selling, setSelling] = useState<string | null>(null);
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

  // El diario ENTERO, no el de una fila: es lo que responde "he vendido, ¿y
  // el dinero?". Antes esta cuenta no existía en ningún sitio y la venta
  // sólo se veía como una caída del valor de la cartera.
  //
  // La cifra buena es la del SERVIDOR (`journal`): se agrega sobre TODAS
  // las filas del diario, mientras que `trades` es el corte de 200 que se
  // pinta — sumar sobre el corte dejaba fuera lo anterior a la operación
  // 201 sin síntoma (audit 2026-08-01). El cálculo local queda sólo como
  // degradación si el servidor no la pudo servir.
  const cash = useMemo(
    () => journal ?? journalCash(trades),
    [journal, trades],
  );

  return (
    <div className="flex flex-col gap-5">
      <Totals p={portfolio} cash={cash} />

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
                  onItems={setItems}
                  editing={editing === pos.symbol}
                  buying={buying === pos.symbol}
                  selling={selling === pos.symbol}
                  trades={trades.filter((t) => t.symbol === pos.symbol)}
                  price={quotes[pos.symbol]?.price ?? null}
                  // Los dos formularios se excluyen: abrir uno cierra el
                  // otro. Tenerlos abiertos a la vez sobre la misma fila
                  // invita a guardar en el equivocado — uno registra una
                  // compra y el otro sobrescribe la posición entera.
                  onToggleEdit={() => {
                    setBuying(null);
                    setSelling(null);
                    setEditing((cur) => (cur === pos.symbol ? null : pos.symbol));
                  }}
                  onToggleBuy={() => {
                    setEditing(null);
                    setSelling(null);
                    setBuying((cur) => (cur === pos.symbol ? null : pos.symbol));
                  }}
                  onToggleSell={() => {
                    setEditing(null);
                    setBuying(null);
                    setSelling((cur) => (cur === pos.symbol ? null : pos.symbol));
                  }}
                  onSaved={(next, nextTrades, nextJournal) => {
                    setItems(next);
                    if (nextTrades) setTrades(nextTrades);
                    if (nextJournal) setJournal(nextJournal);
                    setEditing(null);
                  }}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {trades.length ? (
        <section>
          <h2 className="eyebrow mb-2 text-[10px] text-foreground">
            Diario de operaciones
          </h2>
          <p className="mb-2 max-w-[76ch] font-mono text-[10px] leading-relaxed text-muted-foreground/60">
            Todo lo que has registrado, lo último primero. La{" "}
            <span className="text-muted-foreground">caja del diario</span> de
            arriba es la suma de estas ventas menos estas compras — no es el
            saldo de tu bróker: no incluye ingresos, retiradas, dividendos,
            comisiones ni las compras anteriores a{" "}
            {cash.since ? cash.since.slice(0, 10) : "hoy"}.
          </p>
          <TradeLog trades={trades} cash={cash} showSymbol onAnnotated={setTrades} />
        </section>
      ) : null}

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

function Totals({
  p,
  cash,
}: {
  p: ReturnType<typeof buildPortfolio>;
  cash: JournalCash;
}) {
  // Las dos casillas del diario sólo aparecen si hay diario. Con cero
  // operaciones, un "0,00 $" de realizado y otro de caja son ruido que
  // además se lee como una afirmación ("no has ganado nada", "no tienes
  // efectivo") cuando lo cierto es que no hay nada que contar todavía.
  const hasJournal = cash.buys + cash.sells > 0;

  return (
    <div
      className={cn(
        "grid grid-cols-2 gap-px overflow-hidden rounded-sm border border-border/60 bg-border/40",
        hasJournal ? "sm:grid-cols-3 lg:grid-cols-6" : "sm:grid-cols-4",
      )}
    >
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
      {hasJournal ? (
        <>
          <Stat
            label="P&L realizado"
            value={cash.realized !== null ? signedMoney(cash.realized) : "—"}
            // Si alguna venta no pudo medir su realizado, el total es
            // PARCIAL y hay que decirlo: presentarlo a secas invita a
            // sumarlo con el no realizado y sacar un total falso.
            sub={
              cash.realizedUnknownSales > 0
                ? `parcial · ${cash.realizedUnknownSales} sin coste`
                : `${cash.sells} vta${cash.sells === 1 ? "" : "s"}`
            }
            tone={cash.realized}
          />
          <Stat
            label="caja del diario"
            value={signedMoney(cash.net)}
            // El "desde" NO es decorativo: es lo que impide leer esta cifra
            // como el saldo del bróker. Le faltan ingresos, retiradas,
            // dividendos, comisiones y todas las compras anteriores al
            // diario. Ver `journalCash` en lib/portfolio.ts.
            sub={cash.since ? `desde ${cash.since.slice(0, 10)}` : undefined}
            tone={cash.net}
          />
        </>
      ) : null}
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
  onItems,
  pos,
  item,
  editing,
  buying,
  selling,
  trades,
  price,
  onToggleEdit,
  onToggleBuy,
  onToggleSell,
  onSaved,
}: {
  pos: PricedPosition;
  item: PortfolioItem | undefined;
  editing: boolean;
  buying: boolean;
  selling: boolean;
  onItems: (items: PortfolioItem[]) => void;
  trades: PositionTrade[];
  price: number | null;
  onToggleEdit: () => void;
  onToggleBuy: () => void;
  onToggleSell: () => void;
  onSaved: (
    items: PortfolioItem[],
    trades?: PositionTrade[],
    journal?: JournalCash,
  ) => void;
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
          <FramePicker
            symbol={pos.symbol}
            axes={item?.axes ?? null}
            onSaved={onItems}
          />
          <BeliefPicker
            symbol={pos.symbol}
            thesis={item?.thesis ?? null}
            horizon={item?.thesisHorizon ?? null}
            onSaved={onItems}
          />
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
          {/* Reforzar va PRIMERO y con más contraste que editar: comprar más
              de algo que ya tienes es la operación frecuente; corregir a
              mano lo que registraste mal es la excepción. */}
          <button
            type="button"
            onClick={onToggleBuy}
            aria-label={`Reforzar posición de ${pos.symbol}`}
            title="He comprado más"
            className={cn(
              "rounded-sm p-1 text-muted-foreground/50 transition-colors hover:text-emerald-700 dark:hover:text-emerald-300",
              buying && "text-emerald-700 dark:text-emerald-300",
            )}
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={onToggleSell}
            aria-label={`Recortar posición de ${pos.symbol}`}
            title="He vendido"
            className={cn(
              "rounded-sm p-1 text-muted-foreground/50 transition-colors hover:text-rose-700 dark:hover:text-rose-300",
              selling && "text-rose-700 dark:text-rose-300",
            )}
          >
            <Minus className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={onToggleEdit}
            aria-label={`Editar posición de ${pos.symbol}`}
            title="Corregir la posición registrada"
            className={cn(
              "rounded-sm p-1 text-muted-foreground/40 transition-colors hover:text-primary",
              editing && "text-primary",
            )}
          >
            <Pencil className="h-3 w-3" />
          </button>
        </td>
      </tr>
      {selling && item ? (
        <tr>
          <td colSpan={11} className="px-2 pb-3">
            <SellSome
              item={item}
              price={price}
              onSaved={onSaved}
              onCancel={onToggleSell}
            />
          </td>
        </tr>
      ) : null}
      {/* El diario acompaña a cualquiera de los dos formularios abiertos:
          decidir cuánto comprar o vender se hace mirando lo que ya hiciste,
          no de memoria. */}
      {(buying || selling) && trades.length ? (
        <tr>
          <td colSpan={11} className="px-2 pb-3">
            <TradeLog trades={trades} />
          </td>
        </tr>
      ) : null}
      {buying && item ? (
        <tr>
          <td colSpan={11} className="px-2 pb-3">
            <BuyMore
              item={item}
              price={price}
              onSaved={onSaved}
              onCancel={onToggleBuy}
            />
          </td>
        </tr>
      ) : null}
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

/**
 * Recortar: vender parte (o todo) y ver lo que realizas ANTES de confirmar.
 *
 * La previsualización enseña el P&L realizado porque es el número que no
 * está en ninguna otra pantalla y el que de verdad decide si vendes hoy o
 * mañana. Y enseña que el coste medio NO se mueve, que es lo que casi todo
 * el mundo espera que pase y no pasa.
 */
function SellSome({
  item,
  price,
  onSaved,
  onCancel,
}: {
  item: PortfolioItem;
  price: number | null;
  onSaved: (
    items: PortfolioItem[],
    trades?: PositionTrade[],
    journal?: JournalCash,
  ) => void;
  onCancel: () => void;
}) {
  const [qty, setQty] = useState("");
  const [sellPrice, setSellPrice] = useState(price?.toString() ?? "");
  const [horizon, setHorizon] = useState<TradeHorizon | null>(null);
  const [thesis, setThesis] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const parsedPrice = num(sellPrice);
  const parsedQty = num(qty);
  const held = item.shares ?? 0;

  const preview =
    parsedQty !== null && parsedQty > 0 && parsedPrice !== null
      ? reducePosition(item, { shares: parsedQty, price: parsedPrice })
      : null;

  async function save() {
    if (saving) return;
    if (parsedQty === null || parsedQty <= 0 || parsedPrice === null) {
      setErr("Hacen falta las acciones vendidas y el precio");
      return;
    }
    // En la VENTA el plazo pesa aún más que en la compra: es lo que separa
    // «cierro un trade que no funcionó» de «recorto concentración de una
    // posición que sigo queriendo a años». Sin él, las dos se juzgarían con
    // la misma vara y una de las dos saldría injustamente mal.
    if (horizon === null) {
      setErr("Elige el plazo: es lo que decide cómo se juzga esta venta");
      return;
    }
    setSaving(true);
    setErr(null);
    try {
      const r = await fetch("/api/watchlist", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          symbol: item.symbol,
          sell: {
            shares: parsedQty,
            price: parsedPrice,
            horizon,
            thesis: thesis.trim() || null,
          },
        }),
      });
      const data = (await r.json().catch(() => ({}))) as {
        items?: PortfolioItem[];
        trades?: PositionTrade[];
        journal?: JournalCash;
        error?: string;
        shares?: number | null;
      };
      if (r.status === 422) {
        setErr(
          data.error === "excede"
            ? `Sólo tienes ${fmtShares(data.shares ?? 0)} acciones`
            : "No hay posición que recortar",
        );
        return;
      }
      if (r.status === 409) {
        if (data.items) onSaved(data.items, data.trades, data.journal);
        setErr("La posición cambió en otro sitio. Revisa el dato y repite.");
        return;
      }
      if (!r.ok || !data.items) {
        setErr("No se pudo registrar la venta");
        return;
      }
      onSaved(data.items, data.trades, data.journal);
      onCancel();
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
    <div className="rounded-sm border border-rose-600/30 bg-rose-500/[0.04] px-3 py-2.5">
      <div className="mb-2 flex items-center gap-2">
        <span className="font-mono text-[9.5px] uppercase tracking-[0.14em] text-rose-700/80 dark:text-rose-300/80">
          {item.symbol} · he vendido
        </span>
        <button
          type="button"
          onClick={() => setQty(String(held))}
          className="rounded-sm border border-border/40 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground/70 transition-colors hover:text-foreground"
          title="Vender la posición entera"
        >
          todo ({fmtShares(held)})
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Field
          label="acciones vendidas"
          value={qty}
          onChange={setQty}
          onKeyDown={onKey}
          autoFocus
        />
        <Field
          label="precio de venta"
          value={sellPrice}
          onChange={setSellPrice}
          onKeyDown={onKey}
        />
        <button
          type="button"
          onClick={() => void save()}
          disabled={saving || !preview?.ok || horizon === null}
          className="rounded-sm border border-rose-600/50 px-2.5 py-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-rose-700 transition-colors hover:bg-rose-500/10 disabled:opacity-40 dark:text-rose-300"
        >
          {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : "vender"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-sm border border-border/50 px-2.5 py-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground transition-colors hover:text-foreground"
        >
          cancelar
        </button>
      </div>

      <IntentPicker
        horizon={horizon}
        onHorizon={setHorizon}
        thesis={thesis}
        onThesis={setThesis}
        tone="sell"
      />

      <p className="mt-1.5 font-mono text-[10px] leading-relaxed text-muted-foreground/70">
        {err ? (
          <span className="text-rose-700 dark:text-rose-300">{err}</span>
        ) : preview?.ok ? (
          <>
            <span className="text-foreground/80">
              {fmtShares(held)} → {fmtShares(preview.shares)} acciones
            </span>
            {preview.closes ? (
              <span className="text-amber-700 dark:text-amber-300">
                {" "}
                · cierra la posición (sigue en seguimiento)
              </span>
            ) : null}
            {" · realizas "}
            {preview.realized === null ? (
              <span className="text-amber-700 dark:text-amber-300">
                un importe desconocido: esta posición no tiene coste registrado
              </span>
            ) : (
              <span
                className={
                  preview.realized >= 0
                    ? "text-emerald-700 dark:text-emerald-300"
                    : "text-rose-700 dark:text-rose-300"
                }
              >
                {signedMoney(preview.realized)}
              </span>
            )}
            <span className="text-muted-foreground/50">
              {" "}
              · el coste medio no cambia al vender
            </span>
          </>
        ) : preview && !preview.ok ? (
          <span className="text-rose-700 dark:text-rose-300">
            {preview.reason === "excede"
              ? `Sólo tienes ${fmtShares(held)} acciones`
              : "No hay posición que recortar"}
          </span>
        ) : (
          "acciones + precio · Enter guarda · Esc cancela"
        )}
      </p>
    </div>
  );
}

/**
 * Diario de operaciones de un símbolo. Sólo lectura.
 *
 * Es append-only y NO es la fuente de verdad de la posición (lo es
 * `watchlist.shares`/`avg_cost`): sirve para auditar qué pasó, no para
 * calcular. Por eso cada línea lleva el estado RESULTANTE — sin él, una
 * fila suelta no se puede verificar sin reproducir todo el historial.
 */
function TradeLog({
  trades,
  cash,
  showSymbol = false,
  onAnnotated,
}: {
  trades: PositionTrade[];
  /** Caja agregada por el SERVIDOR sobre el diario completo. La pasa el
   *  diario global; sin ella (instancia por fila) se agrega el corte local
   *  con la misma función. */
  cash?: JournalCash | null;
  /** El diario global mezcla valores, así que ahí el símbolo es obligatorio;
   *  dentro de una fila sería repetir la cabecera en cada línea. */
  showSymbol?: boolean;
  /** Presente sólo en el diario global: habilita clasificar a posteriori
   *  las operaciones sin plazo. Dentro del formulario de una fila NO se
   *  ofrece — estás en mitad de otra operación y clasificar una vieja ahí
   *  es un desvío que invita a guardar en el sitio equivocado. */
  onAnnotated?: (trades: PositionTrade[]) => void;
}) {
  // Qué fila tiene abierto el formulario de clasificación. Vive AQUÍ y no en
  // cada fila porque el contenedor con scroll es de este componente: con el
  // formulario dentro de una caja de 288px se abría aplastado y medio
  // cortado. Sabiendo si hay alguno abierto, el scroll se suelta.
  const [annotating, setAnnotating] = useState<number | null>(null);

  if (!trades.length) {
    return (
      <p className="px-1 py-2 font-mono text-[10px] text-muted-foreground/50">
        Sin operaciones registradas. El diario empieza el día que se creó —
        las posiciones anteriores no tienen historia que enseñar.
      </p>
    );
  }
  // La cuenta sale de `journalCash` — la única definición del P&L realizado
  // en el proyecto — y NUNCA de un reduce propio con `?? 0`: convertir null
  // en 0 afirmaba "no ganaste nada" sobre ventas cuya verdad es "no se
  // sabe", y omitía el marcador de parcialidad que el tipo declara
  // obligatorio. El diario global recibe la caja del SERVIDOR (diario
  // completo) vía `cash`; una instancia por fila agrega su propio corte.
  const box = cash ?? journalCash(trades);

  return (
    <div className="rounded-sm border border-border/50 bg-background/40 px-3 py-2">
      <div className="mb-1.5 flex items-baseline justify-between">
        {/* En el diario global la sección ya lleva su <h2>; repetir el
            rótulo aquí lo pintaba dos veces seguidas. El hueco se mantiene
            para que el realizado siga alineado a la derecha. */}
        <span className="font-mono text-[9.5px] uppercase tracking-[0.14em] text-muted-foreground/50">
          {showSymbol ? "" : "diario de operaciones"}
        </span>
        {box.realized !== null ? (
          <span className="font-mono text-[10px] text-muted-foreground">
            realizado:{" "}
            <span className={toneClass(box.realized)}>
              {signedMoney(box.realized)}
            </span>
            {box.realizedUnknownSales > 0 ? (
              <span className="text-muted-foreground/60">
                {" "}
                · parcial ({box.realizedUnknownSales} sin coste)
              </span>
            ) : null}
          </span>
        ) : null}
      </div>
      <ul
        className={cn(
          "flex flex-col gap-0.5",
          // Sin nadie clasificando, el diario largo no debe empujar la
          // página entera. Con un formulario abierto, recortarlo sería peor.
          annotating === null && trades.length > 8
            ? "max-h-72 overflow-y-auto"
            : "",
        )}
      >
        {trades.map((t) => (
          <li
            key={t.id}
            className="flex flex-wrap items-baseline gap-x-2 font-mono text-[10.5px] text-muted-foreground"
          >
            <span className="text-muted-foreground/50">
              {t.createdAt.slice(0, 10)}
            </span>
            {showSymbol ? (
              <span className="w-[3.5rem] text-foreground">{t.symbol}</span>
            ) : null}
            <span
              className={cn(
                "w-[4.5rem] uppercase tracking-[0.1em]",
                t.side === "buy"
                  ? "text-emerald-700 dark:text-emerald-300"
                  : t.side === "sell"
                    ? "text-rose-700 dark:text-rose-300"
                    : "text-muted-foreground/60",
              )}
            >
              {t.side === "buy"
                ? "compra"
                : t.side === "sell"
                  ? "venta"
                  : "ajuste"}
            </span>
            <span className="text-foreground/80">
              {t.shares !== null && t.price !== null
                ? `${fmtShares(t.shares)} @ ${money(t.price)}`
                : "corrección a mano"}
            </span>
            {t.realizedPnl !== null ? (
              <span className={toneClass(t.realizedPnl)}>
                realiza {signedMoney(t.realizedPnl)}
              </span>
            ) : null}
            <span className="text-muted-foreground/45">
              → {fmtShares(t.sharesAfter ?? 0)} acc.
              {t.avgCostAfter !== null ? ` · medio ${money(t.avgCostAfter)}` : ""}
            </span>
            <TradeIntent
              trade={t}
              onAnnotated={onAnnotated}
              open={annotating === t.id}
              onOpenChange={(v) => setAnnotating(v ? t.id : null)}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Una fila de opciones de un eje. A nivel de módulo y NO dentro de
 *  `FramePicker`: un componente definido en el render se remonta en cada
 *  pintada, pierde el foco y tira el estado de sus hijos. */
function EjeRow<K extends keyof Axes>({
  k,
  opciones,
  valor,
  disabled,
  onPick,
}: {
  k: K;
  opciones: readonly Axes[K][];
  valor: Axes[K] | undefined;
  disabled: boolean;
  onPick: (v: Axes[K]) => void;
}) {
  return (
    <div className="flex flex-wrap gap-0.5">
      {opciones.map((v) => (
        <button
          key={String(v)}
          type="button"
          onClick={() => onPick(v)}
          disabled={disabled}
          title={AXIS_HINT[k][v as never]}
          className={cn(
            "rounded-sm border px-1 py-px font-mono text-[8.5px] uppercase tracking-[0.08em] transition-colors disabled:opacity-40",
            valor === v
              ? "border-primary/50 text-primary"
              : "border-border/40 text-muted-foreground/70 hover:text-foreground",
          )}
        >
          {AXIS_LABEL[k][v as never]}
        </button>
      ))}
    </div>
  );
}

/**
 * Lo que crees HOY sobre la posición, con su plazo.
 *
 * Vive junto al marco y NO en el formulario de operar, porque no es una
 * operación: es una creencia sobre una posición que ya tienes. 5 de las 7
 * posiciones reales son anteriores al diario y no tienen ninguna fila que
 * anotar — sin este control, el coach les pediría para siempre una tesis
 * que no había forma de escribir.
 *
 * Reutiliza `IntentPicker`, el mismo control que piden comprar, vender y
 * clasificar a posteriori. Una sola definición por el mismo motivo que la
 * de los plazos: un formulario que ofreciera opciones distintas de las que
 * evalúa el código produciría datos imposibles de juzgar. De regalo viene
 * la pista de que el contexto de mercado NO va en la tesis.
 *
 * Se guarda con un botón explícito y no al salir del campo, al revés que
 * el marco: los ejes son tres clics sobre valores cerrados y se pueden
 * autoguardar sin riesgo, pero un texto a medio escribir guardado por un
 * blur accidental es una creencia que nadie declaró.
 */
function BeliefPicker({
  symbol,
  thesis,
  horizon,
  onSaved,
}: {
  symbol: string;
  thesis: string | null;
  horizon: TradeHorizon | null;
  onSaved: (items: PortfolioItem[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [draft, setDraft] = useState(thesis ?? "");
  const [h, setH] = useState<TradeHorizon | null>(horizon);

  async function save(next: string | null) {
    // El plazo es obligatorio para escribir, igual que en una operación:
    // sin él, `verdictHorizonsFor` no sabe si esta creencia admite un
    // veredicto de precio. Al RETIRARLA da igual, y por eso el borrado no
    // lo exige.
    if (saving || (next !== null && h === null)) return;
    setSaving(true);
    setErr(null);
    try {
      const r = await fetch("/api/watchlist", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          symbol,
          believe: { horizon: h ?? "medio", thesis: next },
        }),
      });
      const data = (await r.json().catch(() => ({}))) as {
        items?: PortfolioItem[];
      };
      if (!r.ok || !data.items) {
        setErr("No se pudo guardar");
        return;
      }
      onSaved(data.items);
      setOpen(false);
    } catch {
      setErr("Error de red");
    } finally {
      setSaving(false);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={cn(
          "mt-0.5 block max-w-[22ch] truncate rounded-sm border px-1 py-px text-left font-mono text-[9px] uppercase tracking-[0.1em] transition-colors",
          thesis
            ? "border-border/40 text-muted-foreground/60 hover:text-foreground"
            : "border-amber-600/30 text-amber-700/70 hover:border-amber-600/60 dark:text-amber-300/70",
        )}
        title={
          thesis ??
          "Sin tesis: el coach no tiene tus palabras contra las que leer lo que se mueve"
        }
      >
        {thesis ? `hoy · ${horizon ?? "?"}` : "sin tesis"}
      </button>
    );
  }

  return (
    <div className="mt-1 flex flex-col gap-1">
      <IntentPicker
        horizon={h}
        onHorizon={setH}
        thesis={draft}
        onThesis={setDraft}
        tone="buy"
      />
      {err ? (
        <p className="font-mono text-[9px] text-destructive">{err}</p>
      ) : null}
      <div className="flex gap-1">
        <button
          type="button"
          disabled={saving || !draft.trim() || h === null}
          onClick={() => void save(draft.trim())}
          className="rounded-sm border border-border/60 px-1.5 py-px font-mono text-[9px] uppercase tracking-[0.1em] hover:border-foreground/40 disabled:opacity-40"
        >
          {saving ? "…" : "guardar"}
        </button>
        <button
          type="button"
          onClick={() => {
            setDraft(thesis ?? "");
            setH(horizon);
            setErr(null);
            setOpen(false);
          }}
          className="rounded-sm border border-border/40 px-1.5 py-px font-mono text-[9px] uppercase tracking-[0.1em] text-muted-foreground/60 hover:text-foreground"
        >
          cancelar
        </button>
        {thesis ? (
          <button
            type="button"
            disabled={saving}
            onClick={() => void save(null)}
            className="ml-auto rounded-sm border border-border/40 px-1.5 py-px font-mono text-[9px] uppercase tracking-[0.1em] text-muted-foreground/50 hover:text-destructive disabled:opacity-40"
          >
            retirar
          </button>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Qué CLASE de empresa es esta posición, en los TRES EJES.
 *
 * Los cuatro atajos siguen arriba porque nombrar es más rápido que rellenar
 * tres campos, pero lo que se guarda son los ejes — y por eso existe la
 * fila de abajo: una empresa puede no ser ninguno de los cuatro. META es
 * "cosechando + capital alto + ciclo exógeno" y ninguna etiqueta la nombra;
 * forzarla a `power play` marcaba su núcleo como MORTAL y la próxima
 * recesión publicitaria habría disparado "tesis rota" por el ciclo.
 *
 * Que se vea «sin clasificar» en ámbar es deliberado: es una casilla vacía
 * que cuesta tres clics y desbloquea toda la lectura.
 */
function FramePicker({
  symbol,
  axes,
  onSaved,
}: {
  symbol: string;
  axes: Axes | null;
  onSaved: (items: PortfolioItem[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  // Borrador local: los tres ejes se mandan JUNTOS, así que hasta que estén
  // los tres no se escribe nada. Media clasificación daría media lectura.
  const [draft, setDraft] = useState<Partial<Axes>>(axes ?? {});

  async function save(next: Axes) {
    if (saving) return;
    setSaving(true);
    try {
      const r = await fetch("/api/watchlist", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol, axes: next }),
      });
      const data = (await r.json().catch(() => ({}))) as {
        items?: PortfolioItem[];
      };
      if (r.ok && data.items) onSaved(data.items);
      setOpen(false);
    } catch {
      // Silencioso: lo anterior sigue en pantalla y se puede repetir.
    } finally {
      setSaving(false);
    }
  }

  function set<K extends keyof Axes>(k: K, v: Axes[K]) {
    const next = { ...draft, [k]: v };
    setDraft(next);
    const full = parseAxes(next);
    if (full) void save(full);
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={cn(
          "mt-0.5 rounded-sm border px-1 py-px font-mono text-[9px] uppercase tracking-[0.1em] transition-colors",
          axes
            ? "border-border/40 text-muted-foreground/60 hover:text-foreground"
            : "border-amber-600/30 text-amber-700/70 hover:border-amber-600/60 dark:text-amber-300/70",
        )}
        title={
          axes
            ? coreOf(axes)
            : "Sin clasificar: el coach no puede leer si una señal contradice tu tesis"
        }
      >
        {axes ? describeAxes(axes) : "sin clasificar"}
      </button>
    );
  }

  return (
    <div className="mt-1 flex flex-col gap-1">
      <div className="flex flex-wrap gap-0.5">
        {PRESET_NAMES.map((n) => (
          <button
            key={n}
            type="button"
            onClick={() => {
              setDraft(PRESETS[n]);
              void save(PRESETS[n]);
            }}
            disabled={saving}
            className="rounded-sm border border-border/30 px-1 py-px font-mono text-[8.5px] uppercase tracking-[0.08em] text-muted-foreground/50 transition-colors hover:text-foreground disabled:opacity-40"
          >
            {PRESET_LABEL[n]}
          </button>
        ))}
      </div>
      <EjeRow k="madurez" opciones={MADUREZ} valor={draft.madurez} disabled={saving} onPick={(v) => set("madurez", v)} />
      <EjeRow k="capital" opciones={CAPITAL} valor={draft.capital} disabled={saving} onPick={(v) => set("capital", v)} />
      <EjeRow k="ciclo" opciones={CICLO} valor={draft.ciclo} disabled={saving} onPick={(v) => set("ciclo", v)} />
      <button
        type="button"
        onClick={() => setOpen(false)}
        className="text-left font-mono text-[8.5px] uppercase tracking-[0.08em] text-muted-foreground/50 hover:text-foreground"
      >
        cerrar
      </button>
    </div>
  );
}

/**
 * El plazo y la tesis de una operación ya registrada — o el botón para
 * ponérselos si le faltan.
 *
 * LA MARCA «a posteriori» ES LO IMPORTANTE DE ESTE COMPONENTE. Una tesis
 * escrita sabiendo ya cómo fue la operación no es una predicción, y
 * enseñarla igual que una escrita en el momento convertiría el panel en una
 * máquina de confirmarte que siempre tuviste razón. Por eso la marca se
 * pinta SIEMPRE que existe, y no se puede quitar.
 */
function TradeIntent({
  trade,
  onAnnotated,
  open,
  onOpenChange,
}: {
  trade: PositionTrade;
  onAnnotated?: (trades: PositionTrade[]) => void;
  /** Controlado desde `TradeLog`: sólo una fila puede estar clasificándose a
   *  la vez, y quien manda en el scroll del contenedor necesita saberlo. */
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const [horizon, setHorizon] = useState<TradeHorizon | null>(null);
  const [thesis, setThesis] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Los ajustes no se clasifican: no son decisiones de mercado, así que
  // ofrecerles un plazo sugeriría que se juzgan, y no se juzgan.
  if (trade.side === "adjust") return null;

  if (trade.horizon) {
    return (
      <span className="text-muted-foreground/45">
        · {trade.horizon}
        {trade.annotatedLater ? (
          <span
            className="text-amber-700/70 dark:text-amber-300/70"
            title="Clasificada después de operar: no cuenta como predicción"
          >
            {" "}
            (a posteriori)
          </span>
        ) : null}
        {trade.thesis ? (
          <span className="text-foreground/60"> · «{trade.thesis}»</span>
        ) : null}
      </span>
    );
  }

  if (!onAnnotated) return null;

  async function save() {
    if (saving || horizon === null) return;
    setSaving(true);
    setErr(null);
    try {
      const r = await fetch("/api/watchlist", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          annotate: {
            tradeId: trade.id,
            horizon,
            thesis: thesis.trim() || null,
          },
        }),
      });
      const data = (await r.json().catch(() => ({}))) as {
        trades?: PositionTrade[];
      };
      if (!r.ok || !data.trades) {
        setErr("No se pudo clasificar");
        return;
      }
      onAnnotated!(data.trades);
      onOpenChange(false);
    } catch {
      setErr("Error de red");
    } finally {
      setSaving(false);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => onOpenChange(true)}
        className="rounded-sm border border-amber-600/30 px-1.5 py-0.5 font-mono text-[9.5px] uppercase tracking-[0.12em] text-amber-700/80 transition-colors hover:border-amber-600/60 dark:text-amber-300/80"
        title="Sin plazo declarado: el coach no puede juzgarla"
      >
        sin clasificar
      </button>
    );
  }

  return (
    <div className="mt-1 w-full rounded-sm border border-border/50 bg-background/60 px-2 py-1.5">
      <p className="mb-1 font-mono text-[9.5px] leading-relaxed text-amber-700/80 dark:text-amber-300/80">
        Se marcará como clasificada A POSTERIORI: escribir la tesis sabiendo
        ya el resultado no es predecir, y el coach tiene que distinguirlo.
      </p>
      <IntentPicker
        horizon={horizon}
        onHorizon={setHorizon}
        thesis={thesis}
        onThesis={setThesis}
        tone={trade.side === "buy" ? "buy" : "sell"}
      />
      <div className="mt-1.5 flex items-center gap-2">
        <button
          type="button"
          onClick={() => void save()}
          disabled={saving || horizon === null}
          className="rounded-sm border border-primary/50 px-2 py-1 font-mono text-[9.5px] uppercase tracking-[0.12em] text-primary transition-colors disabled:opacity-40"
        >
          {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : "guardar"}
        </button>
        <button
          type="button"
          onClick={() => onOpenChange(false)}
          className="font-mono text-[9.5px] uppercase tracking-[0.12em] text-muted-foreground/70 transition-colors hover:text-foreground"
        >
          cancelar
        </button>
        {err ? (
          <span className="font-mono text-[9.5px] text-rose-700 dark:text-rose-300">
            {err}
          </span>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Plazo y tesis de una operación. Compartido por comprar, vender y
 * clasificar a posteriori — una sola definición del control por el mismo
 * motivo que `buildPortfolio`: si un formulario ofreciera plazos distintos
 * de los que evalúa el código, habría operaciones imposibles de juzgar.
 *
 * EL PLAZO SE ENSEÑA CON SU CONSECUENCIA DEBAJO, y no es adorno: si el
 * usuario no sabe que «largo» desactiva el veredicto de precio, elegirá al
 * tuntún y el dato nacerá torcido. Es la diferencia entre pedir un dato y
 * explicar para qué sirve.
 *
 * La tesis dice explícitamente que NO hace falta contar el contexto de
 * mercado. Sin esa pista, lo primero que se escribe es «está cayendo» —
 * que Catalyst ya sabe— en vez del porqué, que es lo único que no sabe.
 */
function IntentPicker({
  horizon,
  onHorizon,
  thesis,
  onThesis,
  tone,
}: {
  horizon: TradeHorizon | null;
  onHorizon: (h: TradeHorizon) => void;
  thesis: string;
  onThesis: (v: string) => void;
  tone: "buy" | "sell";
}) {
  const active =
    tone === "buy"
      ? "border-emerald-600/50 text-emerald-700 dark:text-emerald-300"
      : "border-rose-600/50 text-rose-700 dark:text-rose-300";
  return (
    <div className="mt-2 flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="font-mono text-[9.5px] uppercase tracking-[0.14em] text-muted-foreground/50">
          plazo
        </span>
        {HORIZONS.map((h) => (
          <button
            key={h}
            type="button"
            onClick={() => onHorizon(h)}
            className={cn(
              "rounded-sm border px-1.5 py-0.5 font-mono text-[10px] transition-colors",
              horizon === h
                ? active
                : "border-border/40 text-muted-foreground/70 hover:text-foreground",
            )}
          >
            {HORIZON_LABEL[h]}
          </button>
        ))}
      </div>
      <p className="font-mono text-[9.5px] leading-relaxed text-muted-foreground/60">
        {horizon
          ? HORIZON_HINT[horizon]
          : "obligatorio — sin plazo la operación entra en el diario pero el coach no la juzga"}
      </p>
      <input
        value={thesis}
        onChange={(e) => onThesis(e.target.value)}
        maxLength={600}
        placeholder="por qué (opcional) — el precio y las noticias ya los sabe Catalyst"
        className="w-full rounded-sm border border-border/50 bg-background/60 px-2 py-1 font-mono text-[10.5px] text-foreground placeholder:text-muted-foreground/40 focus:border-primary/50 focus:outline-none"
      />
    </div>
  );
}

/**
 * Reforzar una posición: registras la COMPRA, no el estado final.
 *
 * Es la diferencia con `PositionEditor`, que es para corregir lo que hay.
 * Aquí escribes lo que acabas de ejecutar en el bróker ("10 a 712,40") y la
 * posición se recalcula sola. Pedirte el total resultante sería obligarte a
 * hacer tú la media ponderada, que es justo la cuenta que se hace mal.
 *
 * La previsualización enseña el ANTES → DESPUÉS de acciones y coste medio
 * antes de guardar. No es adorno: es lo único que te deja ver que has
 * tecleado 7124 en vez de 712,4 mientras todavía puedes corregirlo.
 */
function BuyMore({
  item,
  price,
  onSaved,
  onCancel,
}: {
  item: PortfolioItem;
  price: number | null;
  onSaved: (
    items: PortfolioItem[],
    trades?: PositionTrade[],
    journal?: JournalCash,
  ) => void;
  onCancel: () => void;
}) {
  const [mode, setMode] = useState<"shares" | "amount">("shares");
  const [qty, setQty] = useState("");
  const [amount, setAmount] = useState("");
  // El precio de mercado como valor inicial: una compra "ahora mismo" se
  // ejecuta cerca de ahí, y así el caso normal es teclear una cifra sola.
  const [buyPrice, setBuyPrice] = useState(price?.toString() ?? "");
  const [horizon, setHorizon] = useState<TradeHorizon | null>(null);
  const [thesis, setThesis] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const parsedPrice = num(buyPrice);
  const parsedQty = num(qty);
  const parsedAmount = num(amount);
  const addShares =
    mode === "shares"
      ? parsedQty
      : parsedAmount !== null && parsedPrice !== null
        ? sharesFromAmount(parsedAmount, parsedPrice)
        : null;

  // Mismo cálculo que hará el servidor — literalmente la misma función, que
  // es lo que garantiza que lo previsualizado y lo guardado coincidan.
  const preview =
    addShares !== null && addShares > 0 && parsedPrice !== null
      ? addToPosition(item, { shares: addShares, price: parsedPrice })
      : null;

  async function save() {
    if (saving) return;
    if (addShares === null || addShares <= 0 || parsedPrice === null) {
      setErr("Hacen falta las acciones (o el importe) y el precio de compra");
      return;
    }
    // El plazo se exige AQUÍ y no sólo en el servidor porque el coste de
    // pedirlo es un clic y el de no tenerlo es permanente: una operación
    // registrada sin plazo ya no se puede juzgar sin sesgo retrospectivo.
    if (horizon === null) {
      setErr("Elige el plazo: es lo que decide cómo se juzga esta compra");
      return;
    }
    setSaving(true);
    setErr(null);
    try {
      const r = await fetch("/api/watchlist", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          symbol: item.symbol,
          add: {
            shares: addShares,
            price: parsedPrice,
            horizon,
            thesis: thesis.trim() || null,
          },
        }),
      });
      const data = (await r.json().catch(() => ({}))) as {
        items?: PortfolioItem[];
        trades?: PositionTrade[];
        journal?: JournalCash;
        error?: string;
      };
      if (r.status === 409) {
        // La fila cambió por detrás. Se refresca la tabla y NO se reintenta
        // solo: reintentar sobre el estado nuevo podría duplicar una compra
        // que ya entró.
        if (data.items) onSaved(data.items);
        setErr("La posición cambió en otro sitio. Revisa el dato y repite.");
        return;
      }
      if (!r.ok || !data.items) {
        setErr("No se pudo registrar la compra");
        return;
      }
      // La API ya devolvía `trades` y este formulario los tiraba: la compra
      // no aparecía en el diario hasta recargar. Con `journal` la caja se
      // actualiza con la cifra del servidor, no con el corte local.
      onSaved(data.items, data.trades, data.journal);
      onCancel();
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
    <div className="rounded-sm border border-emerald-600/30 bg-emerald-500/[0.04] px-3 py-2.5">
      <div className="mb-2 flex items-center gap-1.5">
        <span className="font-mono text-[9.5px] uppercase tracking-[0.14em] text-emerald-700/80 dark:text-emerald-300/80">
          {item.symbol} · he comprado más
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
                ? "border-emerald-600/50 text-emerald-700 dark:text-emerald-300"
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
            label="acciones compradas"
            value={qty}
            onChange={setQty}
            onKeyDown={onKey}
            autoFocus
          />
        ) : (
          <Field
            label="importe de la compra"
            value={amount}
            onChange={setAmount}
            onKeyDown={onKey}
            autoFocus
          />
        )}
        <Field
          label="precio de compra"
          value={buyPrice}
          onChange={setBuyPrice}
          onKeyDown={onKey}
        />
        <button
          type="button"
          onClick={() => void save()}
          disabled={saving || preview === null || horizon === null}
          className="rounded-sm border border-emerald-600/50 px-2.5 py-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-emerald-700 transition-colors hover:bg-emerald-500/10 disabled:opacity-40 dark:text-emerald-300"
        >
          {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : "añadir"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-sm border border-border/50 px-2.5 py-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground transition-colors hover:text-foreground"
        >
          cancelar
        </button>
      </div>

      <IntentPicker
        horizon={horizon}
        onHorizon={setHorizon}
        thesis={thesis}
        onThesis={setThesis}
        tone="buy"
      />

      <p className="mt-1.5 font-mono text-[10px] leading-relaxed text-muted-foreground/70">
        {err ? (
          <span className="text-rose-700 dark:text-rose-300">{err}</span>
        ) : preview ? (
          <>
            <span className="text-foreground/80">
              {fmtShares(item.shares ?? 0)} → {fmtShares(preview.shares)} acciones
            </span>
            {" · coste medio "}
            {preview.avgCostUnknown ? (
              <span className="text-amber-700 dark:text-amber-300">
                sigue sin conocerse — esta posición no tiene coste registrado y
                calcularlo desde esta compra sola sería inventarlo. Regístralo
                con el lápiz si quieres P&amp;L.
              </span>
            ) : (
              <span className="text-foreground/80">
                {item.avgCost !== null ? money(item.avgCost) : "—"} →{" "}
                {preview.avgCost !== null ? money(preview.avgCost) : "—"}
              </span>
            )}
            {parsedPrice !== null && addShares !== null
              ? ` · inviertes ${money(addShares * parsedPrice)}`
              : ""}
          </>
        ) : (
          "acciones (o importe) + precio · Enter guarda · Esc cancela"
        )}
      </p>
    </div>
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
