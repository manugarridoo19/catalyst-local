"use client";

import { useEffect, useState } from "react";
import { Sparkles } from "lucide-react";
import { BriefMarkdown } from "@/components/ai/brief-markdown";

// Ticker Day Brief — cuadro "qué está pasando hoy" en /ticker/[symbol].
// Client component: la generación puede tardar 5-30s la primera vez (llamada
// LLM), así que la página renderiza al instante y esto se rellena solo.
// Las visitas siguientes sirven de caché BD y llegan en <200ms.

type BriefPayload = {
  brief: {
    content: string;
    model: string;
    newsCount: number;
    generatedAt: string;
  } | null;
  status: "cached" | "generated" | "no_news" | "stale" | "error";
};

export function TickerBrief({ symbol }: { symbol: string }) {
  // Estado clavado por símbolo: al navegar a otro ticker, `data` se deriva
  // a null en render (loading) sin necesidad de un setState síncrono en el
  // effect (regla react-hooks/set-state-in-effect).
  const [state, setState] = useState<{
    symbol: string;
    payload: BriefPayload;
  } | null>(null);
  const data = state?.symbol === symbol ? state.payload : null;

  useEffect(() => {
    const ctrl = new AbortController();
    fetch(`/api/ticker-brief/${symbol}`, { signal: ctrl.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((json: BriefPayload | null) => {
        setState({
          symbol,
          payload: json ?? { brief: null, status: "error" },
        });
      })
      .catch(() => {
        // AbortError al desmontar también cae aquí — el estado ya no importa.
        if (!ctrl.signal.aborted) {
          setState({ symbol, payload: { brief: null, status: "error" } });
        }
      });
    return () => ctrl.abort();
  }, [symbol]);

  // Sin cobertura hoy o generación imposible: no ocupamos espacio — la
  // lista de noticias ya comunica el vacío por sí sola.
  if (data && !data.brief) return null;

  return (
    <details
      className="group shrink-0 border-b border-border/60 bg-card/30"
      open
    >
      <summary className="flex cursor-pointer select-none items-center gap-2 px-4 py-2 hover:bg-foreground/[0.02] [&::-webkit-details-marker]:hidden">
        <Sparkles className="h-3.5 w-3.5 text-primary" aria-hidden />
        <span className="eyebrow text-[10px] text-foreground">
          Today · AI desk note
        </span>
        {data?.brief ? (
          <span className="font-mono text-[10px] text-muted-foreground/70">
            {data.brief.generatedAt.slice(11, 16)}Z ·{" "}
            {data.brief.model.split("/").pop()?.replace(/:free$/, "")} ·{" "}
            {data.brief.newsCount} news read
          </span>
        ) : null}
        <span className="ml-auto font-mono text-[10px] uppercase tracking-widest text-muted-foreground/60 group-open:hidden">
          expand
        </span>
        <span className="ml-auto hidden font-mono text-[10px] uppercase tracking-widest text-muted-foreground/60 group-open:inline">
          collapse
        </span>
      </summary>
      <div className="max-h-[38vh] overflow-y-auto px-4 pb-3.5 pt-1">
        {data?.brief ? (
          <BriefMarkdown content={data.brief.content} />
        ) : (
          <div className="flex items-center gap-2 py-1.5 font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground/70">
            <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-primary/70" />
            Reading today&rsquo;s tape…
          </div>
        )}
      </div>
    </details>
  );
}
