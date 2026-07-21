// Short interest consolidado de FINRA — Fase 3 del roadmap Catalyst 2.0.
//
// Gratis y SIN autenticación (verificado 2026-07-21): el resto de la API de
// FINRA pide OAuth, pero el dataset `otcMarket/consolidatedShortInterest`
// responde a un POST anónimo. Cero cuentas nuevas, cero keys. Cumple la
// premisa 4 del design doc (nada de scraping frágil): es un endpoint de datos
// con esquema estable, no HTML.
//
// Tres particularidades que condicionan TODO el diseño de la ingesta:
//
//  1. `settlementDate` es CLAVE DE PARTICIÓN: no se puede ordenar por ella ni
//     pedir "la más reciente" (400 "Sorting is allowed only if all partition
//     keys are specified in EQUAL CompareFilter"). Hay que preguntar por una
//     fecha exacta, así que probamos las candidatas del calendario de FINRA
//     de la más nueva a la más vieja hasta que una devuelva filas.
//  2. FINRA publica con ~2 SEMANAS DE RETRASO sobre la fecha de liquidación
//     (el 2026-07-21 lo más reciente disponible era el 2026-06-30, y el
//     2026-07-15 aún no existía). No es un fallo: el short interest es un
//     indicador quincenal y lento. Cualquier UI que lo pinte debe enseñar la
//     fecha de liquidación, nunca "hoy".
//  3. Cada respuesta trae como mucho 5.000 filas → se pagina con `offset`.
//
// El dataset NO trae free float, así que el % de float es incalculable con
// esta fuente. Por eso la señal v1 se apoya en days-to-cover, que sí viene
// dado y no obliga a inventar un denominador.

const BASE =
  "https://api.finra.org/data/group/otcMarket/name/consolidatedShortInterest";
const PAGE_SIZE = 5000;
const TIMEOUT_MS = 30_000;

export type ShortInterestRecord = {
  symbol: string;
  settlementDate: string;
  currentShortQty: number;
  previousShortQty: number | null;
  avgDailyVolume: number | null;
  daysToCover: number | null;
  changePercent: number | null;
  marketClass: string | null;
  issueName: string | null;
};

type RawRow = {
  symbolCode?: string;
  settlementDate?: string;
  currentShortPositionQuantity?: number;
  previousShortPositionQuantity?: number;
  averageDailyVolumeQuantity?: number;
  daysToCoverQuantity?: number;
  changePercent?: number;
  marketClassCode?: string;
  issueName?: string;
};

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** FINRA usa 999.99 como CENTINELA de "days-to-cover no calculable" (volumen
 *  medio cero o ridículo), no como un valor de verdad. Guardarlo tal cual
 *  haría que el mayor days-to-cover del universo fuese siempre un chicharro
 *  sin volumen: 33 filas de la quincena del 2026-06-30. Se normaliza a null. */
const DTC_SENTINEL = 999;

function daysToCover(v: unknown): number | null {
  const n = num(v);
  return n !== null && n < DTC_SENTINEL ? n : null;
}

function normalize(r: RawRow): ShortInterestRecord | null {
  const symbol = r.symbolCode?.trim().toUpperCase();
  const settlementDate = r.settlementDate?.trim();
  const current = num(r.currentShortPositionQuantity);
  if (!symbol || !settlementDate || current === null) return null;
  return {
    symbol,
    settlementDate,
    currentShortQty: current,
    previousShortQty: num(r.previousShortPositionQuantity),
    avgDailyVolume: num(r.averageDailyVolumeQuantity),
    daysToCover: daysToCover(r.daysToCoverQuantity),
    changePercent: num(r.changePercent),
    marketClass: r.marketClassCode?.trim() || null,
    issueName: r.issueName?.trim().slice(0, 120) || null,
  };
}

