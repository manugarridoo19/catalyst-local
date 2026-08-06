"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Loader2, RefreshCw } from "lucide-react";
import type {
  DailyReviewResponse,
  PortfolioReviewResponse,
} from "@/app/api/portfolio-review/route";
import type { StoredReview } from "@/lib/coach/daily-review";
import type { Stance } from "@/lib/ai/portfolio-review";
import { cn } from "@/lib/utils";

// Tablero de revisión de cartera.
//
// Obligación editorial, la misma que el resto de /ask pero llevada un paso
// más allá: aquí el sistema OPINA sobre tus posiciones, así que cada
// opinión tiene que poder rastrearse hasta su evidencia. Por eso la fila
// de una posición nunca es sólo "vigilar" — lleva el porqué con el dato
// dentro y los [n] que lo sostienen. Y una postura que el gate degradó por
// falta de respaldo se pinta COMO TAL en vez de esconderse: que el modelo
// quisiera decir algo sin evidencia es información para quien lee.

const STANCE_LABEL: Record<Stance, string> = {
  add: "reforzar",
  hold: "mantener",
  watch: "vigilar",
  review: "revisar",
  none: "sin evidencia",
};

const STANCE_TONE: Record<Stance, string> = {
  add: "border-emerald-600/40 text-emerald-700 dark:text-emerald-300",
  hold: "border-border/60 text-muted-foreground",
  watch: "border-amber-600/40 text-amber-700 dark:text-amber-300",
  review: "border-rose-600/40 text-rose-700 dark:text-rose-300",
  none: "border-border/40 text-muted-foreground/50",
};

const LEDGER_KIND: Record<string, string> = {
  deal: "operación",
  guidance: "guía",
  regulatory: "regulatorio",
  legal: "judicial",
  product: "producto",
  capacity: "capacidad",
  other: "otro",
};

function pct(n: number): string {
  return `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`;
}

function tone(n: number | null): string {
  if (n === null) return "text-muted-foreground";
  if (n > 0) return "text-emerald-700 dark:text-emerald-300";
  if (n < 0) return "text-rose-700 dark:text-rose-300";
  return "text-muted-foreground";
}

const MONEY = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

