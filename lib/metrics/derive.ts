import type {
  FinnhubBasicFinancials,
  MetricPoint,
} from "@/lib/providers/finnhub";

// Derivación de `/stock/metric?metric=all` (Finnhub) a las cifras que el
// proyecto lee. Aquí NO se llama a la red ni a la BD: entra el payload
// crudo, sale un objeto plano y auditado.
//
// Tres cosas hace este módulo y ninguna es opcional:
//   1. Normalizar unidades — la serie y el objeto plano NO hablan igual.
//   2. Situar cada múltiplo contra SU PROPIA historia (percentil), que es la
//      única lectura de valoración que no necesita un umbral universal.
//   3. Tirar lo que se contradice, dejando constancia de qué se tiró.

/** Ventana del percentil: 20 trimestres = 5 años. La serie llega mucho más
 *  atrás (MSFT tiene 104 trimestres de P/E, hasta el año 2000) y usarla
 *  entera sería comparar la empresa de hoy con otra empresa: el MSFT de
 *  Ballmer no acota el múltiplo del MSFT de Azure. Cinco años es el
 *  compromiso habitual — cubre un ciclo sin arrastrar otra era. */
const PCTILE_WINDOW_QUARTERS = 20;

/** Mínimo de trimestres VÁLIDOS para publicar un percentil. Con menos, el
 *  percentil existe aritméticamente pero no significa nada: 4 observaciones
 *  hacen que cualquier valor caiga en el 0, 25, 50, 75 o 100. Devolver
 *  `null` dice "no hay historia comparable", que es la verdad para una
 *  empresa que acaba de entrar en beneficios. */
const PCTILE_MIN_POINTS = 12;

/** Métricas cuya serie viene en FRACCIÓN mientras el objeto plano las da en
 *  PORCENTAJE. Medido 2026-08-11 sobre MSFT: `series.quarterly.roeTTM` = 0,3322
 *  y `metric.roeTTM` = 33,22 — factor 100 exacto. En cambio
 *  `totalDebtToEquity` (0,2416) y `currentRatio` (1,2303) valen igual en los
 *  dos sitios porque son adimensionales.
 *
 *  Va como lista explícita y no como heurística ("si es <1 multiplico") justo
 *  porque el caso peligroso es indistinguible: un margen del 0,7% y un margen
 *  del 70% expresado en fracción son el mismo 0,7 en pantalla. */
const SERIES_IS_FRACTION = new Set([
  "grossMargin",
  "netMargin",
  "operatingMargin",
  "pretaxMargin",
  "fcfMargin",
  "roeTTM",
  "roaTTM",
  "roicTTM",
  "rotcTTM",
]);

/** Dónde cae el valor de hoy dentro de su propia historia. */
export type HistoryStat = {
  /** % de la distribución histórica POR DEBAJO del valor actual. Bajo =
   *  barato contra su propia historia. 25 se lee "más barato que el 75% de
   *  sus últimos 5 años". */
  pctile: number;
  /** Mediana de la ventana — es lo que hace legible el percentil. */
  median: number;
  /** Trimestres válidos que forman la distribución. */
  n: number;
};

export type ValuationHistory = {
  pe?: HistoryStat;
  ps?: HistoryStat;
  pb?: HistoryStat;
  evEbitda?: HistoryStat;
};

/** Una cifra que se descartó y por qué. Se guarda y se enseña: un dato que
 *  desaparece sin decirlo es indistinguible de un dato que la fuente no
 *  tenía, y las dos cosas piden reacciones distintas. */
export type DiscardNote = { field: string; reason: string };

export type TickerMetrics = {
  // --- Valoración (¿qué pagas?) ---
  forwardPe: number | null;
  peTtm: number | null;
  pegTtm: number | null;
  forwardPeg: number | null;
  evEbitdaTtm: number | null;
  psTtm: number | null;
  pb: number | null;
  pTbv: number | null;
  evFcf: number | null;
  // --- Calidad (¿merece lo que pagas?) ---
  roeTtm: number | null;
  roicTtm: number | null;
  grossMarginTtm: number | null;
  operatingMarginTtm: number | null;
  netMarginTtm: number | null;
  fcfMargin: number | null;
  // --- Crecimiento ---
  revenueGrowthTtmYoy: number | null;
  revenueGrowth3y: number | null;
  epsGrowthTtmYoy: number | null;
  epsGrowth3y: number | null;
  // --- Estructura ---
  totalDebtToEquity: number | null;
  currentRatio: number | null;
  dividendYieldTtm: number | null;
  payoutRatioTtm: number | null;
  // --- Contra su propia historia ---
  history: ValuationHistory;
  // --- Auditoría del dato ---
  discarded: DiscardNote[];
  /** Trimestre más reciente de la serie ("2026-06-30"). Es la fecha real del
   *  dato contable; `fetched_at` sólo dice cuándo lo bajamos. */
  asOf: string | null;
};

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Múltiplo: sólo vale si es POSITIVO. Un P/E de −12 no es "muy barato", es
 *  "no hay beneficios", y ordenar por él pone a las empresas en pérdidas en
 *  cabeza de cualquier ranking de valor. Mismo criterio para P/S, P/B,
 *  EV/EBITDA y PEG. */
