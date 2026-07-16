import { Sparkles } from "lucide-react";
import { BriefMarkdown } from "@/components/ai/brief-markdown";
import type { BriefRow } from "@/lib/ai/brief";

// AI Brief — panel colapsable a ancho completo sobre el live feed.
// Server component puro: <details>/<summary> da el toggle sin JS de
// cliente, y el contenido llega ya generado de la tabla ai_briefs.
// Render: markdown-lite compartido en components/ai/brief-markdown.tsx.

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
      <div className="px-6 pb-4 pt-1">
        <BriefMarkdown content={brief.content} />
      </div>
    </details>
  );
}
