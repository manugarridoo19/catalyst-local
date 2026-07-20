import Link from "next/link";
import { Landmark } from "lucide-react";
import type { InsiderDigestRow, InsiderHighlight } from "@/lib/ai/insider-digest";

// Smart Money digest — franja IA arriba de /insider: la lectura LLM de los
// agregados de 7d (dónde compran los insiders, cluster buys, stakes 13D/G).
// Server component puro, mismo patrón <details> que BriefPanel/PicksPanel.
// Framing "as filed with the SEC" — hechos regulatorios, no recomendación.

const KIND_META: Record<
  InsiderHighlight["kind"],
  { label: string; tone: string }
> = {
  cluster_buy: {
    label: "CLUSTER BUY",
    tone: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  },
  net_buy: {
    label: "NET BUY",
    tone: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  },
  net_sell: {
    label: "NET SELL",
    tone: "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300",
  },
  stake: {
    label: "NEW STAKE",
    tone: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  },
};

export function InsiderDigestPanel({
  digest,
}: {
  digest: InsiderDigestRow | null;
}) {
  if (!digest) return null;
  const hhmm = digest.generatedAt.toISOString().slice(11, 16);
  const modelShort =
    digest.model.split("/").pop()?.replace(/:free$/, "") ?? digest.model;

  return (
    <details className="group border-b border-border/40 bg-card/30" open>
      <summary className="flex cursor-pointer select-none items-center gap-2 px-6 py-2 hover:bg-foreground/[0.02] [&::-webkit-details-marker]:hidden">
        <Landmark className="h-3.5 w-3.5 text-primary" aria-hidden />
        <span className="eyebrow text-[10px] text-foreground">
          Smart Money digest · 7-day read
        </span>
        <span className="font-mono text-[10px] text-muted-foreground/70">
          {hhmm}Z · {modelShort}
        </span>
        <span className="hidden font-mono text-[9px] uppercase tracking-[0.18em] text-muted-foreground/50 sm:inline">
          as filed with the SEC — not investment advice
        </span>
        <span className="ml-auto font-mono text-[10px] uppercase tracking-widest text-muted-foreground/60 group-open:hidden">
          expand
        </span>
        <span className="ml-auto hidden font-mono text-[10px] uppercase tracking-widest text-muted-foreground/60 group-open:inline">
          collapse
        </span>
      </summary>
      <div className="px-6 pb-4 pt-1">
        <p className="max-w-4xl font-editorial text-[13.5px] leading-relaxed text-foreground/90">
          {digest.content.overview}
        </p>
        {digest.content.highlights.length > 0 && (
          <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {digest.content.highlights.map((h, i) => {
              const meta = KIND_META[h.kind];
              return (
                <Link
                  key={`${h.symbol}-${i}`}
                  href={`/ticker/${h.symbol}`}
                  className="group/card rounded-sm border border-border/60 bg-card/40 px-3.5 py-2.5 transition-colors hover:border-primary/50 hover:bg-card/70"
                >
                  <div className="mb-1 flex items-center gap-2">
                    <span className="tick font-mono text-[13px] font-bold tracking-tight text-foreground group-hover/card:text-primary">
                      {h.symbol}
                    </span>
                    <span
                      className={`rounded-sm border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.08em] ${meta.tone}`}
                    >
                      {meta.label}
                    </span>
                  </div>
                  <p className="font-editorial text-[12px] leading-snug text-foreground/85">
                    {h.note}
                  </p>
                </Link>
              );
            })}
          </div>
        )}
      </div>
    </details>
  );
}
