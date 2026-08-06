import Link from "next/link";
import { MessageSquareQuote, TriangleAlert } from "lucide-react";
import type { AuthorBriefRow } from "@/lib/ai/author-brief";
import type { AuthorTrackRecord } from "@/lib/signals/queries";
import type { CompactQuote } from "@/lib/providers/finnhub";

// Author Watch — "super sección" arriba del feed. Fusión diaria de lo que el
// autor seguido dijo en X con nuestro tape de noticias de esos tickers.
// Server component, mismo patrón <details> que los otros paneles IA.

function pct(n: number | null | undefined): string {
  if (n == null) return "—";
  return `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`;
}

/** El track record del autor, medido por el Lab con su misma aritmética.
 *  Va DENTRO del panel del autor y no solo en /lab: el sitio donde decides
 *  cuánto peso darle a lo que dice es donde lo estás leyendo. */
function AuthorRecordStrip({ record }: { record: AuthorTrackRecord }) {
  const s7 = record.stats.find((s) => s.horizon === 7);
  const s30 = record.stats.find((s) => s.horizon === 30);
  if (!s7 && !s30) return null;
  const n = Math.max(s7?.n ?? 0, s30?.n ?? 0);
  return (
    <div className="mt-3 flex flex-wrap items-baseline gap-x-4 gap-y-1 rounded-sm border border-border/50 bg-card/40 px-3 py-1.5">
      <Link
        href="/lab"
        className="font-mono text-[9px] uppercase tracking-[0.16em] text-muted-foreground/70 hover:text-primary"
      >
        His measured calls →
      </Link>
      {s7 ? (
        <span className="font-mono text-[10.5px] tabular-nums text-muted-foreground">
          7d {pct(s7.avg_return)}{" "}
          <span className="text-muted-foreground/60">
            (vs SPY {pct(s7.avg_excess)})
          </span>
        </span>
      ) : null}
      {s30 ? (
        <span className="font-mono text-[10.5px] tabular-nums text-muted-foreground">
          30d {pct(s30.avg_return)}{" "}
          <span className="text-muted-foreground/60">
            (vs SPY {pct(s30.avg_excess)})
          </span>
        </span>
      ) : null}
      <span
        className={`font-mono text-[9.5px] tabular-nums ${n < 20 ? "text-amber-700/80 dark:text-amber-300/80" : "text-muted-foreground/60"}`}
      >
        n={n}
        {n < 20 ? " · small n" : ""}
      </span>
      {record.recent.length ? (
        <span className="min-w-0 flex-1 truncate text-right font-mono text-[10px] tabular-nums text-muted-foreground/60">
          {record.recent
            .map((r) => `${r.symbol} ${pct(r.r7 ?? r.r1)}`)
            .join(" · ")}
        </span>
      ) : null}
    </div>
  );
}

export function AuthorPanel({
  brief,
  handle,
  quotes,
  trackRecord = null,
}: {
  brief: AuthorBriefRow | null;
  handle: string;
  quotes: Record<string, CompactQuote | null>;
  trackRecord?: AuthorTrackRecord | null;
}) {
  if (!brief) return null;
  const modelShort =
    brief.model.split("/").pop()?.replace(/:free$/, "") ?? brief.model;

  return (
    <details className="group border-b border-border/40 bg-gradient-to-b from-primary/[0.04] to-transparent" open>
      <summary className="flex cursor-pointer select-none items-center gap-2 px-6 py-2 hover:bg-foreground/[0.02] [&::-webkit-details-marker]:hidden">
        <MessageSquareQuote className="h-3.5 w-3.5 text-primary" aria-hidden />
        <span className="eyebrow text-[10px] text-foreground">
          Author Watch · @{handle}
        </span>
        <span className="font-mono text-[10px] text-muted-foreground/70">
          {brief.coveredDate} · {brief.content.stocks.length} stocks ·{" "}
          {modelShort}
        </span>
        <span className="ml-auto font-mono text-[10px] uppercase tracking-widest text-muted-foreground/60 group-open:hidden">
          expand
        </span>
        <span className="ml-auto hidden font-mono text-[10px] uppercase tracking-widest text-muted-foreground/60 group-open:inline">
          collapse
        </span>
      </summary>
      <div className="px-6 pb-4 pt-1">
        <p className="mb-3 border-l-2 border-primary/60 pl-3 font-editorial text-[13.5px] italic leading-relaxed text-foreground/90">
          {brief.content.intro}
        </p>
        {brief.content.stocks.length > 0 && (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {brief.content.stocks.map((s) => {
              const q = quotes[s.symbol];
              return (
                <Link
                  key={s.symbol}
                  href={`/ticker/${s.symbol}`}
                  className="group/card rounded-sm border border-border/60 bg-card/50 px-3.5 py-3 transition-colors hover:border-primary/50 hover:bg-card/80"
                >
                  <div className="mb-1.5 flex items-center justify-between gap-2">
                    <span className="tick font-mono text-sm font-bold tracking-tight text-foreground group-hover/card:text-primary">
                      {s.symbol}
                    </span>
                    {q ? (
                      <span
                        className={`tick rounded-sm border px-1.5 py-0.5 font-mono text-[10px] tabular-nums ${
                          q.changePercent >= 0
                            ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                            : "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300"
                        }`}
                      >
                        {q.changePercent >= 0 ? "+" : ""}
                        {q.changePercent.toFixed(2)}%
                      </span>
                    ) : null}
                  </div>
                  <div className="space-y-1.5">
                    <div>
                      <span className="eyebrow-sm mr-1.5 text-primary/80">
                        author
                      </span>
                      <span className="font-editorial text-[12.5px] leading-relaxed text-foreground/90">
                        {s.authorTake}
                      </span>
                    </div>
                    <div>
                      <span className="eyebrow-sm mr-1.5 text-muted-foreground/70">
                        our tape
                      </span>
                      <span className="font-editorial text-[12.5px] leading-relaxed text-foreground/75">
                        {s.tapeContext}
                      </span>
                    </div>
                    {s.divergence ? (
                      <div className="flex items-start gap-1.5 border-l-2 border-amber-500/50 pl-2 pt-0.5">
                        <TriangleAlert className="mt-0.5 h-3 w-3 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />
                        <span className="font-editorial text-[11.5px] leading-snug text-amber-700 dark:text-amber-300/90">
                          {s.divergence}
                        </span>
                      </div>
                    ) : null}
                  </div>
                </Link>
              );
            })}
          </div>
        )}
        {trackRecord ? <AuthorRecordStrip record={trackRecord} /> : null}
        <div className="mt-2.5 font-mono text-[9px] uppercase tracking-[0.16em] text-muted-foreground/50">
          Author&rsquo;s public posts, fused with our news tape · not investment advice
        </div>
      </div>
    </details>
  );
}
