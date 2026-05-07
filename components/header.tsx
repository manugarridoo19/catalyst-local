"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Activity, Search } from "lucide-react";
import { getPusherClient, NEWS_CHANNEL, NEWS_EVENT } from "@/lib/pusher/client";
import { cn } from "@/lib/utils";

// Evento que abre la paleta de búsqueda (CommandPalette lo escucha).
export const OPEN_SEARCH_EVENT = "catalyst:open-search";

type Status = "connecting" | "live" | "offline";

export function Header() {
  const [status, setStatus] = useState<Status>("connecting");
  const [now, setNow] = useState<string>("");
  const [lastEvent, setLastEvent] = useState<number | null>(null);

  // Reloj en UTC — terminal feel, mismo tiempo para todos los usuarios.
  useEffect(() => {
    const tick = () => {
      const d = new Date();
      const hh = String(d.getUTCHours()).padStart(2, "0");
      const mm = String(d.getUTCMinutes()).padStart(2, "0");
      const ss = String(d.getUTCSeconds()).padStart(2, "0");
      setNow(`${hh}:${mm}:${ss}`);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  // Estado de la conexión Pusher.
  useEffect(() => {
    const pusher = getPusherClient();
    if (!pusher) {
      setStatus("offline");
      return;
    }
    const onState = (states: { current: string }) => {
      setStatus(states.current === "connected" ? "live" : "connecting");
    };
    pusher.connection.bind("state_change", onState);
    setStatus(pusher.connection.state === "connected" ? "live" : "connecting");

    const channel = pusher.subscribe(NEWS_CHANNEL);
    const onEvent = () => setLastEvent(Date.now());
    channel.bind(NEWS_EVENT, onEvent);

    return () => {
      pusher.connection.unbind("state_change", onState);
      channel.unbind(NEWS_EVENT, onEvent);
      pusher.unsubscribe(NEWS_CHANNEL);
    };
  }, []);

  const dotColor =
    status === "live"
      ? "bg-emerald-400"
      : status === "offline"
        ? "bg-rose-500"
        : "bg-amber-400";

  function openSearch() {
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent(OPEN_SEARCH_EVENT));
    }
  }

  return (
    <header className="relative flex items-center justify-between border-b border-border bg-card/40 px-6 py-3 backdrop-blur-sm">
      <Link href="/" className="flex items-center gap-3 group">
        <div className="flex h-8 w-8 items-center justify-center rounded-sm bg-primary text-primary-foreground shadow-[0_0_18px_oklch(0.78_0.13_75/0.45)] transition-transform group-hover:scale-105">
          <Activity className="h-4 w-4" strokeWidth={2.5} />
        </div>
        <div>
          <div className="font-editorial text-lg font-semibold leading-none tracking-tight text-foreground">
            Catalyst
          </div>
          <div className="mt-1 font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
            Realtime market intelligence
          </div>
        </div>
      </Link>

      <div className="flex items-center gap-3 font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
        {/* Search button — clickable, opens palette */}
        <button
          type="button"
          onClick={openSearch}
          className="group flex items-center gap-2 rounded-sm border border-border/70 bg-card/40 px-2.5 py-1.5 transition-all duration-150 hover:border-primary/60 hover:bg-primary/[0.06] hover:text-primary"
          title="Search tickers (⌘K)"
        >
          <Search className="h-3.5 w-3.5" strokeWidth={2} />
          <span className="hidden sm:inline">Search</span>
          <kbd className="hidden rounded-sm border border-border/70 bg-background/60 px-1 font-mono text-[10px] tracking-normal sm:inline">
            ⌘K
          </kbd>
        </button>

        {/* Connection dot + status */}
        <div className="flex items-center gap-2">
          <span
            className={cn(
              "h-1.5 w-1.5 rounded-full",
              dotColor,
              status === "live" && "live-dot",
            )}
          />
          <span
            className={cn(
              "hidden sm:inline",
              status === "live" && "text-emerald-300",
              status === "offline" && "text-rose-300",
            )}
          >
            {status === "live" ? "Live" : status === "offline" ? "Offline" : "Connecting"}
          </span>
        </div>

        {/* UTC clock */}
        <div className="hidden items-center gap-2 md:flex">
          <span className="opacity-50">UTC</span>
          <span className="tick text-foreground">{now || "—"}</span>
        </div>

        {lastEvent && (
          <div className="hidden items-center gap-2 lg:flex">
            <span className="opacity-50">Last</span>
            <LastSeen ts={lastEvent} />
          </div>
        )}
      </div>
    </header>
  );
}

function LastSeen({ ts }: { ts: number }) {
  const [label, setLabel] = useState("now");
  useEffect(() => {
    const tick = () => {
      const sec = Math.floor((Date.now() - ts) / 1000);
      if (sec < 5) setLabel("now");
      else if (sec < 60) setLabel(`${sec}s`);
      else if (sec < 3600) setLabel(`${Math.floor(sec / 60)}m`);
      else setLabel(`${Math.floor(sec / 3600)}h`);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [ts]);
  return <span className="tick text-primary">{label}</span>;
}
