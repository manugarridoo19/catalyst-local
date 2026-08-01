import { eq, sql } from "drizzle-orm";
import { db, unwrapRows } from "@/lib/db";
import { tickerFundamentals } from "@/lib/db/schema";
import { fetchFundamentals, type FmpPeer } from "@/lib/providers/fmp";

// Capa de cache sobre FMP. La UI llama getOrFetchFundamentals y NUNCA toca
// FMP directamente. Presupuesto free-tier (250 calls/día) protegido por:
//   - TTL de 7 días: un símbolo cuesta 3 calls FMP por semana como mucho.
//   - Cache compartida en BD: aunque el símbolo se visite N veces (o desde
//     varios entornos), solo se re-pega a FMP cuando la fila caduca.
//   - Dedupe in-process: dos requests concurrentes del mismo símbolo hacen
//     una sola llamada.
// Si FMP falla o no hay key, se sirve la fila stale (si existe) o null — la
// ticker page simplemente no pinta el bloque de fundamentales.

const TTL_MS = 7 * 24 * 3600_000;

// TTL del CENTINELA negativo (fila escrita cuando FMP no devolvió nada).
// Es más corto que el positivo a propósito: `fetchFundamentals` colapsa "FMP
// dice que no hay dato" y "no pudimos preguntar" en el mismo `null`, así que
// un centinela de 7 días dejaría un símbolo REAL sin fundamentales una
// semana entera por un corte transitorio de FMP. 24h acota la enumeración
// (que es el abuso) sin castigar al símbolo legítimo más de un día.
const NEGATIVE_TTL_MS = 24 * 3600_000;

/** ¿Es esta fila un centinela negativo? No hay columna que lo diga (el
 *  esquema no se toca), así que se reconoce por lo que es: una fila sin
 *  NINGÚN dato. Un símbolo real con todos los campos vacíos es
 *  indistinguible y se comporta igual de bien — la UI tampoco pintaría
 *  nada con él. */
function isSentinel(r: Row): boolean {
  return (
    r.marketCap == null &&
    r.pe == null &&
    r.beta == null &&
    r.sector == null &&
    r.industry == null &&
    r.yearHigh == null &&
    r.yearLow == null &&
    r.ceo == null
  );
}

export type Fundamentals = {
  marketCap: number | null;
  pe: number | null;
  beta: number | null;
  sector: string | null;
  industry: string | null;
  yearHigh: number | null;
  yearLow: number | null;
  ceo: string | null;
  peers: FmpPeer[];
};

type Row = typeof tickerFundamentals.$inferSelect;

function rowToFundamentals(r: Row): Fundamentals {
  const n = (v: string | null): number | null =>
    v != null && v !== "" && Number.isFinite(Number(v)) ? Number(v) : null;
  return {
    marketCap: r.marketCap ?? null,
    pe: n(r.pe),
    beta: n(r.beta),
    sector: r.sector,
    industry: r.industry,
    yearHigh: n(r.yearHigh),
    yearLow: n(r.yearLow),
    ceo: r.ceo,
    // Los peers se guardan como símbolos; el nombre no se cachea (la UI solo
    // necesita el símbolo para linkar). name=null → el card usa el símbolo.
    peers: (r.peers ?? []).map((s) => ({ symbol: s, name: null })),
  };
}

const inflight = new Map<string, Promise<Fundamentals | null>>();
// En Cloudflare Workers NO se dedupe: compartir una Promise (que envuelve
// fetches de BD/FMP) entre requests del mismo isolate es la clase de bug
// "Cannot perform I/O on behalf of a different request" que ya nos mordió
// con el Pool module-level. El dedupe existe para ahorrar llamadas en el
// daemon/SSR local (Node), donde sí es seguro.
const IS_WORKERS =
  typeof (globalThis as { WebSocketPair?: unknown }).WebSocketPair !==
  "undefined";

export async function getOrFetchFundamentals(
  symbol: string,
  opts?: { allowFetch?: boolean },
): Promise<Fundamentals | null> {
  const sym = symbol.toUpperCase();
  const allowFetch = opts?.allowFetch ?? true;
  // El dedupe es por símbolo y no distingue el modo, así que sólo se aplica
  // al camino que puede gastar: dos lecturas de caché no necesitan
  // compartir promesa, y compartirla haría que una lectura sin permiso de
  // fetch se colase en una con permiso (o al revés).
  if (IS_WORKERS || !allowFetch) return resolve(sym, allowFetch);
  const existing = inflight.get(sym);
  if (existing) return existing;
  const p = resolve(sym, true).finally(() => inflight.delete(sym));
  inflight.set(sym, p);
  return p;
}

/** Anota "preguntamos a FMP y no hubo dato" con la fecha del intento. El
 *  símbolo ya existe en `tickers` (se comprueba antes), así que la FK está
 *  satisfecha y esto NO crea universo. Falla en silencio: no poder anotar el
 *  intento no debe tumbar la petición, sólo hace que se reintente antes. */
