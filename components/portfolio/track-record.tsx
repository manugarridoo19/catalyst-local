import {
  type DeskCall,
  type JudgedJournalTrade,
  type LabReference,
  type TrackRecord,
} from "@/lib/coach/track-record";
import { MEASURED_HORIZONS, HORIZON_LABEL } from "@/lib/coach/horizon";
import { NOISE_BAND_PCT } from "@/lib/coach/measure";

// Track record del diario — server component puro (cero JS cliente, cero
// LLM), mismo tono terminal que /lab: si este panel y aquél van a ponerse
// uno al lado del otro en la cabeza del usuario, que se lean igual.

function pct(n: number | null | undefined): string {
  if (n == null) return "—";
  return `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`;
}

function toneClass(n: number | null | undefined): string {
  if (n == null) return "text-muted-foreground/60";
  if (n > 0) return "text-emerald-700 dark:text-emerald-300";
  if (n < 0) return "text-rose-700 dark:text-rose-300";
  return "text-muted-foreground";
}

const VERDICT_CHIP: Record<string, string> = {
  acierto:
    "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  error: "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300",
  neutro: "border-border/60 bg-card/50 text-muted-foreground",
};

const SIDE_LABEL: Record<JudgedJournalTrade["side"], string> = {
  buy: "compra",
  sell: "venta",
};

export function TrackRecordSection({
  record,
  labRef,
  deskCalls = {},
}: {
  record: TrackRecord;
  labRef: LabReference;
  /** `fecha:símbolo → postura de la revisión de ese día`. Contexto, no
   *  veredicto: qué decía la mesa cuando decidiste. */
  deskCalls?: Record<string, DeskCall>;
}) {
  const { trades, stats, totals } = record;

  return (
    <section>
      <div className="mb-2 flex items-baseline gap-2.5">
        <h2 className="eyebrow text-[10px] text-foreground">
          Tu track record
        </h2>
        <span className="font-mono text-[9px] uppercase tracking-[0.14em] text-muted-foreground/50">
          misma aritmética que el Signal Lab · vs SPY
        </span>
      </div>
      <p className="mb-3 max-w-[78ch] font-editorial text-[12.5px] leading-relaxed text-muted-foreground">
        Cada operación del diario se mide contra el precio posterior con la
        aritmética congelada del Lab, así que estas cifras y las de{" "}
        <span className="font-mono text-[11.5px]">/lab</span> son comparables
        de verdad. El veredicto respeta tu plazo declarado: una venta a corto
        se juzga por lo que hizo el valor frente a SPY; una compra a años no
        recibe un &laquo;error&raquo; por caer un 4% en tres semanas.
      </p>

      <div className="mb-4 flex flex-wrap gap-x-6 gap-y-2 rounded-sm border border-border/60 bg-card/40 px-4 py-2.5">
        {(
          [
            ["Decisiones", totals.decisions],
            ["Medidas", totals.measured],
            ["Con veredicto", totals.withVerdict],
            ["Esperando precio", totals.awaitingPrice],
          ] as Array<[string, number]>
        ).map(([label, value]) => (
          <div key={label} className="flex items-baseline gap-2">
            <span className="font-mono text-[9px] uppercase tracking-[0.14em] text-muted-foreground/60">
              {label}
            </span>
            <span className="tick font-mono text-[12px] tabular-nums text-foreground">
              {value}
            </span>
          </div>
        ))}
      </div>

      {totals.decisions === 0 ? (
        <div className="rounded-sm border border-border/60 bg-card/40 px-4 py-6 text-center">
          <p className="font-mono text-[12px] text-muted-foreground">
            El diario aún no tiene operaciones — registra compras y ventas con
            su plazo y aquí aparecerá cómo te fue de verdad.
          </p>
        </div>
      ) : (
        <>
          {stats.length ? (
            <StatsTable stats={stats} labRef={labRef} />
          ) : null}
          {trades.length ? (
            <TradesTable trades={trades} deskCalls={deskCalls} />
          ) : null}
        </>
      )}

      <p className="mt-2 max-w-[78ch] font-editorial text-[11.5px] leading-relaxed text-muted-foreground/60">
        El edge lleva el signo de tu decisión: en una venta, que el valor
        SUBIERA después cuenta en contra. Movimientos de ±{NOISE_BAND_PCT}pp
        son neutros — etiquetar el ruido es como se fabrican rachas que no
        existen. Las operaciones a plazo largo se miden pero no se juzgan por
        precio.
      </p>
    </section>
  );
}

