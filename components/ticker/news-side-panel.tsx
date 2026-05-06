"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { formatDistanceToNowStrict } from "date-fns";
import { ExternalLink } from "lucide-react";
import { ImpactBadge, SentimentBadge } from "@/components/feed/score-badges";
import type { FeedItem } from "@/lib/feed-types";
import { cn } from "@/lib/utils";

type Props = {
  symbol: string;
  items: FeedItem[];
};

// Lista de noticias del ticker en la columna derecha. Click toggles expand
// (muestra body + link). Si llegas a la página con `?news=ID`, esa noticia
// aparece expandida y se hace scroll a ella.
export function NewsSidePanel({ symbol, items }: Props) {
  const router = useRouter();
  const search = useSearchParams();
  const initialFocused = (() => {
    const n = Number(search.get("news"));
    return Number.isFinite(n) && n > 0 ? n : null;
  })();
  const [expanded, setExpanded] = useState<Set<number>>(() => {
    const s = new Set<number>();
    if (initialFocused) s.add(initialFocused);
    return s;
  });
  const focusedRef = useRef<HTMLDivElement | null>(null);

  // Scroll a la noticia enfocada al cargar.
  useEffect(() => {
    if (initialFocused && focusedRef.current) {
      focusedRef.current.scrollIntoView({ behavior: "instant", block: "start" });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function toggle(id: number) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    // Limpiar query param si se cierra la enfocada.
    if (id === initialFocused) {
      const params = new URLSearchParams(search.toString());
      params.delete("news");
      router.replace(`/ticker/${symbol}${params.size ? `?${params}` : ""}`, {
        scroll: false,
      });
    }
  }

  return (
    <aside className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-border/60 px-4 py-2">
        <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-muted-foreground">
          {symbol} news
        </div>
        <span className="tick rounded-sm border border-border/60 bg-card/60 px-1.5 py-0.5 font-mono text-[10px] text-foreground">
          {items.length}
        </span>
      </div>
      <div className="cat-scroll flex-1 overflow-y-auto">
        {items.length === 0 ? (
          <div className="flex h-full items-center justify-center p-6 text-center text-xs text-muted-foreground">
            No news yet for {symbol}.
          </div>
        ) : (
          items.map((it) => {
            const open = expanded.has(it.id);
            const focused = it.id === initialFocused;
            const ago = formatDistanceToNowStrict(new Date(it.publishedAt), {
              addSuffix: false,
            });
            return (
              <div
                key={it.id}
                ref={focused ? focusedRef : null}
                className={cn(
                  "border-b border-border/40 transition-colors",
                  focused && "bg-primary/[0.04]",
                )}
              >
                <button
                  onClick={() => toggle(it.id)}
                  className="block w-full px-4 py-3 text-left hover:bg-foreground/[0.02]"
                >
                  <div className="flex items-start justify-between gap-3">
                    <h4
                      className={cn(
                        "font-editorial text-sm leading-snug text-foreground",
                        !open && "line-clamp-2",
                      )}
                    >
                      {it.headline}
                    </h4>
                    <div className="flex shrink-0 items-center gap-2 self-start pt-0.5">
                      <ImpactBadge value={it.impact} />
                      <SentimentBadge value={it.sentiment} />
                    </div>
                  </div>
                  <div className="mt-1 flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground/80">
                    <span className="truncate">
                      {it.source.replace(/^(rss:|finnhub:|marketaux:)/, "")}
                    </span>
                    <span className="opacity-40">/</span>
                    <span className="tick whitespace-nowrap">{ago}</span>
                  </div>
                </button>
                {open && (
                  <div className="border-t border-border/30 bg-card/40 px-4 py-3">
                    {it.body ? (
                      <p className="font-editorial text-[13px] leading-relaxed text-foreground/90">
                        {it.body}
                      </p>
                    ) : (
                      <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
                        No summary available.
                      </p>
                    )}
                    {it.rationale && (
                      <p className="mt-2 font-editorial text-xs italic text-muted-foreground">
                        “{it.rationale}”
                      </p>
                    )}
                    <a
                      href={it.url}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="mt-3 inline-flex items-center gap-1.5 rounded-sm border border-border/60 bg-card/60 px-2 py-1 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground hover:border-primary/60 hover:text-primary"
                    >
                      Read full article <ExternalLink className="h-3 w-3" />
                    </a>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </aside>
  );
}
