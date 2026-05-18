import { cn } from "@/lib/utils";

// Impact (1-5) → 5-dot scale. Reads at a glance in dense feeds; the eye
// counts filled vs. empty dots faster than parsing a numeric pill.
// Sentiment (-5..+5) → divergent horizontal bar diverging from a center
// rule. Direction (left/right) and magnitude (width) are encoded
// spatially; no parsing required.

type Size = "sm" | "md";

const IMPACT_DOT_SIZE: Record<Size, string> = {
  sm: "h-[5px] w-[5px]",
  md: "h-1.5 w-1.5",
};

const IMPACT_GAP: Record<Size, string> = {
  sm: "gap-[3px]",
  md: "gap-[3px]",
};

function impactFill(level: number, value: number, isPending: boolean): string {
  if (isPending) {
    return "bg-muted-foreground/15";
  }
  if (level > value) {
    return "bg-muted-foreground/15";
  }
  if (value >= 5) return "bg-primary";
  if (value >= 4) return "bg-primary/85";
  if (value >= 3) return "bg-amber-300/85";
  return "bg-muted-foreground/55";
}

export function ImpactBadge({
  value,
  size = "md",
}: {
  value: number | null;
  size?: Size;
}) {
  const isPending = value == null;
  const v = value ?? 0;
  const label =
    isPending
      ? "Pending grading"
      : `Significance ${v} of 5`;

  return (
    <div
      className={cn(
        "inline-flex items-center",
        IMPACT_GAP[size],
        isPending && "animate-pulse",
      )}
      aria-label={label}
      title={label}
    >
      {[1, 2, 3, 4, 5].map((level) => (
        <span
          key={level}
          className={cn(
            "rounded-[1px] transition-colors duration-200",
            IMPACT_DOT_SIZE[size],
            impactFill(level, v, isPending),
            !isPending && level <= v && v >= 4 && "shadow-[0_0_5px_oklch(0.78_0.13_75/0.55)]",
          )}
        />
      ))}
    </div>
  );
}

// Divergent sentiment bar. -5 …  0  … +5
// Width:
//   sm = 56px total, 28px per side
//   md = 72px total, 36px per side
const SENT_TRACK: Record<Size, string> = {
  sm: "w-14",
  md: "w-[72px]",
};

const SENT_BAR_HEIGHT: Record<Size, string> = {
  sm: "h-1",
  md: "h-1.5",
};

export function SentimentBadge({
  value,
  size = "md",
}: {
  value: number | null;
  size?: Size;
}) {
  const isPending = value == null;
  const v = value ?? 0;
  const abs = Math.min(Math.abs(v), 5);
  const fillPct = (abs / 5) * 100;
  const isPositive = v > 0;
  const isNegative = v < 0;
  const sign = v > 0 ? "+" : "";

  // Tone tier — extreme values get a fuller chroma; mid values are
  // muted; zero/null is neutral track only.
  const fillColor = isPending
    ? "bg-muted-foreground/25"
    : isPositive
      ? abs >= 4
        ? "bg-emerald-400"
        : "bg-emerald-400/70"
      : isNegative
        ? abs >= 4
          ? "bg-rose-400"
          : "bg-rose-400/70"
        : "bg-muted-foreground/40";

  return (
    <div
      className={cn(
        "inline-flex flex-col items-end gap-1",
        isPending && "animate-pulse",
      )}
      aria-label={isPending ? "Sentiment pending" : `Sentiment ${sign}${v}`}
      title={isPending ? "Pending grading" : `Sentiment ${sign}${v} of ±5`}
    >
      <div
        className={cn(
          "tick font-mono text-[11px] font-bold tabular-nums leading-none",
          isPending && "text-muted-foreground/40",
          !isPending && isPositive && "text-emerald-300",
          !isPending && isNegative && "text-rose-300",
          !isPending && v === 0 && "text-muted-foreground",
        )}
      >
        {isPending ? "—" : `${sign}${v}`}
      </div>
      <div
        className={cn(
          "relative grid grid-cols-2 overflow-hidden rounded-full bg-border/40",
          SENT_TRACK[size],
          SENT_BAR_HEIGHT[size],
        )}
      >
        {/* Negative side fill (right-anchored, fills leftward) */}
        <div className="relative overflow-hidden">
          {isNegative && (
            <div
              style={
                {
                  width: `${fillPct}%`,
                  "--bar-origin": "right",
                } as React.CSSProperties
              }
              className={cn(
                "bar-fill absolute right-0 top-0 h-full rounded-l-full",
                fillColor,
              )}
            />
          )}
        </div>
        {/* Positive side fill (left-anchored, fills rightward) */}
        <div className="relative overflow-hidden">
          {isPositive && (
            <div
              style={
                {
                  width: `${fillPct}%`,
                  "--bar-origin": "left",
                } as React.CSSProperties
              }
              className={cn(
                "bar-fill absolute left-0 top-0 h-full rounded-r-full",
                fillColor,
              )}
            />
          )}
        </div>
        {/* Center axis */}
        <div className="pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-background/80" />
      </div>
    </div>
  );
}