function multiple(v: unknown): number | null {
  const n = num(v);
  return n != null && n > 0 ? n : null;
}

/** Valor más reciente de una serie, normalizando la unidad. Existe porque
 *  `roicTTM` y `fcfMargin` NO están en el objeto plano — sólo en la serie —,
 *  así que sin esto el ROIC (la métrica de calidad que más importa en un
 *  negocio intensivo en capital) simplemente no existiría. */
function latestFromSeries(
  quarterly: Record<string, MetricPoint[]> | undefined,
  key: string,
): number | null {
  // Finnhub devuelve el más reciente PRIMERO (medido: de 2026-06-30 hacia
  // 1990-03-31). Asumir orden ascendente daría el dato de hace 36 años.
  const v = num(quarterly?.[key]?.[0]?.v);
  if (v == null) return null;
  return SERIES_IS_FRACTION.has(key) ? v * 100 : v;
}

/** Sitúa `current` en la distribución de sus últimos `PCTILE_WINDOW_QUARTERS`
 *  trimestres. `positiveOnly` filtra los tramos sin sentido (ver `multiple`):
 *  una empresa que pasó de pérdidas a beneficios tiene media ventana con P/E
 *  negativo, y meterlos en la distribución haría que el múltiplo de hoy
 *  saliera "carísimo" comparado con unos números que no eran múltiplos. */
export function historyStat(
  points: MetricPoint[] | undefined,
  current: number | null,
  positiveOnly = true,
): HistoryStat | null {
  if (current == null || !points?.length) return null;
  const window = points
    .slice(0, PCTILE_WINDOW_QUARTERS)
    .map((p) => num(p.v))
    .filter((v): v is number => v != null && (!positiveOnly || v > 0));
  if (window.length < PCTILE_MIN_POINTS) return null;
  const sorted = [...window].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  const below = window.filter((v) => v < current).length;
  return {
    pctile: Math.round((below / window.length) * 100),
    median: Math.round(median * 100) / 100,
    n: window.length,
  };
}

/** Gate de coherencia. NO valida rangos "razonables" (eso sería un umbral
 *  disfrazado y este proyecto ya sabe cómo acaba): sólo caza cifras que se
 *  contradicen ENTRE SÍ, que es una avería del dato y no una opinión.
 *
 *  El caso que lo obligó, medido el 2026-08-11 sobre SOFI:
 *      netProfitMarginTTM = −19,79 %      epsTTM = +0,47
 *      operatingMarginTTM = −19,92 %      roeTTM = +6,18 %   peTTM = 36,78
 *  Una empresa con BPA positivo, ROE positivo y un P/E válido no puede tener
 *  margen neto negativo: el denominador que usa la fuente no es el ingreso de
 *  un banco. Sin este gate esa cifra llega al prompt de una decisión y el
 *  modelo argumenta sobre una empresa que pierde dinero cuando gana.
 *
 *  Se descarta la FAMILIA (neto + operativo comparten denominador), no sólo
 *  la cifra que chirría: si el ingreso está mal, todos los márgenes que lo
 *  dividen están mal, y dejar el operativo en pie sería servir el mismo error
 *  con otra etiqueta. */
