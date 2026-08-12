import type { TickerMetrics } from "@/lib/metrics/derive";

// Por qué falta una cifra del panel de fundamentales. Aquí NO se rellena
// nada: se pone nombre al hueco. Una raya muda tiene cuatro causas que piden
// reacciones opuestas y en pantalla eran indistinguibles (medido 2026-08-11
// sobre la watchlist real: RKLB enseñaba 12 rayas y todas parecían el mismo
// bug de carga):
//
//   pérdidas    → el dato NO EXISTE: sin beneficios no hay P/E que publicar.
//   no paga     → la fuente no publica dividendo — el patrón de quien no
//                 reparte. Un 0 afirmaría algo que la fuente no dice.
//   descartado  → la fuente lo publicó y el gate de coherencia lo tiró;
//                 la razón medida viaja con la etiqueta.
//   no publica  → la clave falta en el payload. No es un fallo de carga:
//                 pasa donde el concepto no aplica (EBITDA en banca) o donde
//                 Finnhub no cubre el dato.
//
// La doctrina es la de `DiscardNote`: un dato ausente y uno descartado piden
// reacciones distintas, así que se distingue en vez de dejar el hueco mudo.

/** Los campos numéricos del panel — `history`/`discarded`/`asOf` quedan
 *  fuera a propósito: no son cifras con hueco. */
export type MetricField =
  | "forwardPe"
  | "peTtm"
  | "pegTtm"
  | "forwardPeg"
  | "evEbitdaTtm"
  | "psTtm"
  | "pb"
  | "pTbv"
  | "evFcf"
  | "roeTtm"
  | "roicTtm"
  | "grossMarginTtm"
  | "operatingMarginTtm"
  | "netMarginTtm"
  | "fcfMargin"
  | "revenueGrowthTtmYoy"
  | "revenueGrowth3y"
  | "revenueGrowth5y"
  | "epsGrowthTtmYoy"
  | "epsGrowth3y"
  | "fcfCagr5y"
  | "totalDebtToEquity"
  | "currentRatio"
  | "dividendYieldTtm"
  | "payoutRatioTtm";

export type Gap = { label: string; why: string };

/** Campos que dependen del BENEFICIO: si la empresa pierde dinero, el hueco
 *  no es un dato ausente sino un dato inexistente. EV/EBITDA queda fuera a
 *  propósito: una pérdida neta NO implica EBITDA negativo, y afirmarlo sería
 *  inventar la causa. */
const LOSS_FIELDS: ReadonlySet<MetricField> = new Set([
  "peTtm",
  "pegTtm",
  "epsGrowthTtmYoy",
  "epsGrowth3y",
]);

const DIVIDEND_FIELDS: ReadonlySet<MetricField> = new Set([
  "dividendYieldTtm",
  "payoutRatioTtm",
]);

/** Qué campos del panel cubre cada `DiscardNote.field`. "margins" descarta
 *  la FAMILIA (neto + operativo comparten denominador). */
const DISCARD_COVERS: Record<string, MetricField[]> = {
  margins: ["netMarginTtm", "operatingMarginTtm"],
  grossMarginTtm: ["grossMarginTtm"],
  peTtm: ["peTtm"],
};

const PERDIDAS: Gap = {
  label: "pérdidas",
  why:
    "La empresa pierde dinero (TTM): con el beneficio en negativo no existe " +
    "P/E, PEG ni crecimiento del BPA que publicar. No es un hueco de datos — " +
    "es la respuesta.",
};

const NO_PAGA: Gap = {
  label: "no paga",
  why:
    "Finnhub no publica ni rentabilidad ni payout para este valor — el " +
    "patrón de una empresa que no reparte dividendo. Enseñar 0% afirmaría " +
    "algo que la fuente no dice.",
};

const NO_PUBLICA: Gap = {
  label: "no publica",
  why:
    "La clave falta en el payload de Finnhub para este valor; no es un fallo " +
    "de carga. Pasa donde el concepto no aplica (EBITDA o ratio corriente en " +
    "banca, un CAGR cuya base era una pérdida) o donde la fuente no cubre el " +
    "dato.",
};

/** ¿Pierde dinero (TTM)? Solo se afirma con evidencia del propio payload:
 *  margen neto negativo, o el descarte de P/E que únicamente existe cuando
 *  el BPA era negativo. Sin evidencia se devuelve false y el hueco cae a
 *  "no publica" — no afirmar lo que no se puede probar. */
export function inLosses(m: TickerMetrics): boolean {
  if (m.netMarginTtm != null) return m.netMarginTtm < 0;
  return m.discarded.some((n) => n.field === "peTtm");
}

/** Etiqueta para el hueco de `field`, o null si la cifra existe. */
export function gapFor(m: TickerMetrics, field: MetricField): Gap | null {
  if (m[field] != null) return null;

  const note = m.discarded.find((n) =>
    (DISCARD_COVERS[n.field] ?? [n.field as MetricField]).includes(field),
  );
  if (note) return { label: "descartado", why: note.reason };

  if (LOSS_FIELDS.has(field) && inLosses(m)) return PERDIDAS;

  if (
    DIVIDEND_FIELDS.has(field) &&
    m.dividendYieldTtm == null &&
    m.payoutRatioTtm == null
  ) {
    return NO_PAGA;
  }

  return NO_PUBLICA;
}
