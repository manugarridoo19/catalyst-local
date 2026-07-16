import Link from "next/link";
import { CalendarDays } from "lucide-react";
import type { UpcomingEarning } from "@/lib/cron/refresh-earnings";

// Próximos earnings de la watchlist — pie del rail derecho. Server
// component: los datos llegan de la cache earnings_events (0 llamadas
// API por pageview). Si no hay eventos, no ocupa espacio.

const HOUR_LABEL: Record<string, string> = {
  bmo: "pre-mkt",
  amc: "after close",
  dmh: "in-session",
};

function fmtDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

export function EarningsPanel({ events }: { events: UpcomingEarning[] }) {
  if (events.length === 0) return null;
  return (
    <div className="shrink-0 border-t border-border/60 bg-card/40">
      <div className="flex items-center gap-2 px-5 pb-1.5 pt-2.5">
        <CalendarDays className="h-3 w-3 text-primary" aria-hidden />
        <span className="eyebrow text-[10px] text-muted-foreground">
          Earnings · next 90d
        </span>
      </div>
      <ul className="pb-2">
        {events.map((e) => (
          <li key={`${e.symbol}-${e.date}`}>
            <Link
              href={`/ticker/${e.symbol}`}
              className="flex items-baseline gap-2 px-5 py-1 transition-colors hover:bg-foreground/[0.03]"
            >
              <span className="tick w-12 shrink-0 font-mono text-[11px] tabular-nums text-foreground">
                {fmtDate(e.date)}
              </span>
              <span className="tick font-mono text-[11px] font-semibold text-foreground">
                {e.symbol}
              </span>
              {e.hour && HOUR_LABEL[e.hour] ? (
                <span className="font-mono text-[9px] uppercase tracking-[0.14em] text-muted-foreground/70">
                  {HOUR_LABEL[e.hour]}
                </span>
              ) : null}
              {e.epsEstimate ? (
                <span className="ml-auto font-mono text-[10px] tabular-nums text-muted-foreground/80">
                  est ${Number(e.epsEstimate).toFixed(2)}
                </span>
              ) : null}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