async function writeSentinel(sym: string): Promise<void> {
  try {
    await db.execute(sql`
      INSERT INTO ticker_fundamentals (symbol, peers, fetched_at)
      VALUES (${sym}, ARRAY[]::text[], now())
      ON CONFLICT (symbol) DO UPDATE SET fetched_at = now()
    `);
  } catch (e) {
    console.warn(
      `[fundamentals] no se pudo anotar el centinela de ${sym}:`,
      e instanceof Error ? e.message.slice(0, 120) : e,
    );
  }
}

async function resolve(
  sym: string,
  allowFetch: boolean,
): Promise<Fundamentals | null> {
  const rows = await db
    .select()
    .from(tickerFundamentals)
    .where(eq(tickerFundamentals.symbol, sym))
    .limit(1);
  const cached = rows[0] ?? null;
  const age = cached ? Date.now() - cached.fetchedAt.getTime() : Infinity;
  const ttl = cached && isSentinel(cached) ? NEGATIVE_TTL_MS : TTL_MS;
  if (cached && age < ttl) {
    // Un centinela fresco es una respuesta: "ya preguntamos y no hay dato".
    // Devolverlo como objeto de nulos haría que la UI pintara un bloque
    // vacío en vez de omitirlo.
    return isSentinel(cached) ? null : rowToFundamentals(cached);
  }

  // Sin permiso para gastar (anónimo en el Worker) servimos lo que haya,
  // aunque esté rancio, y no llamamos a FMP. Un dato de hace 8 días vale
  // infinitamente más que quemar el presupuesto diario de 250 llamadas.
  if (!allowFetch) {
    return cached && !isSentinel(cached) ? rowToFundamentals(cached) : null;
  }

  // El símbolo tiene que estar YA en el universo. Antes se hacía un
  // `INSERT INTO tickers … ON CONFLICT DO NOTHING` justo antes de cachear,
  // así que cualquier cadena que pasara el regex de la ruta podía a la vez
  // gastar 3 llamadas FMP y CREARSE una fila en `tickers`. Consultar el
  // universo primero cuesta una query y cierra las dos cosas: un símbolo
  // que ningún proveedor ha mencionado nunca no llega a FMP.
  const known = await db.execute(sql`
    SELECT 1 AS ok FROM tickers WHERE symbol = ${sym} LIMIT 1
  `);
  if (!unwrapRows<{ ok: number }>(known).length) return null;

  // Falta o rancio → pegar a FMP (3 calls).
  let data: Fundamentals | null = null;
  try {
    data = await fetchFundamentals(sym);
  } catch {
    data = null;
  }
  if (!data) {
    // FMP no dio nada. Antes se volvía aquí SIN escribir, así que el TTL no
    // cubría nunca el camino de fallo: el mismo símbolo re-quemaba 3
    // llamadas en CADA petición, indefinidamente. Ahora se anota el intento
    // con un centinela (TTL corto) y se sirve lo stale si lo había.
    // Se refresca también un centinela ya existente: si no, tras expirar las
    // 24h el símbolo sin dato volvería a gastar 3 llamadas en cada petición.
    // Lo que NUNCA se pisa es una fila con datos reales, aunque esté rancia.
    if (!cached || isSentinel(cached)) await writeSentinel(sym);
    return cached && !isSentinel(cached) ? rowToFundamentals(cached) : null;
  }

  try {
    const peerArray = data.peers.length
      ? sql`ARRAY[${sql.join(
          data.peers.map((p) => sql`${p.symbol}`),
          sql`, `,
        )}]::text[]`
      : sql`ARRAY[]::text[]`;
    await db.execute(sql`
      INSERT INTO ticker_fundamentals
        (symbol, market_cap, pe, beta, sector, industry, year_high, year_low, ceo, peers, fetched_at)
      VALUES (
        ${sym}, ${data.marketCap}, ${data.pe != null ? String(data.pe) : null},
        ${data.beta != null ? String(data.beta) : null}, ${data.sector},
        ${data.industry}, ${data.yearHigh != null ? String(data.yearHigh) : null},
        ${data.yearLow != null ? String(data.yearLow) : null}, ${data.ceo},
        ${peerArray}, now()
      )
      ON CONFLICT (symbol) DO UPDATE SET
        market_cap = EXCLUDED.market_cap, pe = EXCLUDED.pe, beta = EXCLUDED.beta,
        sector = EXCLUDED.sector, industry = EXCLUDED.industry,
        year_high = EXCLUDED.year_high, year_low = EXCLUDED.year_low,
        ceo = EXCLUDED.ceo, peers = EXCLUDED.peers, fetched_at = now()
    `);
  } catch (e) {
    console.warn(
      `[fundamentals] cache write failed for ${sym}:`,
      e instanceof Error ? e.message.slice(0, 120) : e,
    );
  }
  return data;
}