function StatsTable({
  stats,
  labRef,
}: {
  stats: TrackRecord["stats"];
  labRef: LabReference;
}) {
  const showRef = stats.some((s) => labRef[s.horizon]);
  return (
    <div className="mb-4 overflow-hidden rounded-sm border border-border/60">
      <table className="w-full border-collapse">
        <thead>
          <tr className="border-b border-border/60 bg-card/50 text-left font-mono text-[9px] uppercase tracking-[0.14em] text-muted-foreground/70">
            <th className="px-3 py-1.5 font-medium">Horizonte</th>
            <th className="px-3 py-1.5 text-right font-medium">N</th>
            <th className="px-3 py-1.5 text-right font-medium">Edge medio</th>
            <th className="px-3 py-1.5 text-right font-medium">Aciertos</th>
            <th className="px-3 py-1.5 text-right font-medium">Errores</th>
            <th className="hidden px-3 py-1.5 text-right font-medium sm:table-cell">
              Neutros
            </th>
            {showRef ? (
              <th className="hidden px-3 py-1.5 text-right font-medium md:table-cell">
                Señales Catalyst
              </th>
            ) : null}
          </tr>
        </thead>
        <tbody>
          {stats.map((s) => {
            const ref = labRef[s.horizon];
            return (
              <tr
                key={s.horizon}
                className="border-b border-border/40 last:border-b-0 hover:bg-foreground/[0.02]"
              >
                <td className="px-3 py-1.5 font-mono text-[11px] text-muted-foreground">
                  {s.horizon}d
                </td>
                <td className="px-3 py-1.5 text-right font-mono text-[11px] tabular-nums text-muted-foreground/70">
                  {s.n}
                </td>
                <td
                  className={`px-3 py-1.5 text-right font-mono text-[12px] tabular-nums ${toneClass(s.avgEdge)}`}
                >
                  {s.avgEdge >= 0 ? "+" : ""}
                  {s.avgEdge.toFixed(1)}pp
                </td>
                <td className="px-3 py-1.5 text-right font-mono text-[11px] tabular-nums text-emerald-700 dark:text-emerald-300">
                  {s.aciertos}
                </td>
                <td className="px-3 py-1.5 text-right font-mono text-[11px] tabular-nums text-rose-700 dark:text-rose-300">
                  {s.errores}
                </td>
                <td className="hidden px-3 py-1.5 text-right font-mono text-[11px] tabular-nums text-muted-foreground sm:table-cell">
                  {s.neutros}
                </td>
                {showRef ? (
                  <td className="hidden px-3 py-1.5 text-right font-mono text-[11px] tabular-nums text-muted-foreground/60 md:table-cell">
                    {ref
                      ? `${pct(ref.avgExcess)} · n=${ref.n}`
                      : "—"}
                  </td>
                ) : null}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function TradesTable({
  trades,
  deskCalls,
}: {
  trades: JudgedJournalTrade[];
  deskCalls: Record<string, DeskCall>;
}) {
  return (
    <div className="overflow-hidden rounded-sm border border-border/60">
      <table className="w-full border-collapse">
        <thead>
          <tr className="border-b border-border/60 bg-card/50 text-left font-mono text-[9px] uppercase tracking-[0.14em] text-muted-foreground/70">
            <th className="px-3 py-1.5 font-medium">Fecha</th>
            <th className="px-3 py-1.5 font-medium">Operación</th>
            <th className="hidden px-3 py-1.5 font-medium sm:table-cell">
              Plazo
            </th>
            <th className="hidden px-3 py-1.5 font-medium md:table-cell">
              La mesa decía
            </th>
            {MEASURED_HORIZONS.map((h) => (
              <th
                key={h}
                className={`px-3 py-1.5 text-right font-medium ${h > 30 ? "hidden lg:table-cell" : ""}`}
              >
                {h}d
              </th>
            ))}
            <th className="px-3 py-1.5 text-right font-medium">Veredicto</th>
          </tr>
        </thead>
        <tbody>
          {trades.map((t) => (
            <tr
              key={t.tradeId}
              className="border-b border-border/40 last:border-b-0 hover:bg-foreground/[0.02]"
            >
              <td className="px-3 py-1.5 font-mono text-[11px] tabular-nums text-muted-foreground/70">
                {t.createdAt}
              </td>
              <td className="px-3 py-1.5">
                <span className="tick font-mono text-[12px] font-bold tracking-tight text-foreground">
                  {t.symbol}
                </span>
                <span className="ml-1.5 font-mono text-[10px] uppercase tracking-[0.08em] text-muted-foreground/70">
                  {SIDE_LABEL[t.side]}
                </span>
                {t.annotatedLater ? (
                  <span className="ml-1.5 font-mono text-[9px] uppercase tracking-[0.08em] text-amber-700/80 dark:text-amber-300/80">
                    anotada después
                  </span>
                ) : null}
              </td>
              <td className="hidden px-3 py-1.5 font-mono text-[11px] text-muted-foreground sm:table-cell">
                {t.plazo ? HORIZON_LABEL[t.plazo].split(" ·")[0] : "—"}
              </td>
              <td className="hidden px-3 py-1.5 md:table-cell">
                {(() => {
                  const call = deskCalls[`${t.createdAt}:${t.symbol}`];
                  return call ? (
                    <span
                      className="font-mono text-[10px] uppercase tracking-[0.08em] text-muted-foreground"
                      title={call.why}
                    >
                      {call.stance}
                    </span>
                  ) : (
                    // Ausencia ≠ acuerdo: las operaciones anteriores a la
                    // revisión diaria no tienen fila, y se dice.
                    <span
                      className="font-mono text-[10px] text-muted-foreground/40"
                      title="sin revisión guardada ese día"
                    >
                      —
                    </span>
                  );
                })()}
              </td>
              {MEASURED_HORIZONS.map((h) => (
                <td
                  key={h}
                  className={`px-3 py-1.5 text-right font-mono text-[11px] tabular-nums ${h > 30 ? "hidden lg:table-cell" : ""} ${
                    t.verdict?.atHorizon === h
                      ? toneClass(t.returns[h])
                      : "text-muted-foreground/60"
                  }`}
                >
                  {pct(t.returns[h])}
                </td>
              ))}
              <td className="px-3 py-1.5 text-right">
                {t.verdict ? (
                  <span
                    className={`inline-flex items-baseline gap-1.5 rounded-sm border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.08em] ${VERDICT_CHIP[t.verdict.label]}`}
                  >
                    {t.verdict.label}
                    <span className="tabular-nums normal-case tracking-normal">
                      {t.verdict.edgePct >= 0 ? "+" : ""}
                      {t.verdict.edgePct.toFixed(1)}pp
                      {t.verdict.basis === "benchmark" ? " vs SPY" : ""} ·{" "}
                      {t.verdict.atHorizon}d
                    </span>
                  </span>
                ) : (
                  <span className="font-editorial text-[11px] text-muted-foreground/60">
                    {t.pendingVerdict?.reason ?? "—"}
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
