import { Sigma, AlertTriangle } from "lucide-react";
import type { StoredMetrics } from "@/lib/metrics/queries";
import type { HistoryStat } from "@/lib/metrics/derive";

// Fundamentales de negocio: los 133 ratios de Finnhub que `refresh-metrics`
// lleva escribiendo desde el 2026-08-11 y que hasta ahora NO LEÍA NADIE
// (misma forma que `earnings_reports` en su día: se pagaba la ingesta y la
// tabla no tenía consumidor).
//
// SERVER component: es un SELECT ya materializado por el cron, así que no
// hay nada que esperar — a diferencia de `TickerFundamentals`, que es
// cliente porque su primera visita paga 3 llamadas a FMP.
//
// Va en un <details> cerrado por defecto. Son 20 cifras y la ficha ya tiene
// hero, chart, brief, comunicado y noticias: abrirlo siempre convertiría la
// página en una hoja de cálculo.

// ─── POR QUÉ EL PERCENTIL NO SE COLOREA ──────────────────────────────────
//
// La tentación es pintar de verde el múltiplo barato. Sería un error, y es
// justo el que este panel existe para no cometer: un P/E bajo en una
// cíclica en el pico del ciclo es la señal MÁS peligrosa que hay, no la
// mejor — el mercado le pone múltiplo bajo precisamente porque descuenta el
// derrumbe de los beneficios que vienen. El mismo 25 percentil se lee al
// revés según qué clase de empresa tengas delante, y eso lo decide el marco
// declarado (lib/coach/frames.ts), no esta tabla.
//
// Misma doctrina que el days-to-cover en la mesa de decisión: neutral a
// propósito, porque darle lado sería elegir narrativa por el lector.

function pct(n: number | null): string {
  return n == null ? "—" : `${n.toFixed(1)}%`;
}
function mult(n: number | null): string {
  return n == null ? "—" : `${n.toFixed(1)}×`;
}
function ratio(n: number | null): string {
  return n == null ? "—" : n.toFixed(2);
}

/** El percentil en palabras. `pctile` es el % de la distribución POR DEBAJO
 *  del valor de hoy, así que 25 = más barato que el 75% de su historia.
 *
 *  DOS FORMAS a propósito. La larga se comía tres renglones dentro de cada
 *  fila y descuadraba la rejilla entera (medido en MSFT: 8 filas de alturas
 *  distintas en la primera columna y las otras tres columnas cortas al
 *  lado). La corta cabe en una línea y la larga sobrevive en el `title`,
 *  que es donde una explicación no le quita sitio a la cifra. */
function historyNote(h: HistoryStat | undefined): string | null {
  if (!h) return null;
  const lado = h.pctile <= 50 ? "más barato" : "más caro";
  const resto = h.pctile <= 50 ? 100 - h.pctile : h.pctile;
  return `percentil ${Math.round(h.pctile)} · ${lado} que el ${Math.round(resto)}% de sus últimos 5 años (mediana ${h.median.toFixed(1)}×, ${h.n} trim.)`;
}

function historyShort(h: HistoryStat | undefined): string | null {
  if (!h) return null;
  return `p${Math.round(h.pctile)} · med ${h.median.toFixed(1)}×`;
}

function Row({
  label,
  value,
  hint,
  history,
}: {
  label: string;
  value: string;
  hint?: string;
  history?: HistoryStat;
}) {
  const corta = historyShort(history);
  const larga = historyNote(history);
  // El `title` acumula las dos explicaciones que existan: qué es la métrica
  // y qué dice su percentil. Es donde cabe la prosa sin robarle sitio a la
  // cifra, que es lo único que se mira de un vistazo.
  const tip = [hint, larga].filter(Boolean).join(" — ") || undefined;
  return (
    <div className="flex items-baseline justify-between gap-3 py-1" title={tip}>
      <span className="shrink-0 font-mono text-[9px] uppercase tracking-[0.18em] text-muted-foreground/70">
        {label}
      </span>
      <span className="flex min-w-0 items-baseline justify-end gap-2">
        {corta && (
          <span className="hidden shrink-0 whitespace-nowrap font-mono text-[9px] text-muted-foreground/50 sm:inline">
            {corta}
          </span>
        )}
        <span className="shrink-0 font-mono text-[12px] font-semibold tabular-nums text-foreground">
          {value}
        </span>
      </span>
    </div>
  );
}

