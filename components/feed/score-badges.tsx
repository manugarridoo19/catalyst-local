import { cn } from "@/lib/utils";

// Impact 1-5: barra vertical de 5 segmentos, ascendente (más alto = más
// segmentos llenos). Glow ámbar cuando impact ≥ 4.
export function ImpactBadge({
  value,
  size = "md",
}: {
  value: number | null;
  size?: "sm" | "md";
}) {
  const segHeight = size === "sm" ? "h-2" : "h-3";
  const segWidth = size === "sm" ? "w-1" : "w-1.5";
  if (value == null) {
    return (
      <div className="flex items-end gap-0.5" title="not scored">
        {Array.from({ length: 5 }).map((_, i) => (
          <span
            key={i}
            className={cn(segWidth, "rounded-[1px] bg-border/50", segHeight)}
            style={{ height: `${(i + 1) * 20}%`, minHeight: "3px" }}
          />
        ))}
      </div>
    );
  }
  const filled = Math.max(0, Math.min(5, value));
  const isHigh = filled >= 4;
  return (
    <div
      className="flex items-end gap-0.5"
      title={`Impact ${value}/5`}
      aria-label={`Impact ${value} of 5`}
    >
      {Array.from({ length: 5 }).map((_, i) => (
        <span
          key={i}
          className={cn(
            segWidth,
            "rounded-[1px] transition-colors",
            i < filled
              ? isHigh
                ? "bg-primary shadow-[0_0_8px_oklch(0.78_0.13_75/0.6)]"
                : "bg-primary/85"
              : "bg-border/40",
          )}
          style={{
            height: `${(i + 1) * (size === "sm" ? 18 : 22)}%`,
            minHeight: size === "sm" ? "3px" : "4px",
          }}
        />
      ))}
    </div>
  );
}

// Sentiment -5..+5: pill bigger when extreme (|v|>=3); muted when neutral.
export function SentimentBadge({
  value,
  size = "md",
}: {
  value: number | null;
  size?: "sm" | "md";
}) {
  if (value == null) {
    return (
      <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground/50">
        ——
      </span>
    );
  }
  const intense = Math.abs(value) >= 3;
  const tone =
    value >= 2
      ? intense
        ? "bg-emerald-500/20 text-emerald-200 border-emerald-500/50 shadow-[0_0_12px_rgb(16_185_129/0.25)]"
        : "bg-emerald-500/10 text-emerald-300 border-emerald-500/30"
      : value <= -2
        ? intense
          ? "bg-rose-500/20 text-rose-200 border-rose-500/50 shadow-[0_0_12px_rgb(244_63_94/0.25)]"
          : "bg-rose-500/10 text-rose-300 border-rose-500/30"
        : "bg-card/60 text-muted-foreground border-border";
  const sign = value > 0 ? "+" : "";
  const padding = size === "sm" ? "px-1.5 py-0.5 text-[10px]" : "px-2 py-1 text-xs";
  return (
    <span
      className={cn(
        "tick inline-flex min-w-[2.6ch] items-center justify-center rounded border font-mono font-semibold",
        padding,
        tone,
      )}
      title={`Sentiment ${sign}${value}`}
    >
      {sign}
      {value}
    </span>
  );
}
