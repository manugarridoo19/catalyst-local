"use client";

import { useEffect, useState } from "react";
import { ExternalLink, Sparkles } from "lucide-react";
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

// Detalle enriquecido servido por /api/article/[id]: texto extraído del
// artículo real + resumen IA con sustancia. Se pide al montar el panel
// expandido (solo se monta al expandir → 1 fetch por click; el servidor
// cachea en article_extracts, así que re-abrir es lectura de BD).
type ArticleDetailPayload = {
  status: "ok" | "failed";
  text: string | null;
  aiSummary: string | null;
  aiTake: string | null;
};

function useArticleDetail(id: number): {
  detail: ArticleDetailPayload | null;
  loading: boolean;
} {
  // Sin reset síncrono en el efecto: el panel se monta por card y se
  // desmonta al colapsar, así que `id` es estable durante su vida.
  const [detail, setDetail] = useState<ArticleDetailPayload | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let alive = true;
    fetch(`/api/article/${id}`)
      .then((r) => (r.ok ? (r.json() as Promise<ArticleDetailPayload>) : null))
      .then((d) => {
        if (!alive) return;
        setDetail(d);
        setLoading(false);
      })
      .catch(() => {
        if (!alive) return;
        setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [id]);
  return { detail, loading };
}

// El body de muchas fuentes es solo "Titular  SiteName" (Google News RSS) —
// mostrarlo no aporta nada. Heurística: corto Y empieza igual que el titular.
function isBoilerplateBody(body: string, headline: string): boolean {
  const b = body.trim().toLowerCase();
  if (b.length >= 160) return false;
  const h = headline.trim().toLowerCase();
  return h.length > 0 && b.startsWith(h.slice(0, Math.min(40, h.length)));
}

// Primeros párrafos del texto extraído hasta ~cap chars (sin cortar un
// párrafo por la mitad salvo que el primero ya exceda el cap).
function leadParagraphs(text: string, cap: number): string[] {
  const paras = text.split(/\n+/).filter((p) => p.trim().length > 0);
  const out: string[] = [];
  let used = 0;
  for (const p of paras) {
    if (out.length > 0 && used + p.length > cap) break;
    out.push(p.length > cap * 1.5 ? p.slice(0, cap * 1.5) + "…" : p);
    used += p.length;
    if (used >= cap) break;
  }
  return out;
}

// Panel expandido: summary + cuerpo del artículo + rationale + acción
// "Read full article". `compact=true` reduce padding y tamaños (uso en
// ticker sidebar). `extra` permite inyectar acciones adicionales (ej.
// "Open <TICKER>" en el feed, que no aplica en sidebar).
export function NewsExpanded({
  item,
  compact = false,
  extra,
}: {
  item: FeedItem;
  compact?: boolean;
  extra?: React.ReactNode;
}) {
  const { detail, loading } = useArticleDetail(item.id);

  // Cada bloque prefiere el contenido enriquecido y degrada al del feed.
  const summary = detail?.aiSummary ?? item.summary;
  const take = detail?.aiTake || item.rationale;
  const articleParas =
    detail?.status === "ok" && detail.text
      ? leadParagraphs(detail.text, compact ? 500 : 1100)
      : null;
  const providerBody =
    item.body && !isBoilerplateBody(item.body, item.headline)
      ? item.body
      : null;

  return (
    <>
      {/* AI summary — resumen del artículo cuando el detalle ya llegó;
          mientras tanto, el summary corto del batch scorer si existe. */}
      {summary && (
        <div
          className={cn(
            "rounded-sm border border-primary/30 bg-primary/[0.06]",
            compact ? "mb-2 px-2.5 py-2" : "mb-3 px-3 py-2.5",
          )}
        >
          <div
            className={cn(
              "flex items-center gap-1 font-mono uppercase tracking-[0.22em] text-primary",
              compact ? "text-[8px]" : "text-[9px]",
            )}
          >
            <Sparkles className={compact ? "h-2.5 w-2.5" : "h-3 w-3"} aria-hidden />
            AI summary
          </div>
          <p
            className={cn(
              "font-editorial leading-relaxed text-foreground",
              compact ? "mt-1 text-[12.5px]" : "mt-1.5 text-[13.5px]",
            )}
          >
            {summary}
          </p>
        </div>
      )}
      {/* Cuerpo: párrafos del artículo extraído > body del provider (si no
          es boilerplate) > estado de carga/fallo honesto. */}
      {articleParas ? (
        <div
          className={cn(
            "space-y-2 font-editorial leading-relaxed text-foreground/90",
            compact ? "text-[13px]" : "text-[14px]",
          )}
        >
          {articleParas.map((p, i) => (
            <p key={i}>{p}</p>
          ))}
        </div>
      ) : providerBody ? (
        <p
          className={cn(
            "font-editorial leading-relaxed text-foreground/90",
            compact ? "text-[13px]" : "text-[14px]",
          )}
        >
          {providerBody}
        </p>
      ) : loading ? (
        <p
          className="animate-pulse font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground/60"
          role="status"
        >
          Reading article…
        </p>
      ) : (
        <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground/60">
          Couldn&apos;t fetch the article — the source may be paywalled. Use
          &ldquo;Read full article&rdquo; below.
        </p>
      )}
      {take && (
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
            {take}
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
