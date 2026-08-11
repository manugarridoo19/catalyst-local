import { getCikForSymbol } from "@/lib/providers/sec-edgar";
import type { XbrlPoint } from "@/lib/metrics/dilution";

// XBRL estructurado de la SEC (`companyconcept`). Node-only, igual que el
// resto de la ingesta: el Worker sólo lee de Postgres.
//
// POR QUÉ `companyconcept` Y NO `companyfacts`: el segundo trae TODOS los
// conceptos de la empresa en una respuesta que para una grande pasa de los
// 10 MB, y de ahí usaríamos tres. Tres llamadas pequeñas salen más baratas
// en red y en memoria que una enorme.
//
// SIN CLAVE Y SIN CUOTA: sólo exige User-Agent identificable y un máximo de
// 10 peticiones por segundo.

const SEC_UA = "catalyst-local manubisbal19@gmail.com";
const TIMEOUT_MS = 12_000;

/**
 * Las dos taxonomías, y no es un extra.
 *
 * Un emisor extranjero (NU, dLocal, MercadoLibre…) presenta 20-F bajo IFRS y
 * NO publica un solo concepto `us-gaap`: pedirle
 * `WeightedAverageNumberOfDilutedSharesOutstanding` devuelve 404 para todo.
 * Verificado en NU el 2026-08-11: sus 151 conceptos viven íntegramente en
 * `ifrs-full`. Es la misma familia de sorpresa que ya obligó a enseñarle al
 * lector de resultados que un FPI presenta 6-K y no 8-K.
 *
 * El precio de admitirlos es la CADENCIA: al presentar una vez al año, su
 * dato más reciente puede tener año y medio. Eso se propaga hasta el panel
 * en vez de disimularse.
 */
const CONCEPTS = {
  "us-gaap": {
    shares: "WeightedAverageNumberOfDilutedSharesOutstanding",
    sbc: "ShareBasedCompensation",
    buybacks: "PaymentsForRepurchaseOfCommonStock",
  },
  "ifrs-full": {
    shares: "AdjustedWeightedAverageShares",
    sbc: "ExpenseFromSharebasedPaymentTransactionsWithEmployees",
    buybacks: "PaymentsToAcquireOrRedeemEntitysShares",
  },
} as const;

export type XbrlBundle = {
  taxonomy: keyof typeof CONCEPTS;
  shares: XbrlPoint[];
  sbc: XbrlPoint[];
  buybacks: XbrlPoint[];
};

async function concept(
  cik: string,
  taxonomy: string,
  name: string,
): Promise<XbrlPoint[]> {
  const url = `https://data.sec.gov/api/xbrl/companyconcept/CIK${cik}/${taxonomy}/${name}.json`;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": SEC_UA, Accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    // 404 NO es un fallo: significa que esta empresa no publica ese concepto.
    // Una tecnológica en pérdidas no tiene `PaymentsForRepurchaseOfCommonStock`
    // porque no recompra, y eso es una respuesta, no un hueco. Se distingue
    // del error de red devolviendo [] en los dos casos pero sin reintentar.
    if (!res.ok) return [];
    const json = (await res.json()) as {
      units?: Record<string, XbrlPoint[]>;
    };
    // El concepto declara su unidad ("shares", "USD"). Sólo hay una por
    // concepto en la práctica; se toma la primera sin adivinar cuál.
    const units = Object.values(json.units ?? {});
    return units[0] ?? [];
  } catch {
    return [];
  }
}

/**
 * Los tres conceptos de dilución de un símbolo, probando us-gaap y cayendo a
 * IFRS. Hasta 6 peticiones en el peor caso (3 fallidas + 3 buenas), 3 en el
 * normal.
 *
 * La taxonomía se decide por el CONTEO DE ACCIONES y no por los tres a la
 * vez: es el único concepto imprescindible, y una empresa estadounidense sin
 * recompras dejaría el bloque vacío si exigiéramos los tres.
 */
export async function fetchDilutionFacts(
  symbol: string,
): Promise<XbrlBundle | null> {
  const cik = await getCikForSymbol(symbol);
  if (!cik) return null;

  for (const taxonomy of ["us-gaap", "ifrs-full"] as const) {
    const c = CONCEPTS[taxonomy];
    const shares = await concept(cik, taxonomy, c.shares);
    if (shares.length === 0) continue;
    const [sbc, buybacks] = await Promise.all([
      concept(cik, taxonomy, c.sbc),
      concept(cik, taxonomy, c.buybacks),
    ]);
    return { taxonomy, shares, sbc, buybacks };
  }
  return null;
}
