import Link from "next/link";

export type WatchlistItem = {
  symbol: string;
  name: string | null;
  sector: string | null;
};

export function WatchlistPanel({ items }: { items: WatchlistItem[] }) {
  return (
    <aside className="flex w-72 flex-col border-l border-border bg-card/30">
      <div className="flex items-center justify-between border-b border-border px-4 py-2">
        <div className="font-mono text-xs uppercase tracking-widest text-muted-foreground">
          Watchlist · {items.length}
        </div>
      </div>
      <div className="flex-1 overflow-y-auto">
        {items.length === 0 ? (
          <div className="flex h-full items-center justify-center p-6 text-center text-xs text-muted-foreground">
            Pulsa ⌘K para buscar tickers y añadirlos.
          </div>
        ) : (
          <ul>
            {items.map((it) => (
              <li
                key={it.symbol}
                className="flex items-center justify-between border-b border-border/60 px-4 py-2 hover:bg-muted/30"
              >
                <Link
                  href={`/ticker/${it.symbol}`}
                  className="font-mono text-sm font-bold tabular-nums text-foreground hover:text-amber-300"
                >
                  {it.symbol}
                </Link>
                <div className="ml-3 min-w-0 flex-1 text-right">
                  <div className="truncate text-xs text-muted-foreground">
                    {it.name ?? "—"}
                  </div>
                  <div className="truncate text-[10px] uppercase tracking-wide text-muted-foreground/70">
                    {it.sector ?? ""}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
}
