"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";

type Size = "sm" | "md" | "lg";

const SIZE_CLASS: Record<Size, string> = {
  sm: "h-7 w-7 text-[10px]",
  md: "h-9 w-9 text-xs",
  lg: "h-12 w-12 text-sm",
};

export function TickerLogo({
  symbol,
  logoUrl,
  size = "md",
  className,
}: {
  symbol: string;
  logoUrl?: string | null;
  size?: Size;
  className?: string;
}) {
  const [errored, setErrored] = useState(false);
  const sym = symbol.toUpperCase();

  return (
    <div
      className={cn(
        "relative flex shrink-0 items-center justify-center overflow-hidden rounded-md border border-border/70 bg-card font-mono font-semibold uppercase text-foreground",
        SIZE_CLASS[size],
        className,
      )}
      title={sym}
    >
      {logoUrl && !errored ? (
        // Logos de Finnhub son white-bg; dejamos el wrapper blanco pasivo y
        // tiramos un mix-blend para que se vea bien sobre fondo oscuro.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={logoUrl}
          alt={sym}
          loading="lazy"
          onError={() => setErrored(true)}
          className="h-full w-full object-contain bg-white"
        />
      ) : (
        <span className="tick">{sym.slice(0, 3)}</span>
      )}
    </div>
  );
}