function applyCoherenceGate(
  m: TickerMetrics,
  epsTtm: number | null,
): DiscardNote[] {
  const notes: DiscardNote[] = [];

  const profitable =
    (epsTtm != null && epsTtm > 0) || (m.roeTtm != null && m.roeTtm > 0);
  const losing = epsTtm != null && epsTtm < 0;
  const marginSaysLoss = m.netMarginTtm != null && m.netMarginTtm < 0;
  const marginSaysProfit = m.netMarginTtm != null && m.netMarginTtm > 0;

  if ((marginSaysLoss && profitable && !losing) || (marginSaysProfit && losing)) {
    notes.push({
      field: "margins",
      reason: `margen neto ${m.netMarginTtm?.toFixed(1)}% contradice BPA ${
        epsTtm ?? "?"
      } y ROE ${m.roeTtm ?? "?"}% — denominador incoherente en la fuente`,
    });
    m.netMarginTtm = null;
    m.operatingMarginTtm = null;
  }

  // Margen bruto fuera de (0, 100]: no es una empresa mala, es un dato roto.
  // El 100% es un techo contable, no una calibración de riesgo.
  if (m.grossMarginTtm != null && (m.grossMarginTtm <= 0 || m.grossMarginTtm > 100)) {
    notes.push({
      field: "grossMarginTtm",
      reason: `${m.grossMarginTtm.toFixed(1)}% fuera del rango contable (0,100]`,
    });
    m.grossMarginTtm = null;
  }

  // P/E positivo con BPA negativo: uno de los dos miente y no sabemos cuál,
  // así que cae el múltiplo (es el que se usaría para decidir).
  if (m.peTtm != null && epsTtm != null && epsTtm < 0) {
    notes.push({
      field: "peTtm",
      reason: `P/E ${m.peTtm.toFixed(1)} con BPA ${epsTtm} — incompatibles`,
    });
    m.peTtm = null;
  }

  return notes;
}

export function deriveMetrics(raw: FinnhubBasicFinancials): TickerMetrics {
  const m = raw.metric ?? {};
  const q = raw.series?.quarterly;
  const epsTtm = num(m.epsTTM);

  const out: TickerMetrics = {
    forwardPe: multiple(m.forwardPE),
    peTtm: multiple(m.peTTM),
    pegTtm: multiple(m.pegTTM),
    forwardPeg: multiple(m.forwardPEG),
    evEbitdaTtm: multiple(m.evEbitdaTTM),
    psTtm: multiple(m.psTTM),
    pb: multiple(m.pb),
    pTbv: multiple(m.ptbvAnnual),
    evFcf: multiple(m["currentEv/freeCashFlowTTM"]),

    roeTtm: num(m.roeTTM),
    // `roiTTM` es lo más cercano a ROIC que trae el objeto plano, pero la
    // serie sí tiene `roicTTM` propiamente dicho: se prefiere el segundo y el
    // primero queda de respaldo.
    roicTtm: latestFromSeries(q, "roicTTM") ?? num(m.roiTTM),
    grossMarginTtm: num(m.grossMarginTTM),
    operatingMarginTtm: num(m.operatingMarginTTM),
    netMarginTtm: num(m.netProfitMarginTTM),
    fcfMargin: latestFromSeries(q, "fcfMargin"),

    revenueGrowthTtmYoy: num(m.revenueGrowthTTMYoy),
    revenueGrowth3y: num(m.revenueGrowth3Y),
    epsGrowthTtmYoy: num(m.epsGrowthTTMYoy),
    epsGrowth3y: num(m.epsGrowth3Y),

    totalDebtToEquity: num(m["totalDebt/totalEquityQuarterly"]),
    currentRatio: num(m.currentRatioQuarterly),
    dividendYieldTtm: num(m.currentDividendYieldTTM),
    payoutRatioTtm: num(m.payoutRatioTTM),

    history: {},
    discarded: [],
    asOf: q?.peTTM?.[0]?.period ?? q?.pb?.[0]?.period ?? null,
  };

  out.discarded = applyCoherenceGate(out, epsTtm);

  // El percentil compara el múltiplo VIVO (objeto plano, precio de hoy)
  // contra una distribución de CIERRES DE TRIMESTRE. Es deliberado y es la
  // convención de "múltiplo actual vs su rango histórico": medido en MSFT, el
  // plano da P/E 28,08 y el último punto de la serie 20,72 — no es una
  // discrepancia, es que el segundo lleva el precio del 30-jun.
  //
  // Se calcula DESPUÉS del gate para que un múltiplo descartado no reciba un
  // percentil que lo resucitaría por la puerta de atrás.
  out.history = {
    pe: historyStat(q?.peTTM, out.peTtm) ?? undefined,
    ps: historyStat(q?.psTTM, out.psTtm) ?? undefined,
    pb: historyStat(q?.pb, out.pb) ?? undefined,
    evEbitda: historyStat(q?.evEbitdaTTM, out.evEbitdaTtm) ?? undefined,
  };

  return out;
}
