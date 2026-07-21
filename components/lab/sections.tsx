import Link from "next/link";
import type { SignalStatRow, RecentSignalRow } from "@/lib/signals/queries";
import {
  KIND_SPECS,
  MIN_SAMPLE,
  HORIZONS,
  kindLabel,
  type SignalKind,
} from "@/lib/signals/kinds";

// Secciones del Signal Lab — server components puros (cero JS cliente, cero
// LLM). Tono terminal como /insider: mono denso, verde arriba, rosa abajo.

function pct(n: number | null): string {
  if (n == null) return "—";
  return `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`;
}

function toneClass(n: number | null): string {
  if (n == null) return "text-muted-foreground/60";
  if (n > 0) return "text-emerald-700 dark:text-emerald-300";
  if (n < 0) return "text-rose-700 dark:text-rose-300";
  return "text-muted-foreground";
}

function SectionTitle({
  children,
  hint,
}: {
  children: React.ReactNode;
  hint?: string;
}) {
  return (
    <div className="mb-2 flex items-baseline gap-2.5">
      <h2 className="eyebrow text-[10px] text-foreground">{children}</h2>
      {hint ? (
        <span className="font-mono text-[9px] uppercase tracking-[0.14em] text-muted-foreground/50">
          {hint}
        </span>
      ) : null}
    </div>
  );
}

// --- Marcador por tipo de señal -------------------------------------------

export function ScoreboardSection({ stats }: { stats: SignalStatRow[] }) {
  const kinds = (Object.keys(KIND_SPECS) as SignalKind[]).filter((k) =>
    stats.some((s) => s.kind === k),
  );
  if (!kinds.length) return null;

  return (
    <section>
      <SectionTitle hint="close-to-close · adjusted · vs SPY">
        Track record by signal
      </SectionTitle>
      <div className="grid gap-4 lg:grid-cols-2">
        {kinds.map((kind) => (
          <KindCard
            key={kind}
            kind={kind}
            rows={stats.filter((s) => s.kind === kind)}
          />
        ))}
      </div>
    </section>
  );
}

