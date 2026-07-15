"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import Image from "next/image";
import { usePathname } from "next/navigation";
import { Search } from "lucide-react";
import { getPusherClient, NEWS_CHANNEL, NEWS_EVENT } from "@/lib/pusher/client";
import { ThemeToggle } from "@/components/theme-toggle";
import { cn } from "@/lib/utils";

// Evento que abre la paleta de búsqueda (CommandPalette lo escucha).
export const OPEN_SEARCH_EVENT = "catalyst:open-search";

type Status = "connecting" | "live" | "offline";

// La conexión Pusher es un external store: useSyncExternalStore lee su
// estado sin el setState-síncrono-en-efecto que prohíbe el compilador de
// React. getSnapshot devuelve primitivas estables (string), como exige React.
const subscribeConnection = (cb: () => void) => {
  const pusher = getPusherClient();
  if (!pusher) return () => {};
  pusher.connection.bind("state_change", cb);
  return () => {
    pusher.connection.unbind("state_change", cb);
  };
};
const readStatus = (): Status => {
  const pusher = getPusherClient();
  if (!pusher) return "offline";
  return pusher.connection.state === "connected" ? "live" : "connecting";
};
const serverStatus = (): Status => "connecting";

export function Header() {
  const pathname = usePathname();
  const status = useSyncExternalStore(subscribeConnection, readStatus, serverStatus);
  const [now, setNow] = useState<string>("");
  const [lastEvent, setLastEvent] = useState<number | null>(null);
  // Tracks the previous status so we can run a one-shot flourish animation
  // on the transition into "live" (handshake landed). Stays false on every
  // subsequent re-render so the dot doesn't keep replaying.
  const prevStatus = useRef<Status>("connecting");
  const [justConnected, setJustConnected] = useState(false);
  useEffect(() => {
    if (prevStatus.current !== "live" && status === "live") {
      setJustConnected(true);
      const id = setTimeout(() => setJustConnected(false), 720);
      prevStatus.current = status;
      return () => clearTimeout(id);
    }
    prevStatus.current = status;
  }, [status]);

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

  // Canal de noticias — solo lastEvent; el estado de conexión ya lo cubre
  // useSyncExternalStore arriba.
  useEffect(() => {
    const pusher = getPusherClient();
    if (!pusher) return;
    const channel = pusher.subscribe(NEWS_CHANNEL);
    const onEvent = () => setLastEvent(Date.now());
    channel.bind(NEWS_EVENT, onEvent);

    return () => {
      channel.unbind(NEWS_EVENT, onEvent);
      pusher.unsubscribe(NEWS_CHANNEL);
    };
  }, []);

  // Estados semáforo — usamos variantes light/dark explícitas para que
  // los puntitos sigan legibles tanto sobre el vault azul-negro como
  // sobre el cream paper. Light: tonos más oscuros (saturados) para
  // contraste AA sobre fondo claro.
  const dotColor =
    status === "live"
      ? "bg-emerald-600 dark:bg-emerald-400"
      : status === "offline"
        ? "bg-rose-600 dark:bg-rose-500"
        : "bg-amber-600 dark:bg-amber-400";

  function openSearch() {
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent(OPEN_SEARCH_EVENT));
    }
  }

  return (
    <header className="sticky top-0 z-20 flex items-center justify-between border-b border-border/70 bg-card/55 px-6 py-3 backdrop-blur-md supports-[backdrop-filter]:bg-card/40">
      <div className="flex items-center gap-7">
        <Link
          href="/"
          aria-label="Catalyst home"
          className="group flex items-center gap-3"
        >
          {/* Brand wordmark — bitmap source is dark navy serif on cream
              ground. To make it cohere with the dark header without a
              jarring light plate:
                - filter: invert(1) flips the colors (cream→navy bg,
                  navy→cream text).
                - mix-blend-mode: lighten then collapses the now-dark
                  background into the header surface (max() per channel
                  keeps the header pixel) while the cream text wins.
              Result: cream "CATALYST" floating directly on the header,
              no white block. On a future light theme, we drop the
              filter so the original cream-on-cream layout reads as
              warm paper. */}
          <div className="relative h-9 transition-transform duration-200 group-hover:scale-[1.03]">
            <Image
              src="/catalyst-logo.png"
              alt="Catalyst"
              width={320}
              height={178}
              priority
              className="block h-full w-auto select-none dark:[filter:invert(1)] dark:[mix-blend-mode:lighten]"
              draggable={false}
            />
          </div>
          <div className="eyebrow hidden text-[9px] text-muted-foreground/70 lg:block">
            Realtime market intelligence
          </div>
        </Link>

        <nav
          className="relative flex items-center font-mono text-[11px] uppercase tracking-[0.18em]"
          aria-label="Primary"
        >
          <NavTab href="/" active={pathname === "/"}>
            Live feed
          </NavTab>
          <NavTab href="/news" active={pathname?.startsWith("/news") ?? false}>
            News
          </NavTab>
        </nav>
      </div>

      <div className="flex items-center gap-4">
        {/* Search */}
        <button
          type="button"
          onClick={openSearch}
          className="group flex items-center gap-2 rounded-md border border-border/60 bg-card/50 px-2.5 py-1.5 font-mono text-[11px] uppercase tracking-[0.16em] text-muted-foreground transition-colors duration-150 hover:border-primary/50 hover:bg-primary/[0.06] hover:text-primary"
          title="Search tickers (⌘K)"
          aria-label="Open ticker search"
        >
          <Search className="h-3.5 w-3.5 transition-transform duration-150 group-hover:scale-110" strokeWidth={2} />
          <span className="hidden sm:inline">Search</span>
          <kbd className="hidden rounded border border-border/60 bg-background/60 px-1.5 py-px font-mono text-[10px] tracking-normal text-muted-foreground group-hover:border-primary/40 group-hover:text-primary sm:inline">
            ⌘K
          </kbd>
        </button>

        <ThemeToggle />

        {/* Status block — dot + label + UTC clock + last event, all in one
            tight strip with a divider rule so it reads as a single console
            line rather than three competing badges. */}
        <div className="hidden items-center gap-3 rounded-md border border-border/50 bg-card/40 px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.16em] text-muted-foreground md:flex">
          <div className="flex items-center gap-2">
            <span className="relative flex h-1.5 w-1.5 items-center justify-center">
              <span
                className={cn(
                  "h-1.5 w-1.5 rounded-full",
                  dotColor,
                  status === "live" && !justConnected && "live-dot",
                  justConnected && "connect-flourish",
                )}
              />
            </span>
            <span
              className={cn(
                "transition-colors duration-200",
                status === "live" && "text-emerald-700 dark:text-emerald-300",
                status === "offline" && "text-rose-700 dark:text-rose-300",
                status === "connecting" && "text-amber-700 dark:text-amber-200",
              )}
            >
              {status === "live" ? "Live" : status === "offline" ? "Offline" : "Connecting"}
            </span>
          </div>
          <span className="h-3 w-px bg-border/70" aria-hidden />
          <div className="flex items-center gap-1.5">
            <span className="opacity-50">UTC</span>
            <span className="tick text-foreground/90">{now || "—"}</span>
          </div>
          {lastEvent && (
            <>
              <span className="hidden h-3 w-px bg-border/70 lg:block" aria-hidden />
              <div className="hidden items-center gap-1.5 lg:flex">
                <span className="opacity-50">Last</span>
                <LastSeen ts={lastEvent} />
              </div>
            </>
          )}
        </div>
      </div>
    </header>
  );
}

function NavTab({
  href,
  active,
  children,
}: {
  href: string;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "relative px-3 py-1.5 transition-colors duration-150",
        active ? "text-foreground" : "text-muted-foreground hover:text-foreground",
      )}
    >
      <span className="relative z-10">{children}</span>
      {/* Sliding active underline. Replaces the boxy active background +
          glow. Width is animated via Tailwind transitions; the position is
          determined by which tab has the .active class. */}
      <span
        aria-hidden
        className={cn(
          "nav-underline pointer-events-none absolute inset-x-3 -bottom-px h-px origin-left bg-primary",
          active ? "scale-x-100 opacity-100" : "scale-x-0 opacity-0",
        )}
      />
    </Link>
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
