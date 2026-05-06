import { cn } from "@/lib/utils";

// Impact 1-5: barra de 5 segmentos. Más segmentos llenos = más relevante.
export function ImpactBadge({ value }: { value: number | null }) {
  if (value == null) {
    return (
      <span className="font-mono text-xs text-muted-foreground">—</span>
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
            "h-2 w-1.5 rounded-sm",
            i < filled ? "bg-amber-400/90" : "bg-muted",
          )}
        />
      ))}
    </div>
  );
}

// Sentiment -5..+5: pill verde/rojo/ámbar con el número.
export function SentimentBadge({ value }: { value: number | null }) {
  if (value == null) {
    return (
      <span className="font-mono text-xs text-muted-foreground">—</span>
    );
  }
  const tone =
    value >= 2
      ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/30"
      : value <= -2
        ? "bg-rose-500/15 text-rose-300 border-rose-500/30"
        : "bg-zinc-500/15 text-zinc-300 border-zinc-500/30";
  const sign = value > 0 ? "+" : "";
  return (
    <span
      className={cn(
        "inline-flex items-center justify-center rounded border px-1.5 py-0.5 font-mono text-[11px] font-semibold tabular-nums",
        tone,
      )}
      title={`Sentiment ${sign}${value}`}
    >
      {sign}
      {value}
    </span>
  );
}