function KindCard({ kind, rows }: { kind: SignalKind; rows: SignalStatRow[] }) {
  const spec = KIND_SPECS[kind];
  // La muestra del horizonte más corto es la mayor (los largos aún maduran).
  const maxN = Math.max(...rows.map((r) => r.n), 0);
  const thin = maxN < MIN_SAMPLE;

  return (
    <div className="overflow-hidden rounded-sm border border-border/60">
      <div className="flex items-baseline justify-between gap-2 border-b border-border/60 bg-card/50 px-3 py-2">
        <div className="min-w-0">
          <span className="font-mono text-[12px] font-bold tracking-tight text-foreground">
            {spec.label}
          </span>
          <p className="mt-0.5 truncate font-editorial text-[11px] text-muted-foreground/70">
            {spec.description}
          </p>
        </div>
        {thin ? (
          // Un aviso, no un adorno: con n<20 la media se mueve entera con una
          // sola señal afortunada. Mejor decirlo que dejar leer una cifra
          // precisa que no lo es.
          <span className="shrink-0 rounded-sm border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.12em] text-amber-700 dark:text-amber-300">
            small n
          </span>
        ) : null}
      </div>
      <table className="w-full border-collapse">
        <thead>
          <tr className="border-b border-border/50 text-left font-mono text-[9px] uppercase tracking-[0.14em] text-muted-foreground/70">
            <th className="px-3 py-1.5 font-medium">Horizon</th>
            <th className="px-3 py-1.5 text-right font-medium">N</th>
            <th className="px-3 py-1.5 text-right font-medium">Avg</th>
            <th className="hidden px-3 py-1.5 text-right font-medium sm:table-cell">
              Median
            </th>
            <th className="px-3 py-1.5 text-right font-medium">vs SPY</th>
            <th className="hidden px-3 py-1.5 text-right font-medium md:table-cell">
              Positive
            </th>
            <th className="hidden px-3 py-1.5 text-right font-medium md:table-cell">
              Beat SPY
            </th>
          </tr>
        </thead>
        <tbody>
          {HORIZONS.map((h) => {
            const r = rows.find((x) => x.horizon === h);
            return (
              <tr
                key={h}
                className="border-b border-border/40 last:border-b-0 hover:bg-foreground/[0.02]"
              >
                <td className="px-3 py-1.5 font-mono text-[11px] text-muted-foreground">
                  {h}d
                </td>
                <td className="px-3 py-1.5 text-right font-mono text-[11px] tabular-nums text-muted-foreground/70">
                  {r?.n ?? "—"}
                </td>
                <td
                  className={`px-3 py-1.5 text-right font-mono text-[12px] tabular-nums ${toneClass(r?.avg_return ?? null)}`}
                >
                  {pct(r?.avg_return ?? null)}
                </td>
                <td
                  className={`hidden px-3 py-1.5 text-right font-mono text-[11px] tabular-nums sm:table-cell ${toneClass(r?.median_return ?? null)}`}
                >
                  {pct(r?.median_return ?? null)}
                </td>
                <td
                  className={`px-3 py-1.5 text-right font-mono text-[12px] tabular-nums ${toneClass(r?.avg_excess ?? null)}`}
                >
                  {pct(r?.avg_excess ?? null)}
                </td>
                <td className="hidden px-3 py-1.5 text-right font-mono text-[11px] tabular-nums text-muted-foreground md:table-cell">
                  {r ? `${r.hit_rate.toFixed(0)}%` : "—"}
                </td>
                <td className="hidden px-3 py-1.5 text-right font-mono text-[11px] tabular-nums text-muted-foreground md:table-cell">
                  {r?.beat_rate != null ? `${r.beat_rate.toFixed(0)}%` : "—"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// --- Últimas señales medidas ----------------------------------------------

export function RecentSignalsSection({ rows }: { rows: RecentSignalRow[] }) {
  if (!rows.length) return null;
  return (
    <section>
      <SectionTitle hint="most recent with a measured outcome">
        Signal log
      </SectionTitle>
      <div className="overflow-hidden rounded-sm border border-border/60">
        <table className="w-full border-collapse">
          <thead>
            <tr className="border-b border-border/60 bg-card/50 text-left font-mono text-[9px] uppercase tracking-[0.14em] text-muted-foreground/70">
              <th className="px-3 py-1.5 font-medium">Detected</th>
              <th className="px-3 py-1.5 font-medium">Signal</th>
              <th className="px-3 py-1.5 font-medium">Symbol</th>
              <th className="px-3 py-1.5 text-right font-medium">1d</th>
              <th className="px-3 py-1.5 text-right font-medium">7d</th>
              <th className="px-3 py-1.5 text-right font-medium">30d</th>
              <th className="hidden px-3 py-1.5 text-right font-medium md:table-cell">
                SPY 7d
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.id}
                className="border-b border-border/40 last:border-b-0 hover:bg-foreground/[0.02]"
              >
                <td className="px-3 py-1.5 font-mono text-[11px] tabular-nums text-muted-foreground/70">
                  {new Date(r.detected_at).toISOString().slice(0, 10)}
                </td>
                <td className="px-3 py-1.5 font-mono text-[11px] text-muted-foreground">
                  {kindLabel(r.kind)}
                </td>
                <td className="max-w-0 truncate px-3 py-1.5">
                  <Link
                    href={`/ticker/${r.symbol}`}
                    className="group inline-flex min-w-0 items-baseline gap-1.5"
                  >
                    <span className="tick font-mono text-[12px] font-bold tracking-tight text-foreground group-hover:text-primary">
                      {r.symbol}
                    </span>
                    {r.name ? (
                      <span className="truncate font-editorial text-[11px] text-muted-foreground/70">
                        {r.name}
                      </span>
                    ) : null}
                  </Link>
                </td>
                <td
                  className={`px-3 py-1.5 text-right font-mono text-[11px] tabular-nums ${toneClass(r.r1)}`}
                >
                  {pct(r.r1)}
                </td>
                <td
                  className={`px-3 py-1.5 text-right font-mono text-[12px] tabular-nums ${toneClass(r.r7)}`}
                >
                  {pct(r.r7)}
                </td>
                <td
                  className={`px-3 py-1.5 text-right font-mono text-[11px] tabular-nums ${toneClass(r.r30)}`}
                >
                  {pct(r.r30)}
                </td>
                <td className="hidden px-3 py-1.5 text-right font-mono text-[11px] tabular-nums text-muted-foreground/60 md:table-cell">
                  {pct(r.b7)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// --- Cabecera de totales ---------------------------------------------------

export function LabTotalsStrip({
  events,
  measured,
  pending,
  since,
  lastFilled,
}: {
  events: number;
  measured: number;
  pending: number;
  since: string | Date | null;
  lastFilled: string | Date | null;
}) {
  const items: Array<[string, string]> = [
    ["Signals recorded", String(events)],
    ["Measured", String(measured)],
    ["Awaiting price", String(pending)],
    [
      "Archive since",
      since ? new Date(since).toISOString().slice(0, 10) : "—",
    ],
    [
      "Last measured",
      lastFilled ? new Date(lastFilled).toISOString().slice(0, 10) : "—",
    ],
  ];
  return (
    <div className="flex flex-wrap gap-x-6 gap-y-2 rounded-sm border border-border/60 bg-card/40 px-4 py-2.5">
      {items.map(([label, value]) => (
        <div key={label} className="flex items-baseline gap-2">
          <span className="font-mono text-[9px] uppercase tracking-[0.14em] text-muted-foreground/60">
            {label}
          </span>
          <span className="tick font-mono text-[12px] tabular-nums text-foreground">
            {value}
          </span>
        </div>
      ))}
    </div>
  );
}
