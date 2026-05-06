import { cn } from "@/lib/utils";

// Impact 1-5: barra de 5 segmentos. Más segmentos llenos = más relevante.
export function ImpactBadge({ value }: { value: number | null }) {
  if (value == null) {
    return (
      <div className="flex items-center gap-0.5" title="not scored">
        {Array.from({ length: 5 }).map((_, i) => (
          <span
            key={i}
            className="h-2 w-1.5 rounded-[1px] bg-border/60"
          />
        ))}
      </div>
    );
  }
  const filled = Math.max(0, Math.min(5, value));
  return (
    <div
      className="flex items-center gap-0.5"
      title={`Impact ${value}/5`}
      aria-label={`Impact ${value} of 5`}
    >
      {Array.from({ length: 5 }).map((_, i) => (
        <span
          key={i}
          className={cn(
            "h-2 w-1.5 rounded-[1px] transition-colors",
            i < filled
              ? value >= 4
                ? "bg-primary shadow-[0_0_6px_oklch(0.78_0.13_75/0.5)]"
                : "bg-primary/85"
              : "bg-border/60",
          )}
        />
      ))}
    </div>
  );
}

// Sentiment -5..+5: pill verde/rojo/neutral con el número.
export function SentimentBadge({ value }: { value: number | null }) {
  if (value == null) {
    return (
      <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground/60">
        ——
      </span>
    );
  }
  const tone =
    value >= 2
      ? "bg-emerald-500/10 text-emerald-300 border-emerald-500/30"
      : value <= -2
        ? "bg-rose-500/10 text-rose-300 border-rose-500/30"
        : "bg-card/60 text-muted-foreground border-border";
  const sign = value > 0 ? "+" : "";
  return (
    <span
      className={cn(
        "tick inline-flex min-w-[2.4ch] items-center justify-center rounded-sm border px-1.5 py-0.5 font-mono text-[11px] font-semibold",
        tone,
      )}
      title={`Sentiment ${sign}${value}`}
    >
      {sign}
      {value}
    </span>
  );
}
