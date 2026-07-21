import Link from "next/link";
import type { FundConviction, FundNewPosition } from "@/lib/funds/queries";

// Carteras 13F de los fondos curados: aperturas del último trimestre y
// dónde COINCIDEN varias gestoras. Server component, cero LLM.

function usd(n: number): string {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(0)}M`;
  return `$${n.toLocaleString("en-US")}`;
}

export function FundHoldingsSection({
  newPositions,
  conviction,
}: {
  newPositions: FundNewPosition[];
  conviction: FundConviction[];
}) {
  if (newPositions.length === 0 && conviction.length === 0) return null;

  // La fecha de presentación manda: un 13F se conoce hasta 45 días DESPUÉS
  // del cierre del trimestre, y ocultarlo haría leer posiciones viejas como
  // si fueran de hoy.
  const asOf = newPositions[0]?.period ?? null;

  return (
    <section className="flex flex-col gap-3">
      <div>
        <h2 className="eyebrow text-[11px] text-foreground">13F fund positions</h2>
        <p className="mt-1 max-w-2xl font-editorial text-[12.5px] leading-relaxed text-muted-foreground">
          Curated discretionary managers only — quants and market makers are
          excluded because their thousands of positions are rebalancing, not
          conviction. Quarterly data, filed up to 45 days after quarter end —
          each row shows the quarter it comes from
          {asOf ? `; the most recent is ${asOf}` : ""}.
        </p>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {newPositions.length > 0 && (
          <div className="rounded-sm border border-border/60 bg-card/40">
            <div className="border-b border-border/60 px-3 py-2">
              <span className="font-mono text-[9px] uppercase tracking-[0.2em] text-muted-foreground">
                New positions
              </span>
            </div>
            <ul className="divide-y divide-border/40">
              {newPositions.map((p) => (
                <li
                  key={`${p.fundName}-${p.symbol}`}
                  className="flex items-baseline gap-3 px-3 py-2"
                >
                  <Link
                    href={`/ticker/${p.symbol}`}
                    className="tick w-16 shrink-0 font-mono text-[12px] font-semibold text-foreground hover:text-primary"
                  >
                    {p.symbol}
                  </Link>
                  <span className="min-w-0 flex-1 truncate font-editorial text-[12px] text-muted-foreground">
                    {p.fundName}
                  </span>
                  {/* El trimestre va POR FILA, no sólo en la cabecera: cada
                      fondo declara cuando quiere y alguno lleva trimestres sin
                      hacerlo (Scion), así que un "latest" global haría leer una
                      cartera de hace un año como si fuera la de este trimestre. */}
                  <span className="shrink-0 font-mono text-[9px] tabular-nums text-muted-foreground/60">
                    {p.period}
                  </span>
                  <span className="tick shrink-0 font-mono text-[11px] tabular-nums text-foreground/90">
                    {usd(p.value)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {conviction.length > 0 && (
          <div className="rounded-sm border border-border/60 bg-card/40">
            <div className="border-b border-border/60 px-3 py-2">
              <span className="font-mono text-[9px] uppercase tracking-[0.2em] text-muted-foreground">
                Where they overlap
              </span>
            </div>
            <ul className="divide-y divide-border/40">
              {conviction.map((c) => (
                <li key={c.symbol} className="flex items-baseline gap-3 px-3 py-2">
                  <Link
                    href={`/ticker/${c.symbol}`}
                    className="tick w-16 shrink-0 font-mono text-[12px] font-semibold text-foreground hover:text-primary"
                  >
                    {c.symbol}
                  </Link>
                  <span
                    className="min-w-0 flex-1 truncate font-editorial text-[12px] text-muted-foreground"
                    title={c.fundNames.join(", ")}
                  >
                    {c.fundNames.join(", ")}
                  </span>
                  <span className="shrink-0 rounded-sm border border-primary/40 bg-primary/10 px-1.5 py-0.5 font-mono text-[9px] tabular-nums text-primary">
                    {c.funds} funds
                  </span>
                  <span className="tick shrink-0 font-mono text-[11px] tabular-nums text-foreground/90">
                    {usd(c.totalValue)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </section>
  );
}
