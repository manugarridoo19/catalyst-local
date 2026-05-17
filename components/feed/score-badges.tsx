import { cn } from "@/lib/utils";

// Pareja de pills LABELED — significance + sentiment con la nota grande.
// La idea: dos chips sólidos uno encima del otro, con label tiny en uppercase
// y el número grande monospace tabular. Al ojo se lee: "ESTO ES IMPORTANTE",
// no como las antiguas barritas que pasaban desapercibidas.

function impactTone(value: number): string {
  if (value >= 5) return "bg-primary text-primary-foreground border-primary shadow-[0_0_14px_oklch(0.78_0.13_75/0.55)]";
  if (value >= 4) return "bg-primary/30 text-primary border-primary/60";
  if (value >= 3) return "bg-amber-500/15 text-amber-200 border-amber-500/40";
  return "bg-card/60 text-muted-foreground border-border";
}

function sentimentTone(value: number): string {
  if (value >= 4) return "bg-emerald-500/30 text-emerald-100 border-emerald-500/60 shadow-[0_0_14px_rgb(16_185_129/0.4)]";
  if (value >= 2) return "bg-emerald-500/15 text-emerald-200 border-emerald-500/40";
  if (value <= -4) return "bg-rose-500/30 text-rose-100 border-rose-500/60 shadow-[0_0_14px_rgb(244_63_94/0.4)]";
  if (value <= -2) return "bg-rose-500/15 text-rose-200 border-rose-500/40";
  return "bg-card/60 text-muted-foreground border-border";
}

type Size = "sm" | "md";

const SIZE: Record<
  Size,
  { padding: string; label: string; value: string; gap: string; pill: string }
> = {
  sm: {
    padding: "px-2 py-0.5",
    label: "text-[8px]",
    value: "text-xs",
    gap: "gap-1",
    pill: "min-w-[58px]",
  },
  md: {
    padding: "px-2.5 py-1",
    label: "text-[9px]",
    value: "text-base",
    gap: "gap-1.5",
    pill: "min-w-[78px]",
  },
};

export function ImpactBadge({
  value,
  size = "md",
}: {
  value: number | null;
  size?: Size;
}) {
  const s = SIZE[size];
  if (value == null) {
    return (
      <div
        className={cn(
          "tick flex items-center justify-between rounded-md border bg-card/30 font-mono uppercase animate-pulse",
          s.padding,
          s.gap,
          s.pill,
        )}
        title="Pending grading"
      >
        <span className={cn("tracking-[0.18em] text-muted-foreground/50", s.label)}>
          Signif
        </span>
        <span className={cn("tabular-nums text-muted-foreground/50 font-bold", s.value)}>
          …
        </span>
      </div>
    );
  }
  const tone = impactTone(value);
  return (
    <div
      className={cn(
        "tick flex items-center justify-between rounded-md border font-mono uppercase",
        s.padding,
        s.gap,
        s.pill,
        tone,
      )}
      title={`Significance ${value}/5`}
      aria-label={`Significance ${value} of 5`}
    >
      <span className={cn("font-semibold tracking-[0.18em] opacity-70", s.label)}>
        Signif
      </span>
      <span className={cn("font-bold tabular-nums", s.value)}>{value}</span>
    </div>
  );
}

export function SentimentBadge({
  value,
  size = "md",
}: {
  value: number | null;
  size?: Size;
}) {
  const s = SIZE[size];
  if (value == null) {
    return (
      <div
        className={cn(
          "tick flex items-center justify-between rounded-md border bg-card/30 font-mono uppercase animate-pulse",
          s.padding,
          s.gap,
          s.pill,
        )}
        title="Pending grading"
      >
        <span className={cn("tracking-[0.18em] text-muted-foreground/50", s.label)}>
          Sent
        </span>
        <span className={cn("tabular-nums text-muted-foreground/50 font-bold", s.value)}>
          …
        </span>
      </div>
    );
  }
  const tone = sentimentTone(value);
  const sign = value > 0 ? "+" : "";
  return (
    <div
      className={cn(
        "tick flex items-center justify-between rounded-md border font-mono uppercase",
        s.padding,
        s.gap,
        s.pill,
        tone,
      )}
      title={`Sentiment ${sign}${value}`}
      aria-label={`Sentiment ${sign}${value}`}
    >
      <span className={cn("font-semibold tracking-[0.18em] opacity-70", s.label)}>
        Sent
      </span>
      <span className={cn("font-bold tabular-nums", s.value)}>
        {sign}
        {value}
      </span>
    </div>
  );
}
