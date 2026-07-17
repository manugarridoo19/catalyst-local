import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
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
): Promise<Fundamentals | null> {
  const sym = symbol.toUpperCase();
  if (IS_WORKERS) return resolve(sym);
  const existing = inflight.get(sym);
  if (existing) return existing;
  const p = resolve(sym).finally(() => inflight.delete(sym));
  inflight.set(sym, p);
  return p;
}

async function resolve(sym: string): Promise<Fundamentals | null> {
  const rows = await db
    .select()
    .from(tickerFundamentals)
    .where(eq(tickerFundamentals.symbol, sym))
    .limit(1);
  const cached = rows[0] ?? null;
  const fresh = cached && Date.now() - cached.fetchedAt.getTime() < TTL_MS;
  if (cached && fresh) return rowToFundamentals(cached);

  // Falta o rancio → pegar a FMP (3 calls). El símbolo debe existir en
  // `tickers` (FK); si el usuario visita un ticker nunca visto, la ticker
  // page ya lo habrá upserteado vía el resto del pipeline, pero por si
  // acaso lo aseguramos con onConflictDoNothing.
  let data: Fundamentals | null = null;
  try {
    data = await fetchFundamentals(sym);
  } catch {
    data = null;
  }
  if (!data) {
    // FMP falló → servir stale si lo hay.
    return cached ? rowToFundamentals(cached) : null;
  }

  try {
    await db.execute(sql`
      INSERT INTO tickers (symbol, first_seen_at) VALUES (${sym}, now())
      ON CONFLICT (symbol) DO NOTHING
    `);
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
