import Link from "next/link";
import { ExternalLink } from "lucide-react";
import type {
  InsiderFlowRow,
  ClusterBuyRow,
  FundStakeRow,
  NotableTradeRow,
} from "@/lib/insider/queries";
import { fmtUsd, fmtShares, fmtDay } from "@/components/insider/format";

// Secciones de datos de /insider — todo server components (cero JS cliente).
// Tono terminal: tablas mono densas, verde=compra, rosa=venta, ámbar=stake.

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

function TickerCell({ symbol, name }: { symbol: string; name: string | null }) {
  return (
    <Link
      href={`/ticker/${symbol}`}
      className="group inline-flex min-w-0 items-baseline gap-1.5"
    >
      <span className="tick font-mono text-[12px] font-bold tracking-tight text-foreground group-hover:text-primary">
        {symbol}
      </span>
      {name ? (
        <span className="truncate font-editorial text-[11px] text-muted-foreground/70">
          {name}
        </span>
      ) : null}
    </Link>
  );
}

// --- Flujo neto 7d (dos tablas: net buying / net selling) ------------------

export function InsiderFlowTables({ flow }: { flow: InsiderFlowRow[] }) {
  const buys = flow.filter((r) => r.net_value > 0).slice(0, 10);
  const sells = flow
    .filter((r) => r.net_value < 0)
    .sort((a, b) => a.net_value - b.net_value)
    .slice(0, 10);
  if (!buys.length && !sells.length) return null;

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <FlowTable
        rows={buys}
        title="Net insider buying"
        hint="open market · 7d"
        positive
      />
      <FlowTable
        rows={sells}
        title="Net insider selling"
        hint="open market · 7d"
        positive={false}
      />
    </div>
  );
}