/**
 * Qué múltiplo va en la línea cerrada.
 *
 * NO es siempre el forward P/E. Anclarlo ahí deja la cabecera muda en toda
 * empresa que aún no gana dinero — y ésas son justo las que más se miran en
 * esta cartera: de 7 posiciones, 3 no tienen percentil de P/E y una no tiene
 * P/E en absoluto. Un panel cuyo titular desaparece en el caso interesante
 * no sirve.
 *
 * El orden es el que impone la contabilidad, no una preferencia: sin
 * beneficios no hay P/E que enseñar (no hay E), y entonces el múltiplo que
 * sitúa a la empresa es el de ventas. Se devuelve también el rótulo para
 * que la cabecera diga CUÁL está enseñando: "P/S 8,4×" y "fwd P/E 8,4×" son
 * lecturas incomparables y confundirlas es peor que no poner nada.
 */
function headline(m: StoredMetrics): {
  label: string | null;
  value: string | null;
  stat: HistoryStat | undefined;
} {
  if (m.forwardPe != null) {
    return { label: "fwd P/E", value: mult(m.forwardPe), stat: m.history.pe };
  }
  if (m.peTtm != null) {
    return { label: "P/E", value: mult(m.peTtm), stat: m.history.pe };
  }
  if (m.psTtm != null) {
    return { label: "P/S", value: mult(m.psTtm), stat: m.history.ps };
  }
  return { label: null, value: null, stat: undefined };
}

function Group({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="min-w-0">
      <h4 className="mb-1 border-b border-border/40 pb-1 font-mono text-[9px] uppercase tracking-[0.2em] text-muted-foreground">
        {title}
      </h4>
      {children}
    </div>
  );
}