async function query(body: Record<string, unknown>): Promise<RawRow[]> {
  const res = await fetch(BASE, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
    // Regla del repo: todo fetch del camino del cron lleva timeout.
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`finra ${res.status}: ${(await res.text()).slice(0, 160)}`);
  }
  // Una fecha de liquidación aún no publicada responde 200 con el cuerpo
  // VACÍO (no `[]`), así que `res.json()` peta con "Unexpected end of JSON
  // input". Es el caso NORMAL — la mitad de las candidatas que probamos aún
  // no existen — así que se trata como "sin filas", no como error.
  const text = (await res.text()).trim();
  if (!text) return [];
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`finra: respuesta no-JSON: ${text.slice(0, 120)}`);
  }
  return Array.isArray(json) ? (json as RawRow[]) : [];
}

/**
 * Fechas de liquidación candidatas, de la más reciente a la más antigua.
 * FINRA liquida el día 15 y el último día natural de cada mes; si cae en
 * fin de semana el dato aparece igualmente fechado ahí, así que no hace
 * falta calendario bursátil — probamos y quien no exista devuelve vacío.
 */
export function candidateSettlementDates(from: Date, count = 6): string[] {
  const out: string[] = [];
  const d = new Date(
    Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()),
  );
  let year = d.getUTCFullYear();
  let month = d.getUTCMonth();
  // Arrancamos en el fin de mes actual y vamos hacia atrás alternando
  // fin-de-mes / día 15.
  const push = (y: number, m: number, day: number) => {
    const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    const dd = day === 0 ? last : day;
    const iso = `${y}-${String(m + 1).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
    if (new Date(`${iso}T00:00:00Z`) <= d) out.push(iso);
  };
  while (out.length < count) {
    push(year, month, 0);
    push(year, month, 15);
    month -= 1;
    if (month < 0) {
      month = 11;
      year -= 1;
    }
    if (year < d.getUTCFullYear() - 2) break;
  }
  return out.sort((a, b) => (a < b ? 1 : -1)).slice(0, count);
}

/** ¿Hay datos publicados para esa fecha de liquidación? (1 fila de sonda) */
export async function settlementDateHasData(date: string): Promise<boolean> {
  const rows = await query({
    limit: 1,
    compareFilters: [
      { fieldName: "settlementDate", fieldValue: date, compareType: "EQUAL" },
    ],
  });
  return rows.length > 0;
}

/**
 * Snapshot completo de una fecha de liquidación, paginado. `keep` filtra en
 * memoria al universo que seguimos: FINRA publica ~12k símbolos y a nosotros
 * solo nos interesan los que ya están en `tickers`.
 */
export async function fetchShortInterestSnapshot(
  date: string,
  keep?: (symbol: string) => boolean,
  maxPages = 4,
): Promise<ShortInterestRecord[]> {
  const out: ShortInterestRecord[] = [];
  for (let page = 0; page < maxPages; page++) {
    const raw = await query({
      limit: PAGE_SIZE,
      offset: page * PAGE_SIZE,
      compareFilters: [
        { fieldName: "settlementDate", fieldValue: date, compareType: "EQUAL" },
      ],
    });
    for (const r of raw) {
      const rec = normalize(r);
      if (rec && (!keep || keep(rec.symbol))) out.push(rec);
    }
    // Última página: FINRA devolvió menos de lo pedido.
    if (raw.length < PAGE_SIZE) break;
  }
  return out;
}

/** Short interest de UN símbolo en una fecha (para la ticker page). */
export async function fetchShortInterestForSymbol(
  symbol: string,
  date: string,
): Promise<ShortInterestRecord | null> {
  const raw = await query({
    limit: 1,
    compareFilters: [
      { fieldName: "settlementDate", fieldValue: date, compareType: "EQUAL" },
      {
        fieldName: "symbolCode",
        fieldValue: symbol.toUpperCase(),
        compareType: "EQUAL",
      },
    ],
  });
  return raw.length ? normalize(raw[0]) : null;
}
