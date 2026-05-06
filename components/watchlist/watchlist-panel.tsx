import Link from "next/link";
import { TickerLogo } from "@/components/ticker/ticker-logo";

export type WatchlistItem = {
  symbol: string;
  name: string | null;
  sector: string | null;
  logoUrl: string | null;
};

export function WatchlistPanel({ items }: { items: WatchlistItem[] }) {
  return (
    <aside className="flex w-72 flex-col border-l border-border/70 bg-card/30">
      <div className="flex items-center justify-between border-b border-border/70 px-5 py-2">
        <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-muted-foreground">
          Watchlist
        </div>
        <span className="tick rounded-sm border border-border/60 bg-card/60 px-1.5 py-0.5 font-mono text-[10px] text-foreground">
          {items.length}
        </span>
      </div>
      <div className="cat-scroll flex-1 overflow-y-auto">
        {items.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
            <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-muted-foreground">
              Empty
            </span>
            <p className="font-editorial text-sm italic text-muted-foreground/80">
              Pulsa{" "}
              <kbd className="rounded-sm border border-border bg-background/60 px-1 font-mono text-[10px] not-italic">
                ⌘K
              </kbd>{" "}
              para buscar y añadir tickers.
            </p>
          </div>
        ) : (
          <ul>
            {items.map((it) => (
              <li
                key={it.symbol}
                className="border-b border-border/40 transition-colors hover:bg-foreground/[0.025]"
              >
                <Link
                  href={`/ticker/${it.symbol}`}
                  className="flex items-center gap-3 px-5 py-3"
                >
                  <TickerLogo symbol={it.symbol} logoUrl={it.logoUrl} size="sm" />
                  <div className="min-w-0 flex-1">
                    <div className="tick font-mono text-sm font-bold uppercase text-foreground transition-colors hover:text-primary">
                      {it.symbol}
                    </div>
                    <div className="font-editorial truncate text-xs leading-tight text-muted-foreground">
                      {it.name ?? "—"}
                    </div>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
}
