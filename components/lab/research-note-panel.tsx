import { NotebookPen } from "lucide-react";
import { BriefMarkdown } from "@/components/ai/brief-markdown";
import type { ResearchNoteRow } from "@/lib/ai/research-note";

// Research note matinal — el Lab leyéndose a sí mismo. Server component,
// patrón <details> como el AI Brief de la home. El contenido llega ya
// generado (1×/día en el cron); esta página no gasta cuota nunca.

export function ResearchNotePanel({ note }: { note: ResearchNoteRow | null }) {
  if (!note) return null;
  const day = note.generatedAt.toISOString().slice(0, 10);
  const modelShort =
    note.model.split("/").pop()?.replace(/:free$/, "") ?? note.model;

  return (
    <details className="group rounded-sm border border-border/60 bg-card/30" open>
      <summary className="flex cursor-pointer select-none items-center gap-2 px-4 py-2 hover:bg-foreground/[0.02] [&::-webkit-details-marker]:hidden">
        <NotebookPen className="h-3.5 w-3.5 text-primary" aria-hidden />
        <span className="eyebrow text-[10px] text-foreground">
          Morning research note — the Lab on itself
        </span>
        <span className="font-mono text-[10px] text-muted-foreground/70">
          {day} · {modelShort}
        </span>
        <span className="ml-auto font-mono text-[10px] uppercase tracking-widest text-muted-foreground/60 group-open:hidden">
          expand
        </span>
        <span className="ml-auto hidden font-mono text-[10px] uppercase tracking-widest text-muted-foreground/60 group-open:inline">
          collapse
        </span>
      </summary>
      <div className="px-4 pb-3 pt-1">
        <BriefMarkdown content={note.content} />
        <p className="mt-2 font-editorial text-[10.5px] leading-snug text-muted-foreground/50">
          Written daily from the scoreboard below — every figure it cites is
          computed in code, and the exact numbers it saw are archived with the
          note. Calibration, not a forecast.
        </p>
      </div>
    </details>
  );
}
