"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { toast } from "sonner";

type SearchResult = { symbol: string; name: string };

// Debouncer minimal — 200ms es suficiente para que el usuario teclee.
function useDebounce<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return debounced;
}

export function CommandPalette() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [, startTransition] = useTransition();
  const debounced = useDebounce(query, 200);

  // Atajo ⌘K / Ctrl+K + evento custom desde el botón del header.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((prev) => !prev);
      }
    };
    const onOpen = () => setOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("catalyst:open-search", onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("catalyst:open-search", onOpen);
    };
  }, []);

  // Búsqueda contra Finnhub via /api/search. Con query vacía no reseteamos
  // el estado (setState síncrono en efecto = render en cascada): los results
  // stale quedan en memoria y `shown` (derivado) los oculta en render.
  useEffect(() => {
    if (!debounced) return;
    let cancelled = false;
    fetch(`/api/search?q=${encodeURIComponent(debounced)}`)
      .then((r) => r.json())
      .then((d: { results: SearchResult[] }) => {
        if (!cancelled) setResults(d.results ?? []);
      })
      .catch(() => {
        if (!cancelled) setResults([]);
      });
    return () => {
      cancelled = true;
    };
  }, [debounced]);

  // Derivado en render: con query vacía no se muestran results aunque el
  // estado conserve los de la última búsqueda.
  const shown = debounced ? results : [];

  async function addWatchlist(symbol: string) {
    const res = await fetch("/api/watchlist", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ symbol }),
    });
    if (res.ok) {
      toast.success(`${symbol} added to watchlist`);
      startTransition(() => router.refresh());
    } else {
      toast.error(`Could not add ${symbol}`);
    }
  }

  return (
    <CommandDialog open={open} onOpenChange={setOpen} title="Search tickers">
      <CommandInput
        placeholder="Search ticker or company..."
        value={query}
        onValueChange={setQuery}
      />
      <CommandList>
        {shown.length === 0 ? (
          <CommandEmpty>
            {query.length === 0
              ? "Type a ticker or company name."
              : "No matches."}
          </CommandEmpty>
        ) : (
          <CommandGroup heading="Results">
            {shown.map((r) => (
              <CommandItem
                key={r.symbol}
                value={`${r.symbol} ${r.name}`}
                onSelect={() => {
                  setOpen(false);
                  router.push(`/ticker/${r.symbol}`);
                }}
              >
                <div className="flex w-full items-center justify-between">
                  <div className="flex items-center gap-3">
                    <span className="font-mono text-sm font-bold tabular-nums">
                      {r.symbol}
                    </span>
                    <span className="truncate text-xs text-muted-foreground">
                      {r.name}
                    </span>
                  </div>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      void addWatchlist(r.symbol);
                    }}
                    className="rounded border border-border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wide text-muted-foreground hover:border-amber-400/60 hover:text-amber-300"
                  >
                    + Watch
                  </button>
                </div>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
      </CommandList>
    </CommandDialog>
  );
}
