import { FileText, ExternalLink } from "lucide-react";
import type { EarningsReport } from "@/lib/earnings/queries";

// Lectura del último comunicado de resultados (8-K item 2.02, exhibit 99.1).
// SERVER component, a diferencia del TickerBrief de al lado: esto ya está
// generado y guardado cuando la página se pinta, así que no hay nada que
// esperar ni motivo para un fetch de cliente.

export function EarningsReportPanel({ report }: { report: EarningsReport | null }) {
  if (!report) return null;

  return (
    <details className="group shrink-0 border-b border-border/60 bg-card/20">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-2.5 hover:bg-card/40">
        <FileText className="h-3.5 w-3.5 shrink-0 text-primary" strokeWidth={2} />
        <span className="font-mono text-[9px] uppercase tracking-[0.2em] text-muted-foreground">
          Earnings release
        </span>
        <span className="tick font-mono text-[10px] tabular-nums text-muted-foreground/70">
          {report.filingDate}
        </span>
        <span className="ml-auto font-mono text-[9px] uppercase tracking-[0.16em] text-muted-foreground/50 transition-colors group-open:text-primary">
          {/* El detalle arranca plegado: en la ticker page el protagonista es
              el gráfico y el tape, no un muro de texto. */}
          <span className="group-open:hidden">Read</span>
          <span className="hidden group-open:inline">Hide</span>
        </span>
      </summary>

      {/* max-h + scroll propio, igual que el TickerBrief de encima: el aside
          es overflow-hidden, así que sin esto el comunicado desplegado se
          RECORTA (no hace scroll) y se pierden los últimos bullets. */}
      <div className="max-h-[38vh] space-y-3 overflow-y-auto px-4 pb-4 pt-1">
        {report.headline && (
          <p className="font-editorial text-[13px] leading-snug text-foreground/90">
            {report.headline}
          </p>
        )}

        <ul className="space-y-1.5">
          {report.summary.map((bullet, i) => (
            <li key={i} className="flex gap-2 text-[12.5px] leading-relaxed text-foreground/85">
              <span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-primary/60" />
              <span>{bullet}</span>
            </li>
          ))}
        </ul>

        {report.readBetweenLines && (
          <div className="rounded-md border border-border/60 bg-background/40 p-3">
            <div className="eyebrow mb-1 text-[8.5px] text-muted-foreground/70">
              What it doesn&apos;t say
            </div>
            <p className="text-[12px] leading-relaxed text-foreground/80">
              {report.readBetweenLines}
            </p>
          </div>
        )}

        <div className="flex items-center gap-3 pt-0.5">
          {/* Enlace a la fuente PRIMARIA, no a un agregador: el usuario tiene
              que poder comprobar cada cifra en el documento registrado. */}
          <a
            href={report.exhibitUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 font-mono text-[9.5px] uppercase tracking-[0.16em] text-muted-foreground transition-colors hover:text-primary"
          >
            SEC 8-K exhibit 99.1
            <ExternalLink className="h-2.5 w-2.5" strokeWidth={2} />
          </a>
          <span className="font-mono text-[9px] uppercase tracking-[0.16em] text-muted-foreground/40">
            {report.model}
          </span>
        </div>
      </div>
    </details>
  );
}
