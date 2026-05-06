"use client";

import { useState, useTransition } from "react";
import { Star } from "lucide-react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

export function WatchlistToggle({
  symbol,
  initial,
}: {
  symbol: string;
  initial: boolean;
}) {
  const [active, setActive] = useState(initial);
  const [, startTransition] = useTransition();
  const router = useRouter();

  async function toggle() {
    const next = !active;
    setActive(next);
    try {
      if (next) {
        await fetch("/api/watchlist", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ symbol }),
        });
        toast.success(`${symbol} added to watchlist`);
      } else {
        await fetch(`/api/watchlist?symbol=${symbol}`, { method: "DELETE" });
        toast(`${symbol} removed`);
      }
      startTransition(() => router.refresh());
    } catch {
      setActive(!next);
      toast.error("Could not update watchlist");
    }
  }

  return (
    <button
      onClick={toggle}
      className={cn(
        "flex items-center gap-1.5 rounded border px-2 py-1 font-mono text-[11px] uppercase tracking-wide transition-colors",
        active
          ? "border-amber-400/60 bg-amber-400/10 text-amber-300"
          : "border-border text-muted-foreground hover:border-amber-400/60 hover:text-amber-300",
      )}
    >
      <Star className={cn("h-3 w-3", active && "fill-amber-300")} />
      {active ? "Watching" : "Watch"}
    </button>
  );
}
