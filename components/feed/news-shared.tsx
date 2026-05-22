"use client";

import { ExternalLink } from "lucide-react";
import { cn } from "@/lib/utils";
import type { FeedItem } from "@/lib/feed-types";

// Limpia el prefijo del provider para mostrar solo el nombre canónico.
// Compartido entre NewsCard (feed) y NewsRow (ticker sidebar).
export function cleanSource(source: string): string {
  return source.replace(/^(rss:|finnhub:|marketaux:|gnews:)/, "");
}

// Background tint by sentiment. Replaces the previous side-stripe pattern
// (banned). At |sentiment| ≥ 3 we apply a very subtle full-surface wash so
// the card carries the signal without a colored vertical rule.
export function sentimentBgClass(
  sentiment: number | null | undefined,
): string {
  if (sentiment == null) return "";
  const abs = Math.abs(sentiment);
  if (abs < 3) return "";
  return sentiment > 0
    ? "bg-emerald-500/[0.07] dark:bg-emerald-500/[0.035]"
    : "bg-rose-500/[0.07] dark:bg-rose-500/[0.035]";
}

// Panel expandido: summary + rationale + acción "Read full article".
// `compact=true` reduce padding y tamaños (uso en ticker sidebar).
// `extra` permite inyectar acciones adicionales (ej. "Open <TICKER>" en
// el feed, que no aplica en sidebar porque ya estás en el ticker).
export function NewsExpanded({
  item,
  compact = false,
  extra,
}: {
  item: FeedItem;
  compact?: boolean;
  extra?: React.ReactNode;
}) {
  return (
    <>
      {item.body ? (
        <p
          className={cn(
            "font-editorial leading-relaxed text-foreground/90",
            compact ? "text-[13px]" : "text-[14px]",
          )}
        >
          {item.body}
        </p>
      ) : (
        <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground/60">
          No summary captured.
        </p>
      )}
      {item.rationale && (
        <div
          className={cn(
            "border-l-2 border-primary/40 bg-primary/[0.04]",
            compact ? "mt-2 px-2.5 py-1.5" : "mt-3 px-3 py-2",
          )}
        >
          <div
            className={cn(
              "font-mono uppercase tracking-[0.22em] text-primary/80",
              compact ? "text-[8px]" : "text-[9px]",
            )}
          >
            AI rationale
          </div>
          <p
            className={cn(
              "font-editorial italic leading-relaxed text-foreground/85",
              compact ? "mt-0.5 text-[12px]" : "mt-1 text-[13px]",
            )}
          >
            {item.rationale}
          </p>
        </div>
      )}
      <div className={cn("flex flex-wrap items-center gap-2", compact ? "mt-3" : "mt-4")}>
        <a
          href={item.url}
          target="_blank"
          rel="noreferrer noopener"
          onClick={(e) => e.stopPropagation()}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-sm border border-primary/40 bg-primary/[0.08] font-mono font-semibold uppercase tracking-[0.18em] text-primary transition-colors hover:bg-primary/15",
            compact ? "px-2.5 py-1 text-[10px]" : "px-3 py-1.5 text-[11px]",
          )}
        >
          Read full article <ExternalLink className="h-3 w-3" />
        </a>
        {extra}
      </div>
    </>
  );
}
