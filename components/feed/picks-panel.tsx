import Link from "next/link";
import { TrendingUp, Eye } from "lucide-react";
import type { PicksRow } from "@/lib/ai/picks";
import type { CompactQuote } from "@/lib/providers/finnhub";

// AI Picks v2 — franja colapsable bajo el AI Brief: stocks donde el flujo
// de noticias está CONSTRUYENDO momentum (cobertura acelerando, catalizadores
// apilándose, insider buying) — candidatos de watchlist a futuro, no lo que
// ya explotó hoy. Server component puro, mismo patrón <details> que
// BriefPanel. Framing SIEMPRE "as reported" — es lo que dice el tape, no
// una recomendación nuestra.

export function PicksPanel({
  picks,
  quotes,
}: {
  picks: PicksRow | null;
  quotes: Record<string, CompactQuote | null>;
}) {
  if (!picks || picks.picks.length === 0) return null;
  const hhmm = picks.generatedAt.toISOString().slice(11, 16);
  const modelShort =
    picks.model.split("/").pop()?.replace(/:free$/, "") ?? picks.model;

  return (
    <details className="group border-b border-border/40 bg-card/30" open>
      <summary className="flex cursor-pointer select-none items-center gap-2 px-6 py-2 hover:bg-foreground/[0.02] [&::-webkit-details-marker]:hidden">
        <TrendingUp className="h-3.5 w-3.5 text-primary" aria-hidden />
        <span className="eyebrow text-[10px] text-foreground">
          AI Picks · momentum building
        </span>
        <span className="font-mono text-[10px] text-muted-foreground/70">
          {hhmm}Z · {modelShort}
        </span>
        <span className="hidden font-mono text-[9px] uppercase tracking-[0.18em] text-muted-foreground/50 sm:inline">
          watchlist candidates from the tape — not investment advice
        </span>
        <span className="ml-auto font-mono text-[10px] uppercase tracking-widest text-muted-foreground/60 group-open:hidden">
          expand
        </span>
        <span className="ml-auto hidden font-mono text-[10px] uppercase tracking-widest text-muted-foreground/60 group-open:inline">
          collapse
        </span>
      </summary>
      <div className="grid gap-3 px-6 pb-4 pt-1 sm:grid-cols-2 xl:grid-cols-3">
        {picks.picks.map((p) => {
          const q = quotes[p.symbol];
          return (
            <Link
              key={p.symbol}
              href={`/ticker/${p.symbol}`}
              className="group/card rounded-sm border border-border/60 bg-card/40 px-3.5 py-3 transition-colors hover:border-primary/50 hover:bg-card/70"
            >
              <div className="mb-1.5 flex items-center justify-between gap-2">
                <span className="tick font-mono text-sm font-bold tracking-tight text-foreground group-hover/card:text-primary">
                  {p.symbol}
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
              <p className="font-editorial text-[12.5px] leading-relaxed text-foreground/90">
                {p.thesis}
              </p>
              {p.momentum ? (
                <p className="mt-1.5 font-mono text-[10.5px] leading-snug text-primary/90">
                  <TrendingUp
                    className="mr-1 inline h-3 w-3 align-[-0.15em]"
                    aria-hidden
                  />
                  {p.momentum}
                </p>
              ) : null}
              {p.catalysts.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1">
                  {p.catalysts.map((c, i) => (
                    <span
                      key={i}
                      className="rounded-sm border border-border/50 bg-card/60 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.08em] text-muted-foreground"
                    >
                      {c}
                    </span>
                  ))}
                </div>
              )}
              {p.watchFor ? (
                <p className="mt-2 font-mono text-[10.5px] leading-snug text-muted-foreground">
                  <Eye
                    className="mr-1 inline h-3 w-3 align-[-0.15em] text-primary/70"
                    aria-hidden
                  />
                  <span className="uppercase tracking-[0.1em] text-muted-foreground/70">
                    Watch:
                  </span>{" "}
                  {p.watchFor}
                </p>
              ) : null}
              {p.caution ? (
                <p className="mt-2 border-l-2 border-amber-500/50 pl-2 font-editorial text-[11.5px] leading-snug text-amber-700 dark:text-amber-300/90">
                  {p.caution}
                </p>
              ) : null}
            </Link>
          );
        })}
      </div>
    </details>
  );
}
