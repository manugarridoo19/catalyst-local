import type { ReactNode } from "react";
import { Sparkles } from "lucide-react";
import type { BriefRow } from "@/lib/ai/brief";

// AI Brief — panel colapsable a ancho completo sobre el live feed.
// Server component puro: <details>/<summary> da el toggle sin JS de
// cliente, y el contenido llega ya generado de la tabla ai_briefs.

// Renderer markdown-lite: solo soportamos lo que el prompt permite emitir
// (bullets "- " y negritas **X**). Cualquier otra línea se pinta como
// párrafo plano. Nada de dangerouslySetInnerHTML.
function renderInline(text: string): ReactNode[] {
  const parts = text.split(/\*\*([^*]+)\*\*/g);
  return parts.map((part, i) =>
    i % 2 === 1 ? (
      <strong key={i} className="font-mono text-[0.95em] font-bold tracking-wide text-primary">
        {part}
      </strong>
    ) : (
      <span key={i}>{part}</span>
    ),
  );
}

function renderBrief(content: string): ReactNode {
  const lines = content
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  return (
    <ul className="space-y-2">
      {lines.map((line, i) => {
        const bullet = line.replace(/^[-•]\s+/, "");
        const isWatchlist = bullet.startsWith("⭐");
        const text = isWatchlist ? bullet.replace(/^⭐\s*/, "") : bullet;
        return (
          <li
            key={i}
            className={
              isWatchlist
                ? "border-l-2 border-primary/70 pl-3 text-foreground"
                : "border-l-2 border-border/40 pl-3 text-foreground/90"
            }
          >
            {isWatchlist ? (
              <span className="eyebrow-sm mr-2 text-primary">watchlist</span>
            ) : null}
            <span className="font-editorial text-[13.5px] leading-relaxed">
              {renderInline(text)}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

export function BriefPanel({ brief }: { brief: BriefRow | null }) {
  if (!brief) return null;
  const hhmm = brief.generatedAt.toISOString().slice(11, 16);
  const modelShort = brief.model.split("/").pop()?.replace(/:free$/, "") ?? brief.model;

  return (
    <details className="group border-b border-border/40 bg-card/30" open>
      <summary className="flex cursor-pointer select-none items-center gap-2 px-6 py-2 hover:bg-foreground/[0.02] [&::-webkit-details-marker]:hidden">
        <Sparkles className="h-3.5 w-3.5 text-primary" aria-hidden />
        <span className="eyebrow text-[10px] text-foreground">AI Brief</span>
        <span className="font-mono text-[10px] text-muted-foreground/70">
          {hhmm}Z · {modelShort}
        </span>
        <span className="ml-auto font-mono text-[10px] uppercase tracking-widest text-muted-foreground/60 transition-transform group-open:hidden">
          expand
        </span>
        <span className="ml-auto hidden font-mono text-[10px] uppercase tracking-widest text-muted-foreground/60 group-open:inline">
          collapse
        </span>
      </summary>
      <div className="px-6 pb-4 pt-1">{renderBrief(brief.content)}</div>
    </details>
  );
}