function FlowTable({
  rows,
  title,
  hint,
  positive,
}: {
  rows: InsiderFlowRow[];
  title: string;
  hint: string;
  positive: boolean;
}) {
  return (
    <section>
      <SectionTitle hint={hint}>{title}</SectionTitle>
      {rows.length === 0 ? (
        <p className="font-mono text-[11px] text-muted-foreground/60">
          Nothing in the window.
        </p>
      ) : (
        <div className="overflow-hidden rounded-sm border border-border/60">
          <table className="w-full border-collapse">
            <thead>
              <tr className="border-b border-border/60 bg-card/50 text-left font-mono text-[9px] uppercase tracking-[0.14em] text-muted-foreground/70">
                <th className="px-3 py-1.5 font-medium">Symbol</th>
                <th className="px-3 py-1.5 text-right font-medium">Net</th>
                <th className="hidden px-3 py-1.5 text-right font-medium sm:table-cell">
                  {positive ? "Buyers" : "Sellers"}
                </th>
                <th className="hidden px-3 py-1.5 text-right font-medium md:table-cell">
                  Trades
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.symbol}
                  className="border-b border-border/40 last:border-b-0 hover:bg-foreground/[0.02]"
                >
                  <td className="max-w-0 truncate px-3 py-1.5">
                    <TickerCell symbol={r.symbol} name={r.name} />
                  </td>
                  <td
                    className={`px-3 py-1.5 text-right font-mono text-[12px] tabular-nums ${
                      positive
                        ? "text-emerald-700 dark:text-emerald-300"
                        : "text-rose-700 dark:text-rose-300"
                    }`}
                  >
                    {fmtUsd(r.net_value)}
                  </td>
                  <td className="hidden px-3 py-1.5 text-right font-mono text-[11px] tabular-nums text-muted-foreground sm:table-cell">
                    {positive ? r.buyers : r.sellers}
                  </td>
                  <td className="hidden px-3 py-1.5 text-right font-mono text-[11px] tabular-nums text-muted-foreground/70 md:table-cell">
                    {r.trades}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// --- Cluster buys ----------------------------------------------------------

export function ClusterBuysSection({ clusters }: { clusters: ClusterBuyRow[] }) {
  if (!clusters.length) return null;
  return (
    <section>
      <SectionTitle hint="≥2 distinct insiders buying · 7d">
        Cluster buys
      </SectionTitle>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {clusters.map((c) => (
          <Link
            key={c.symbol}
            href={`/ticker/${c.symbol}`}
            className="group rounded-sm border border-emerald-500/25 bg-emerald-500/[0.04] px-3.5 py-3 transition-colors hover:border-emerald-500/50 hover:bg-emerald-500/[0.08]"
          >
            <div className="mb-1 flex items-center justify-between gap-2">
              <span className="tick font-mono text-sm font-bold tracking-tight text-foreground group-hover:text-primary">
                {c.symbol}
              </span>
              <span className="rounded-sm border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-emerald-700 dark:text-emerald-300">
                {c.buyers} buyers
              </span>
            </div>
            <div className="font-mono text-[11px] tabular-nums text-emerald-700 dark:text-emerald-300">
              {fmtUsd(c.total_value)} bought
            </div>
            <p className="mt-1.5 line-clamp-2 font-editorial text-[11px] leading-snug text-muted-foreground/80">
              {c.owner_names}
            </p>
          </Link>
        ))}
      </div>
    </section>
  );
}

// --- Stakes 13D/G ----------------------------------------------------------

export function FundStakesSection({ stakes }: { stakes: FundStakeRow[] }) {
  if (!stakes.length) return null;
  return (
    <section>
      <SectionTitle hint="5%+ ownership filings · most recent">
        Fund &amp; institutional stakes
      </SectionTitle>
      <div className="overflow-hidden rounded-sm border border-border/60">
        {stakes.map((s) => {
          const activist = s.form_type.includes("13D");
          return (
            <div
              key={s.id}
              className="flex items-center gap-3 border-b border-border/40 px-3 py-2 last:border-b-0 hover:bg-foreground/[0.02]"
            >
              <span
                className={`shrink-0 rounded-sm border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.08em] ${
                  activist
                    ? "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300"
                    : "border-border/60 bg-card/60 text-muted-foreground"
                }`}
                title={activist ? "Active intent (13D)" : "Passive (13G)"}
              >
                {s.form_type}
              </span>
              <div className="min-w-0 flex-1">
                <TickerCell symbol={s.symbol} name={s.name} />
                <div className="truncate font-editorial text-[11.5px] text-foreground/80">
                  {s.filer_name ?? "Filer undisclosed in cover"}
                  {s.percent_of_class != null ? (
                    <span className="ml-1.5 font-mono text-[11px] tabular-nums text-primary">
                      {s.percent_of_class}%
                    </span>
                  ) : null}
                </div>
              </div>
              <span className="hidden shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground/60 sm:inline">
                {fmtDay(s.filed_at)}
              </span>
              <a
                href={s.filing_url}
                target="_blank"
                rel="noopener noreferrer"
                className="shrink-0 text-muted-foreground/50 transition-colors hover:text-primary"
                aria-label={`Open ${s.form_type} filing for ${s.symbol} on sec.gov`}
              >
                <ExternalLink className="h-3.5 w-3.5" />
              </a>
            </div>
          );
        })}
      </div>
    </section>
  );
}

// --- Trades notables -------------------------------------------------------

export function NotableTradesSection({
  trades,
}: {
  trades: NotableTradeRow[];
}) {
  if (!trades.length) return null;
  return (
    <section>
      <SectionTitle hint="largest open-market trades by $ · 7d">
        Notable trades
      </SectionTitle>
      <div className="overflow-hidden rounded-sm border border-border/60">
        {trades.map((t, i) => {
          const buy = t.tx_code === "P";
          const who = t.owner_title
            ? `${t.owner_name} · ${t.owner_title}`
            : t.is_ten_percent
              ? `${t.owner_name} · 10% owner`
              : t.owner_name;
          return (
            <div
              key={`${t.filing_url}-${i}`}
              className="flex items-center gap-3 border-b border-border/40 px-3 py-2 last:border-b-0 hover:bg-foreground/[0.02]"
            >
              <span
                className={`w-11 shrink-0 rounded-sm border px-1.5 py-0.5 text-center font-mono text-[9px] uppercase tracking-[0.08em] ${
                  buy
                    ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                    : "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300"
                }`}
              >
                {buy ? "BUY" : "SELL"}
              </span>
              <div className="min-w-0 flex-1">
                <TickerCell symbol={t.symbol} name={t.name} />
                <div className="truncate font-editorial text-[11.5px] text-foreground/80">
                  {who}
                </div>
              </div>
              <div className="shrink-0 text-right">
                <div
                  className={`font-mono text-[12px] tabular-nums ${
                    buy
                      ? "text-emerald-700 dark:text-emerald-300"
                      : "text-rose-700 dark:text-rose-300"
                  }`}
                >
                  {t.value != null ? fmtUsd(t.value) : "—"}
                </div>
                <div className="font-mono text-[10px] tabular-nums text-muted-foreground/60">
                  {fmtShares(t.shares)}
                  {t.price != null ? ` @ $${t.price.toFixed(2)}` : ""}
                </div>
              </div>
              <span className="hidden w-20 shrink-0 text-right font-mono text-[10px] tabular-nums text-muted-foreground/60 md:inline">
                {fmtDay(t.filed_at)}
              </span>
              <a
                href={t.filing_url}
                target="_blank"
                rel="noopener noreferrer"
                className="shrink-0 text-muted-foreground/50 transition-colors hover:text-primary"
                aria-label={`Open Form 4 filing for ${t.symbol} on sec.gov`}
              >
                <ExternalLink className="h-3.5 w-3.5" />
              </a>
            </div>
          );
        })}
      </div>
    </section>
  );
}
