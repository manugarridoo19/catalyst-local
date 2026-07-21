// CUSIP → ticker vía OpenFIGI (Bloomberg). Es el GATE que el design doc
// exigía resolver antes de la sub-fase 13F: el information table identifica
// las posiciones por CUSIP y Catalyst indexa todo por ticker.
//
// Gratis y SIN key: 25 peticiones/minuto anónimas y **10 identificadores por
// petición** (el 413 dice literalmente "Request may only contain 10 mapping
// jobs"; con key son 100). MEDIDO el 2026-07-21 con Berkshire: el spike
// inicial mandó 2 CUSIPs y por eso no tocó el techo — cuidado con dar por
// bueno un límite que no se ha llegado a rozar.
//
// La caché es PERMANENTE por diseño (tabla `cusip_map`): un CUSIP identifica
// una emisión concreta para siempre, así que resolverlo dos veces sería tirar
// cuota. Los NO resueltos también se guardan (symbol NULL) — si no, cada
// trimestre volveríamos a preguntar por los mismos bonos y clases no
// cotizadas.

import { sql } from "drizzle-orm";
import { db, unwrapRows } from "@/lib/db";

const URL = "https://api.openfigi.com/v3/mapping";
/** Tope DURO de la API anónima: 11 o más devuelve 413. */
const MAX_PER_REQUEST = 10;
const TIMEOUT_MS = 25_000;
/** Sin key el límite es 25 req/min: 2,5s entre lotes deja margen de sobra. */
const GAP_MS = 2_500;
/** Peticiones por invocación. A 10 CUSIPs y 2,5s cada una, 40 son ~100s: el
 *  techo que cabe en el presupuesto del tick compartiéndolo con todo lo
 *  demás. Lo que no entre se resuelve en la pasada siguiente — la caché es
 *  permanente, así que el coste es de una vez. */
const DEFAULT_MAX_REQUESTS = 40;

type FigiRow = {
  ticker?: string;
  name?: string;
  exchCode?: string;
  securityType?: string;
};

async function callOpenFigi(cusips: string[]): Promise<Map<string, FigiRow>> {
  const res = await fetch(URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(cusips.map((c) => ({ idType: "ID_CUSIP", idValue: c }))),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`openfigi ${res.status}: ${(await res.text()).slice(0, 140)}`);
  }
  const json = (await res.json()) as Array<{ data?: FigiRow[]; warning?: string }>;
  const out = new Map<string, FigiRow>();
  json.forEach((entry, i) => {
    const cusip = cusips[i];
    const rows = entry.data ?? [];
    // Un CUSIP devuelve una fila por plaza de cotización (US, UA, UC...).
    // Nos quedamos con la composite estadounidense, que es el ticker que usa
    // el resto de Catalyst; si no la hay, la primera con ticker.
    const pick = rows.find((r) => r.exchCode === "US" && r.ticker) ?? rows.find((r) => r.ticker);
    if (pick) out.set(cusip, pick);
  });
  return out;
}

/**
 * Resuelve CUSIPs a tickers usando la caché y preguntando sólo por los que
 * falten. Devuelve el mapa completo (los no cotizados quedan como null).
 */
export async function resolveCusips(
  cusips: string[],
  opts: { maxRequests?: number } = {},
): Promise<Map<string, string | null>> {
  const maxRequests = opts.maxRequests ?? DEFAULT_MAX_REQUESTS;
  const unique = [...new Set(cusips.map((c) => c.trim().toUpperCase()))].filter(
    Boolean,
  );
  const resolved = new Map<string, string | null>();
  if (unique.length === 0) return resolved;

  const cached = unwrapRows<{ cusip: string; symbol: string | null }>(
    await db.execute(sql`
      SELECT cusip, symbol FROM cusip_map
      WHERE cusip IN (${sql.join(
        unique.map((c) => sql`${c}`),
        sql`, `,
      )})
    `),
  );
  for (const r of cached) resolved.set(r.cusip, r.symbol);

  const missing = unique.filter((c) => !resolved.has(c));
  if (missing.length === 0) return resolved;

  const capped = missing.slice(0, maxRequests * MAX_PER_REQUEST);
  if (capped.length < missing.length) {
    console.log(
      `[openfigi] ${missing.length - capped.length} CUSIPs quedan para la siguiente pasada (tope ${maxRequests} peticiones)`,
    );
  }
  for (let i = 0; i < capped.length; i += MAX_PER_REQUEST) {
    const batch = capped.slice(i, i + MAX_PER_REQUEST);
    let found: Map<string, FigiRow>;
    try {
      found = await callOpenFigi(batch);
    } catch (err) {
      // Un lote que falle no invalida lo ya resuelto: lo que falte se
      // reintenta en la siguiente pasada (no se cachea el fallo).
      console.warn(
        "[openfigi] lote falló:",
        err instanceof Error ? err.message.slice(0, 140) : err,
      );
      continue;
    }
    for (const cusip of batch) {
      const hit = found.get(cusip);
      const symbol = hit?.ticker?.toUpperCase() ?? null;
      resolved.set(cusip, symbol);
      try {
        await db.execute(sql`
          INSERT INTO cusip_map (cusip, symbol, name)
          VALUES (${cusip}, ${symbol}, ${hit?.name?.slice(0, 120) ?? null})
          ON CONFLICT (cusip) DO NOTHING
        `);
      } catch (err) {
        console.warn(
          `[openfigi] cache ${cusip} falló:`,
          err instanceof Error ? err.message.slice(0, 100) : err,
        );
      }
    }
    if (i + MAX_PER_REQUEST < capped.length) {
      await new Promise((r) => setTimeout(r, GAP_MS));
    }
  }
  return resolved;
}