export function PortfolioReviewPanel() {
  const [loading, setLoading] = useState(false);
  const [res, setRes] = useState<PortfolioReviewResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  // La revisión que el CRON escribió. Se carga al abrir y NO cuesta cuota:
  // es un GET contra una fila ya redactada. Sin esto, "diaria" obligaría a
  // pulsar el botón —dos llamadas al LLM— para ver algo que ya existía.
  const [daily, setDaily] = useState<StoredReview | null>(null);

  useEffect(() => {
    let alive = true;
    fetch("/api/portfolio-review")
      .then((r) => (r.ok ? (r.json() as Promise<DailyReviewResponse>) : null))
      .then((d) => {
        if (alive && d?.daily) setDaily(d.daily);
      })
      // Silencioso: no tener revisión del día es un estado normal (el cron
      // aún no ha corrido hoy) y no merece un error rojo en pantalla.
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  async function run() {
    if (loading) return;
    setLoading(true);
    setError(null);
    try {
      const r = await fetch("/api/portfolio-review", { method: "POST" });
      if (!r.ok) {
        setError(
          r.status === 429
            ? "Demasiadas peticiones seguidas. Espera un minuto."
            : "La revisión no se pudo generar. Inténtalo en un momento.",
        );
        setRes(null);
        return;
      }
      setRes((await r.json()) as PortfolioReviewResponse);
    } catch {
      setError("No se pudo contactar con el servidor.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3 border-t border-border/60 pt-5">
        <div>
          <h2 className="eyebrow text-[10px] text-foreground">
            Revisión de cartera
          </h2>
          <p className="mt-1 font-editorial text-[12px] leading-relaxed text-muted-foreground">
            Toma tus posiciones reales, las cruza con insiders, 13D/G,
            resultados y el track record del Lab, y dice qué cambiaría. Cada
            postura va con su evidencia o se marca como no respaldada.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void run()}
          disabled={loading}
          className="flex shrink-0 items-center gap-1.5 rounded-sm border border-border/60 px-2.5 py-1.5 font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground transition-colors hover:border-primary/50 hover:text-primary disabled:opacity-40"
        >
          {loading ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <RefreshCw className="h-3 w-3" />
          )}
          {loading ? "Analizando" : "Revisar"}
        </button>
      </div>

      {error ? (
        <p className="font-mono text-[11px] text-rose-700 dark:text-rose-300">
          {error}
        </p>
      ) : null}

      {/* La del cron sólo se enseña mientras no hayas forzado una fresca:
          dos veredictos en pantalla, uno de hoy y otro de hace diez
          segundos, se leen como una contradicción del sistema consigo
          mismo. La fecha va SIEMPRE delante — «esto es de anteayer» y «no
          hay nada que decir» no son la misma afirmación. */}
      {!res && daily ? <Daily d={daily} /> : null}

      {res ? <Board res={res} /> : null}
    </section>
  );
}

function Daily({ d }: { d: StoredReview }) {
  return (
    <div className="flex flex-col gap-2 rounded-sm border border-border/50 bg-card/30 px-3 py-2.5">
      <p className="font-mono text-[9.5px] uppercase tracking-[0.14em] text-muted-foreground/55">
        revisión del {d.reviewDate} · {d.model}
      </p>
      <p className="font-editorial text-[13px] leading-relaxed text-foreground/90">
        {d.verdict}
      </p>
      {d.positions.length ? (
        <ul className="flex flex-col gap-1">
          {d.positions.map((v) => (
            <li key={v.symbol} className="flex flex-wrap items-baseline gap-1.5">
              <span className="font-mono text-[11px] font-bold">{v.symbol}</span>
              <span
                className={cn(
                  "rounded-sm border px-1 py-px font-mono text-[9px] uppercase tracking-[0.12em]",
                  STANCE_TONE[v.stance] ??
                    "border-border/40 text-muted-foreground/60",
                )}
              >
                {STANCE_LABEL[v.stance] ?? v.stance}
              </span>
              <span className="font-editorial text-[12px] leading-snug text-muted-foreground">
                {v.why}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {d.watchNext.length ? (
        <ul className="flex flex-col gap-0.5 border-t border-border/40 pt-1.5">
          {d.watchNext.map((w, i) => (
            <li
              key={i}
              className="font-mono text-[10.5px] leading-relaxed text-muted-foreground/75"
            >
              · {w}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function Board({ res }: { res: PortfolioReviewResponse }) {
  const p = res.portfolio;
  const byNum = new Map(res.citations.map((c) => [c.n, c]));

  return (
    <div className="flex flex-col gap-5">
      {res.note ? (
        <p className="font-mono text-[11px] text-amber-700 dark:text-amber-300">
          {res.note}
        </p>
      ) : null}

      {p.positions.length ? (
        <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1 rounded-sm border border-border/50 bg-card/30 px-3 py-2 font-mono text-[11px]">
          <span className="text-muted-foreground">
            {p.positions.length} posiciones
          </span>
          <span className="text-foreground">
            ${MONEY.format(Math.round(p.totalValue))}
          </span>
          {p.totalUnrealizedPct !== null ? (
            <span className={tone(p.totalUnrealizedPct)}>
              P&L {pct(p.totalUnrealizedPct)}
            </span>
          ) : null}
          {p.dayChangePct !== null ? (
            <span className={tone(p.dayChangePct)}>hoy {pct(p.dayChangePct)}</span>
          ) : null}
          {res.derived.weightedBeta !== null ? (
            <span
              className="text-muted-foreground"
              title={`Calculada sobre el ${res.derived.betaCoveragePct.toFixed(0)}% del peso`}
            >
              beta {res.derived.weightedBeta.toFixed(2)}
            </span>
          ) : null}
          <span className="text-muted-foreground/60">
            {p.sectors
              .slice(0, 3)
              .map((s) => `${s.sector} ${s.weightPct.toFixed(0)}%`)
              .join(" · ")}
          </span>
        </div>
      ) : null}

      {/* Los clusters de resultados van ARRIBA y en cifras del código: es
          el riesgo que la lista de fechas del calendario no comunica, y
          el número no puede salir de la aritmética del modelo. */}
      {res.derived.earningsClusters.filter((c) => c.symbols.length > 1).length ? (
        <div className="rounded-sm border border-amber-600/30 bg-amber-500/[0.04] px-3 py-2">
          <div className="eyebrow mb-1 text-[9.5px] text-amber-700 dark:text-amber-300">
            Resultados solapados
          </div>
          <ul className="flex flex-col gap-0.5 font-mono text-[10.5px]">
            {res.derived.earningsClusters
              .filter((c) => c.symbols.length > 1)
              .map((c) => (
                <li key={c.date} className="flex gap-2.5">
                  <span className="tabular-nums text-muted-foreground/70">
                    {c.date}
                  </span>
                  <span className="text-foreground/85">{c.symbols.join(", ")}</span>
                  <span className="tabular-nums text-amber-700 dark:text-amber-300">
                    {c.weightPct.toFixed(1)}% de la cartera
                  </span>
                </li>
              ))}
          </ul>
        </div>
      ) : null}

      {/* Los avisos de calidad del dato van ARRIBA, no en una nota al pie:
          si tres posiciones no se pudieron valorar, quien lee tiene que
          saberlo ANTES de creerse los pesos, no después. */}
      {p.unpricedSymbols.length || p.noCostSymbols.length ? (
        <p className="font-mono text-[10.5px] leading-relaxed text-amber-700 dark:text-amber-300">
          {p.unpricedSymbols.length
            ? `Sin precio: ${p.unpricedSymbols.join(", ")} — fuera del cálculo de pesos. `
            : ""}
          {p.noCostSymbols.length
            ? `Sin coste medio: ${p.noCostSymbols.join(", ")} — sin P&L.`
            : ""}
        </p>
      ) : null}

      {/* Sin esto no hay forma de distinguir "no hay nada pendiente" de
          "las fuentes bloquearon la extracción y trabajé a ciegas". */}
      {res.harvest.candidates > 0 ? (
        <p className="font-mono text-[9.5px] uppercase tracking-[0.12em] text-muted-foreground/45">
          {res.harvest.bodiesAvailable}/{res.harvest.candidates} artículos leídos
          en profundidad
          {res.harvest.attempted > 0
            ? ` · ${res.harvest.harvested} extraídos ahora de ${res.harvest.attempted} intentos`
            : ""}
          {res.harvest.bodiesAvailable === 0
            ? " · sin cuerpos: la revisión sólo pudo usar titulares y datos estructurados"
            : ""}
        </p>
      ) : null}

      {res.review?.verdict ? (
        <div className="rounded-sm border border-border/60 bg-card/40 px-4 py-3">
          <div className="mb-2 flex items-baseline gap-2">
            <span className="eyebrow text-[10px] text-foreground">Veredicto</span>
            {res.concentration.map((c) => (
              <span
                key={c.label}
                className={cn(
                  "font-mono text-[9px] uppercase tracking-[0.14em]",
                  c.level === "warn"
                    ? "text-rose-700 dark:text-rose-300"
                    : "text-muted-foreground/60",
                )}
              >
                {c.label} {c.weightPct.toFixed(0)}%
              </span>
            ))}
          </div>
          <p className="font-editorial text-[13.5px] leading-relaxed text-foreground/90">
            {res.review.verdict}
          </p>
          <p className="mt-2 font-mono text-[9px] uppercase tracking-[0.14em] text-muted-foreground/40">
            {res.review.model}
          </p>
        </div>
      ) : null}

      {/* El libro de futuros va INMEDIATAMENTE tras el veredicto y se
          pinta aunque el redactor haya fallado: es el dato con más valor
          de toda la respuesta y no debe depender de que la prosa salga. */}
      {res.ledger.length ? (
        <section>
          <div className="mb-2 flex items-baseline gap-2.5">
            <h3 className="eyebrow text-[10px] text-foreground">
              Compromisos pendientes
            </h3>
            <span className="font-mono text-[9px] uppercase tracking-[0.14em] text-muted-foreground/50">
              extraído de los cuerpos · aún sin resolver
            </span>
          </div>
          <ul className="flex flex-col gap-1.5">
            {res.ledger.map((it, i) => (
              <li
                key={`${it.symbol}-${i}`}
                className="rounded-sm border border-primary/25 bg-primary/[0.03] px-3 py-2"
              >
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                  <Link
                    href={`/ticker/${it.symbol}`}
                    className="font-mono text-[11.5px] font-bold text-foreground hover:text-primary"
                  >
                    {it.symbol}
                  </Link>
                  <span className="font-mono text-[9px] uppercase tracking-[0.14em] text-muted-foreground/50">
                    {LEDGER_KIND[it.kind] ?? it.kind}
                  </span>
                  <a
                    href={byNum.get(it.source)?.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-mono text-[10px] text-primary/70 hover:text-primary"
                  >
                    [{it.source}]
                  </a>
                </div>
                <p className="mt-0.5 font-editorial text-[12.5px] leading-relaxed text-foreground/90">
                  {it.event}
                </p>
                {it.when || it.whenDate || it.condition ? (
                  <p className="mt-0.5 font-mono text-[10px] text-muted-foreground">
                    {it.whenDate ?? it.when ? `plazo: ${it.whenDate ?? it.when}` : ""}
                    {it.condition
                      ? `${it.whenDate ?? it.when ? " · " : ""}condición: ${it.condition}`
                      : ""}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {res.review?.positions.length ? (
        <section>
          <h3 className="eyebrow mb-2 text-[10px] text-foreground">Posiciones</h3>
          <ul className="flex flex-col gap-1.5">
            {res.review.positions.map((v) => {
              const pos = p.positions.find((x) => x.symbol === v.symbol);
              return (
                <li
                  key={v.symbol}
                  className="rounded-sm border border-border/40 bg-card/25 px-3 py-2"
                >
                  <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
                    <Link
                      href={`/ticker/${v.symbol}`}
                      className="font-mono text-[12px] font-bold text-foreground hover:text-primary"
                    >
                      {v.symbol}
                    </Link>
                    <span
                      className={cn(
                        "rounded-sm border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.14em]",
                        STANCE_TONE[v.stance],
                      )}
                    >
                      {STANCE_LABEL[v.stance]}
                    </span>
                    {pos?.weightPct != null ? (
                      <span className="font-mono text-[10px] text-muted-foreground/70">
                        {pos.weightPct.toFixed(1)}%
                      </span>
                    ) : null}
                    {pos?.unrealizedPct != null ? (
                      <span
                        className={cn(
                          "font-mono text-[10px]",
                          tone(pos.unrealizedPct),
                        )}
                      >
                        {pct(pos.unrealizedPct)}
                      </span>
                    ) : null}
                  </div>
                  <p className="mt-1 font-editorial text-[12.5px] leading-relaxed text-foreground/85">
                    {v.why}
                    {v.used.map((n) => (
                      <a
                        key={n}
                        href={byNum.get(n)?.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="ml-1 font-mono text-[11px] text-primary/80 hover:text-primary"
                      >
                        [{n}]
                      </a>
                    ))}
                  </p>
                  {v.degraded ? (
                    <p className="mt-1 font-mono text-[9.5px] uppercase tracking-[0.12em] text-muted-foreground/50">
                      sin cita ni dato duro que lo respalde — postura retirada
                    </p>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      {res.review?.watchNext.length ? (
        <section>
          <h3 className="eyebrow mb-2 text-[10px] text-foreground">Lo que viene</h3>
          <ul className="flex flex-col gap-1">
            {res.review.watchNext.map((w) => (
              <li
                key={w}
                className="font-editorial text-[12.5px] leading-relaxed text-foreground/85"
              >
                <span className="mr-1.5 font-mono text-[11px] text-primary/60">→</span>
                {w}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {res.calendar.length ? (
        <section>
          <h3 className="eyebrow mb-2 text-[10px] text-foreground">
            Calendario de catalizadores
          </h3>
          <ul className="flex flex-col gap-0.5 font-mono text-[10.5px]">
            {res.calendar.slice(0, 14).map((c, i) => (
              <li key={`${c.symbol}-${i}`} className="flex gap-2.5">
                <span className="w-[70px] shrink-0 tabular-nums text-muted-foreground/60">
                  {c.date ?? "—"}
                </span>
                <span className="w-[52px] shrink-0 font-bold text-foreground/80">
                  {c.symbol}
                </span>
                <span className="text-muted-foreground">{c.what}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {res.blindSpots.length ? (
        <section>
          <h3 className="eyebrow mb-1.5 text-[10px] text-foreground">
            Puntos ciegos
          </h3>
          <p className="font-editorial text-[12.5px] leading-relaxed text-muted-foreground">
            El archivo no tiene nada reciente sobre{" "}
            <span className="font-mono text-[11.5px] text-foreground/80">
              {res.blindSpots.join(", ")}
            </span>
            . La revisión no puede decir nada sobre esas posiciones — no es
            que no pase nada, es que Catalyst no lo está viendo.
          </p>
        </section>
      ) : null}

      {res.citations.length ? (
        <section>
          <h3 className="eyebrow mb-2 text-[10px] text-foreground">Fuentes</h3>
          <ol className="flex flex-col gap-1">
            {res.citations.map((c) => (
              <li key={c.n} className="flex gap-2 text-[11px]">
                <span className="font-mono text-primary/70">[{c.n}]</span>
                <a
                  href={c.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-editorial leading-snug text-muted-foreground hover:text-primary"
                >
                  {c.headline}
                  <span className="ml-1.5 font-mono text-[9.5px] uppercase tracking-[0.12em] text-muted-foreground/45">
                    {c.publishedAt.slice(0, 10)} · {c.source}
                  </span>
                </a>
              </li>
            ))}
          </ol>
        </section>
      ) : null}
    </div>
  );
}
