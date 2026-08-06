import Link from "next/link";
import { Sparkles } from "lucide-react";
import type { NewUniverseName } from "@/lib/tickers/discovery";

// Nombres que acaban de entrar al universo con una historia de impacto
// detrás. Server component, patrón <details> como los paneles de la home.

export function NewNamesStrip({ names }: { names: NewUniverseName[] }) {
  if (!names.length) return null;
  return (
    <details className="group border-b border-border/40 bg-card/20">
      <summary className="flex cursor-pointer select-none items-center gap-2 px-6 py-2 hover:bg-foreground/[0.02] [&::-webkit-details-marker]:hidden">
        <Sparkles className="h-3.5 w-3.5 text-primary" aria-hidden />
        <span className="eyebrow text-[10px] text-foreground">
          New names in the archive
        </span>
        <span className="font-mono text-[10px] text-muted-foreground/70">
          7d · {names.length} with an impact story
        </span>
        <span className="ml-auto font-mono text-[10px] uppercase tracking-widest text-muted-foreground/60 group-open:hidden">
          expand
        </span>
        <span className="ml-auto hidden font-mono text-[10px] uppercase tracking-widest text-muted-foreground/60 group-open:inline">
          collapse
        </span>
      </summary>
      <div className="px-6 pb-3 pt-1">
        <ul className="divide-y divide-border/40 overflow-hidden rounded-sm border border-border/60">
          {names.map((n) => (
            <li key={n.symbol} className="flex items-baseline gap-3 px-3 py-2">
              <Link
                href={`/ticker/${n.symbol}`}
                className="tick w-16 shrink-0 font-mono text-[12px] font-semibold text-foreground hover:text-primary"
              >
                {n.symbol}
              </Link>
              <span className="hidden w-40 shrink-0 truncate font-editorial text-[11.5px] text-muted-foreground sm:inline">
                {n.name ?? "—"}
              </span>
              {/* El titular que lo trajo: sin él, "nuevo en el archivo" no
                  dice por qué debería importarte. */}
              <span className="min-w-0 flex-1 truncate font-editorial text-[12px] text-foreground/80">
                {n.headline}
              </span>
              <span className="shrink-0 rounded-sm border border-primary/40 bg-primary/10 px-1.5 py-0.5 font-mono text-[9px] tabular-nums text-primary">
                imp {n.impact}
              </span>
              <span className="shrink-0 font-mono text-[9px] tabular-nums text-muted-foreground/60">
                {n.firstSeen}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </details>
  );
}
