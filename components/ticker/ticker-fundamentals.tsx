"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

// Barra de fundamentales + peers bajo el hero del ticker. Datos de FMP
// (P/E, beta, rango 52 semanas, sector) que Finnhub free no da, cacheados
// 7 días en BD. Client component: se rellena async para no bloquear el SSR
// del hero (la 1ª visita de un símbolo hace 3 calls FMP; luego cache).

type Peer = { symbol: string; name: string | null };
type Fundamentals = {
  marketCap: number | null;
  pe: number | null;
  beta: number | null;
  sector: string | null;
  industry: string | null;
  yearHigh: number | null;
  yearLow: number | null;
  ceo: string | null;
  peers: Peer[];
};

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col">
      <span className="font-mono text-[8.5px] uppercase tracking-[0.2em] text-muted-foreground/70">
        {label}
      </span>
      <span className="tick font-mono text-[13px] font-semibold tabular-nums text-foreground">
        {value}
      </span>
    </div>
  );
}

export function TickerFundamentals({ symbol }: { symbol: string }) {
  const [state, setState] = useState<{ symbol: string; data: Fundamentals | null } | null>(
    null,
  );
  const data = state?.symbol === symbol ? state.data : null;
  const loaded = state?.symbol === symbol;

  useEffect(() => {
    const ctrl = new AbortController();
    fetch(`/api/fundamentals/${symbol}`, { signal: ctrl.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { fundamentals: Fundamentals | null } | null) => {
        setState({ symbol, data: j?.fundamentals ?? null });
      })
      .catch(() => {
        if (!ctrl.signal.aborted) setState({ symbol, data: null });
      });
    return () => ctrl.abort();
  }, [symbol]);

  // Sin datos (aún cargando, o FMP no devolvió nada): no ocupamos espacio.
  if (!loaded || !data) return null;

  const stats: Array<{ label: string; value: string }> = [];
  if (data.pe != null) stats.push({ label: "P/E", value: data.pe.toFixed(1) });
  if (data.beta != null) stats.push({ label: "Beta", value: data.beta.toFixed(2) });
  if (data.yearLow != null && data.yearHigh != null)
    stats.push({
      label: "52W range",
      value: `$${data.yearLow.toFixed(0)}–$${data.yearHigh.toFixed(0)}`,
    });
  // Mkt cap y sector ya se muestran en el hero (Finnhub) — aquí solo lo
  // que FMP añade de nuevo: P/E, beta, rango 52 semanas y peers.

  if (stats.length === 0 && data.peers.length === 0) return null;

  return (
    <section className="shrink-0 border-b border-border/60 bg-card/20 px-6 py-2.5">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
        {stats.map((s) => (
          <Stat key={s.label} label={s.label} value={s.value} />
        ))}
        {data.peers.length > 0 && (
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="font-mono text-[8.5px] uppercase tracking-[0.2em] text-muted-foreground/70">
              Peers
            </span>
            <div className="flex flex-wrap items-center gap-1.5">
              {data.peers.map((p) => (
                <Link
                  key={p.symbol}
                  href={`/ticker/${p.symbol}`}
                  title={p.name ?? p.symbol}
                  className="tick rounded-sm border border-border/60 bg-card/50 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-foreground transition-colors hover:border-primary/50 hover:text-primary"
                >
                  {p.symbol}
                </Link>
              ))}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
