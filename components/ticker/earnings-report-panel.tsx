import { FileText, ExternalLink } from "lucide-react";
import type {
  EarningsReport,
  SurpriseHistoryRow,
} from "@/lib/earnings/queries";

// Lectura del último comunicado de resultados (8-K item 2.02, exhibit 99.1).
// SERVER component, a diferencia del TickerBrief de al lado: esto ya está
// generado y guardado cuando la página se pinta, así que no hay nada que
// esperar ni motivo para un fetch de cliente.

function compact(n: number): string {
  if (Math.abs(n) >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (Math.abs(n) >= 1e6) return `${(n / 1e6).toFixed(0)}M`;
  return n.toFixed(2);
}

function surpriseTone(pct: number | null): string {
  if (pct == null) return "text-muted-foreground/60";
  if (pct > 0) return "text-emerald-700 dark:text-emerald-300";
  if (pct < 0) return "text-rose-700 dark:text-rose-300";
  return "text-muted-foreground";
}

function surpriseCell(
  pct: number | null,
  actual: number | null,
  isEps: boolean,
): React.ReactNode {
  if (actual == null) return <span className="text-muted-foreground/40">—</span>;
  return (
    <span className="inline-flex items-baseline gap-1.5">
      <span className="text-foreground/80">
        {isEps ? actual.toFixed(2) : compact(actual)}
      </span>
      <span className={surpriseTone(pct)}>
        {/* Sin consenso archivado el % no se inventa: la cifra real sola
            sigue siendo un dato, la sorpresa no. */}
        {pct == null ? "" : `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`}
      </span>
    </span>
  );
}

export function EarningsReportPanel({
  report,
  history = [],
}: {
  report: EarningsReport | null;
  history?: SurpriseHistoryRow[];
}) {
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

        {history.some((h) => h.revenueActual != null || h.epsActual != null) && (
          <div className="rounded-md border border-border/60 bg-background/40 p-3">
            <div className="eyebrow mb-1.5 text-[8.5px] text-muted-foreground/70">
              vs consensus — quarter by quarter
            </div>
            <table className="w-full border-collapse">
              <thead>
                <tr className="text-left font-mono text-[8.5px] uppercase tracking-[0.14em] text-muted-foreground/60">
                  <th className="py-0.5 pr-2 font-medium">Filed</th>
                  <th className="py-0.5 pr-2 font-medium">Revenue</th>
                  <th className="py-0.5 font-medium">EPS</th>
                </tr>
              </thead>
              <tbody>
                {history.map((h) => (
                  <tr
                    key={h.filingDate + h.exhibitUrl}
                    className="font-mono text-[10.5px] tabular-nums"
                  >
                    <td className="py-0.5 pr-2 text-muted-foreground/70">
                      {h.filingDate}
                    </td>
                    <td className="py-0.5 pr-2">
                      {surpriseCell(h.revenuePct, h.revenueActual, false)}
                    </td>
                    <td className="py-0.5">
                      {surpriseCell(h.epsPct, h.epsActual, true)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-1.5 font-editorial text-[10px] leading-snug text-muted-foreground/50">
              Surprise vs the consensus archived when each release was read;
              blank when no basis-matched estimate exists. Figures from the
              8-K itself, never a model.
            </p>
          </div>
        )}

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
