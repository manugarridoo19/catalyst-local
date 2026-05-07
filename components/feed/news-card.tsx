import Link from "next/link";
import { formatDistanceToNowStrict } from "date-fns";
import { ImpactBadge, SentimentBadge } from "./score-badges";
import { CategoryBadge } from "./category-badge";
import { TickerLogo } from "@/components/ticker/ticker-logo";
import type { FeedItem } from "@/lib/feed-types";
import { cn } from "@/lib/utils";

// Mapeo de source RSS → etiqueta corta y atmósfera de color para el chip
// que se muestra cuando una noticia no tiene ticker asociado (modo macro).
const SOURCE_LABEL: Record<string, { label: string; tint: string }> = {
  "rss:marketwatch": { label: "MW", tint: "from-amber-400/30 to-amber-600/10" },
  "rss:yahoo-finance": { label: "YF", tint: "from-violet-400/30 to-violet-600/10" },
  "rss:cnbc-business": { label: "CNBC", tint: "from-rose-400/30 to-rose-600/10" },
  "rss:seeking-alpha": { label: "SA", tint: "from-orange-400/30 to-orange-600/10" },
  "rss:investing-com": { label: "INV", tint: "from-cyan-400/30 to-cyan-600/10" },
  "rss:marketbeat": { label: "MB", tint: "from-emerald-400/30 to-emerald-600/10" },
  "rss:marketbeat-ratings": { label: "MB★", tint: "from-emerald-400/30 to-emerald-600/10" },
  "rss:benzinga": { label: "BZ", tint: "from-fuchsia-400/30 to-fuchsia-600/10" },
  "rss:benzinga-news": { label: "BZ", tint: "from-fuchsia-400/30 to-fuchsia-600/10" },
  "rss:motley-fool": { label: "FOOL", tint: "from-yellow-400/30 to-yellow-600/10" },
  "rss:reuters-business": { label: "RTRS", tint: "from-orange-400/30 to-orange-600/10" },
  "rss:ft-companies": { label: "FT", tint: "from-pink-400/30 to-pink-600/10" },
  "rss:bloomberg": { label: "BBG", tint: "from-orange-400/30 to-orange-600/10" },
  "rss:barrons": { label: "BARR", tint: "from-blue-400/30 to-blue-600/10" },
  "rss:wsj-markets": { label: "WSJ", tint: "from-zinc-400/30 to-zinc-600/10" },
  "rss:zacks": { label: "ZCKS", tint: "from-blue-400/30 to-blue-600/10" },
};

function sourceChip(source: string) {
  const direct = SOURCE_LABEL[source];
  if (direct) return direct;
  if (source.startsWith("finnhub:")) return { label: "FH", tint: "from-sky-400/30 to-sky-600/10" };
  if (source.startsWith("marketaux:")) return { label: "MX", tint: "from-teal-400/30 to-teal-600/10" };
  return { label: "MKT", tint: "from-zinc-400/30 to-zinc-600/10" };
}

function cleanSource(source: string) {
  return source.replace(/^(rss:|finnhub:|marketaux:)/, "");
}

// Card del feed: logo + TICKER MAYÚSCULAS | mini headline | scores.
// Toda la card es Link al detalle del ticker primario, con `?news=ID` para
// que la vista detalle haga scroll y expanda esa noticia.
export function NewsCard({
  item,
  fresh = false,
}: {
  item: FeedItem;
  fresh?: boolean;
}) {
  const ago = formatDistanceToNowStrict(new Date(item.publishedAt), {
    addSuffix: false,
  });
  const primary = item.primarySymbol ?? item.tickers[0] ?? null;
  const direction =
    item.sentiment == null ? null : item.sentiment > 0 ? "▲" : item.sentiment < 0 ? "▼" : null;
  const chip = sourceChip(item.source);

  // Borde izquierdo coloreado por sentiment — pista visual rápida.
  const sentimentBar =
    item.sentiment == null
      ? "border-l-transparent"
      : item.sentiment >= 2
        ? "border-l-emerald-500/70"
        : item.sentiment <= -2
          ? "border-l-rose-500/70"
          : "border-l-border/40";

  const inner = (
    <div
      className={cn(
        "group grid grid-cols-[auto_1fr_auto] items-center gap-4 border-b border-l-2 border-border/40 px-5 py-3 transition-all duration-150 hover:bg-foreground/[0.025]",
        sentimentBar,
        fresh && "news-fresh",
      )}
    >
      {/* Left: logo + ticker uppercase */}
      <div className="flex w-32 items-center gap-3">
        {primary ? (
          <TickerLogo symbol={primary} logoUrl={item.primaryLogo ?? undefined} size="md" />
        ) : (
          <div
            className={cn(
              "flex h-9 w-9 items-center justify-center rounded-md border border-border/60 bg-gradient-to-br font-mono text-[9px] font-bold uppercase tracking-wider text-foreground",
              chip.tint,
            )}
          >
            {chip.label}
          </div>
        )}
        <div className="flex min-w-0 flex-col leading-tight">
          <span className="tick truncate font-mono text-sm font-bold uppercase text-foreground">
            {primary ?? chip.label}
          </span>
          {direction && (
            <span
              className={cn(
                "font-mono text-[10px] leading-none",
                item.sentiment != null && item.sentiment > 0 && "text-emerald-400",
                item.sentiment != null && item.sentiment < 0 && "text-rose-400",
              )}
            >
              {direction}
            </span>
          )}
        </div>
      </div>

      {/* Mini headline (single line truncated) + meta */}
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <CategoryBadge value={item.category} />
          <h3
            className="font-editorial truncate text-[15px] font-medium leading-snug text-foreground transition-colors group-hover:text-primary"
            title={item.headline}
          >
            {item.headline}
          </h3>
        </div>
        <div className="mt-0.5 flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground/80">
          <span className="truncate">{cleanSource(item.source)}</span>
          <span className="opacity-40">/</span>
          <span className="tick whitespace-nowrap">{ago}</span>
          {item.tickers.length > 1 && (
            <>
              <span className="opacity-40">/</span>
              <span className="tick whitespace-nowrap text-primary/80">
                +{item.tickers.length - 1} more
              </span>
            </>
          )}
        </div>
      </div>

      {/* Right: scores */}
      <div className="flex items-center gap-2 self-center pl-3">
        <ImpactBadge value={item.impact} />
        <SentimentBadge value={item.sentiment} />
      </div>
    </div>
  );

  // Sin ticker primario → fallback a article externo (modo macro/MKT).
  if (!primary) {
    return (
      <a
        href={item.url}
        target="_blank"
        rel="noreferrer noopener"
        className="block"
      >
        {inner}
      </a>
    );
  }

  return (
    <Link
      href={`/ticker/${primary}?news=${item.id}`}
      className="block"
      prefetch={false}
    >
      {inner}
    </Link>
  );
}