export function TickerMetricsPanel({ m }: { m: StoredMetrics | null }) {
  // Sin fila no se pinta el bloque. Un panel de guiones no informa de nada y
  // sugiere que el dato existe y vale cero.
  if (!m) return null;

  const { label: cabLabel, value: cabValue, stat: cabStat } = headline(m);
  const cabNote = historyNote(cabStat);

  // `fetched_at` dice cuándo lo bajamos; `asOf` es el trimestre contable al
  // que se refiere. Si el cron lleva días caído hay que decirlo en vez de
  // presentar como actual un múltiplo viejo.
  const rancio = m.ageHours != null && m.ageHours > 72;

  return (
    <details className="group shrink-0 border-b border-border/60 bg-card/20">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-2.5 hover:bg-card/40">
        <Sigma className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
          Fundamentales
        </span>
        {cabValue && (
          <span className="shrink-0 font-mono text-[11px] font-semibold tabular-nums text-foreground">
            <span className="text-muted-foreground/70">{cabLabel} </span>
            {cabValue}
          </span>
        )}
        {cabNote && (
          <span className="hidden truncate font-mono text-[9px] text-muted-foreground/60 md:inline">
            {cabNote}
          </span>
        )}
        <span className="ml-auto shrink-0 font-mono text-[9px] text-muted-foreground/50">
          {m.asOf ?? "—"}
          {rancio ? " · dato viejo" : ""}
        </span>
      </summary>

      <div className="grid gap-x-8 gap-y-4 px-4 pb-4 pt-1 sm:grid-cols-2 lg:grid-cols-4">
        <Group title="Qué pagas">
          <Row label="Forward P/E" value={mult(m.forwardPe)} />
          <Row label="P/E (TTM)" value={mult(m.peTtm)} history={m.history.pe} />
          <Row
            label="PEG"
            value={ratio(m.pegTtm)}
            hint="Precio dividido por beneficio, dividido por el crecimiento esperado. Por debajo de 1 el crecimiento no está pagado; alrededor de 2, sí y de sobra."
          />
          <Row label="PEG forward" value={ratio(m.forwardPeg)} />
          <Row label="P/S" value={mult(m.psTtm)} history={m.history.ps} />
          <Row
            label="EV/EBITDA"
            value={mult(m.evEbitdaTtm)}
            history={m.history.evEbitda}
          />
          <Row
            label="EV/FCF"
            value={mult(m.evFcf)}
            hint="Valor de empresa sobre flujo de caja libre. En plena ola de capex baja el FCF y este múltiplo se dispara sin que el negocio empeore."
          />
          <Row label="P/B" value={mult(m.pb)} history={m.history.pb} />
        </Group>

        <Group title="Si lo vale">
          <Row
            label="ROIC"
            value={pct(m.roicTtm)}
            hint="Lo que saca por cada euro invertido en el negocio. Es la cifra que justifica que una empresa siga gastando fuerte."
          />
          <Row label="ROE" value={pct(m.roeTtm)} />
          <Row label="Margen bruto" value={pct(m.grossMarginTtm)} />
          <Row label="Margen operativo" value={pct(m.operatingMarginTtm)} />
          <Row label="Margen neto" value={pct(m.netMarginTtm)} />
          <Row
            label="Margen FCF"
            value={pct(m.fcfMargin)}
            hint="Qué parte de cada euro facturado acaba siendo caja libre."
          />
        </Group>

        <Group title="Cuánto crece">
          <Row label="Ingresos interanual" value={pct(m.revenueGrowthTtmYoy)} />
          <Row
            label="Ingresos 3 años"
            value={pct(m.revenueGrowth3y)}
            hint="El compuesto a 3 años dice si el interanual de hoy es la tendencia o un rebote."
          />
          <Row label="BPA interanual" value={pct(m.epsGrowthTtmYoy)} />
          <Row label="BPA 3 años" value={pct(m.epsGrowth3y)} />
        </Group>

        <Group title="Cómo aguanta">
          <Row label="Deuda / fondos propios" value={ratio(m.totalDebtToEquity)} />
          <Row
            label="Ratio corriente"
            value={ratio(m.currentRatio)}
            hint="Activo corriente sobre pasivo corriente: por debajo de 1 depende de refinanciar."
          />
          <Row label="Rentabilidad por dividendo" value={pct(m.dividendYieldTtm)} />
          <Row label="Payout" value={pct(m.payoutRatioTtm)} />
        </Group>
      </div>

      {/* Un dato DESCARTADO y uno ausente piden reacciones distintas, así que
          el descarte se enseña en vez de dejar el hueco mudo. El caso que
          obligó al gate: SOFI publicando margen neto −19,79% junto a un BPA
          y un ROE positivos. */}
      {m.discarded.length > 0 && (
        <div className="flex items-start gap-2 border-t border-border/40 px-4 py-2">
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0 text-amber-600 dark:text-amber-400" />
          <p className="font-mono text-[9px] leading-relaxed text-muted-foreground">
            <span className="text-amber-700 dark:text-amber-300">
              Descartado por incoherencia con el resto del bloque:
            </span>{" "}
            {m.discarded.map((d) => `${d.field} (${d.reason})`).join(" · ")}
          </p>
        </div>
      )}

      <p className="px-4 pb-3 font-mono text-[9px] leading-relaxed text-muted-foreground/50">
        Percentiles calculados contra los últimos 5 años de la propia empresa,
        excluyendo los trimestres en pérdidas. No van coloreados a propósito:
        un múltiplo bajo es barato o es una trampa según qué clase de empresa
        sea, y eso lo dice el marco que le hayas puesto, no la cifra.
      </p>
    </details>
  );
}
