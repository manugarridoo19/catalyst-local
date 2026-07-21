import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Financial Modeling Prep — datos fundamentales que Finnhub free no da:
// P/E, beta, rango 52 semanas, sector/industria, CEO y sobre todo PEERS
// (valores comparables). Free tier = 250 calls/día, así que la disciplina
// es CRÍTICA:
//   - NUNCA se llama por pageview. La ticker page lee de la cache BD
//     (tabla ticker_fundamentals). Solo se pega a FMP cuando falta o está
//     rancio (>7d) — ver getOrFetchFundamentals en lib/db/queries.
//   - 3 calls por símbolo (profile + ratios-ttm + stock-peers), cacheadas
//     7 días → cada símbolo cuesta 3 calls/semana. Con uso personal
//     (<20 tickers/día) el gasto queda muy por debajo de 250.
//   - Endpoints "stable" (los v3/v4 son legacy y devuelven error para keys
//     posteriores a agosto 2025).

const BASE = "https://financialmodelingprep.com/stable";
const LOCAL_KEY_FILE = join(homedir(), ".catalyst-fmp-key");

function readKey(): string {
  const fromEnv = (process.env.FMP_API_KEY ?? "").trim();
  if (fromEnv) return fromEnv;
  if (!existsSync(LOCAL_KEY_FILE)) return "";
  try {
    const raw = readFileSync(LOCAL_KEY_FILE, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const m = line.trim().match(/^FMP_API_KEY\s*=\s*(.+)$/);
      if (m) return m[1].trim();
    }
  } catch {
    /* ignore */
  }
  return "";
}

// Misma key para cualquier otro consumidor de FMP (el fallback de precios
// del Signal Lab). Exportada para que la lógica de "env → archivo off-repo"
// viva en UN solo sitio: los settings del usuario deniegan leer .env*, así
// que ~/.catalyst-fmp-key (mode 600) es la fuente real en local.
export function getFmpKey(): string {
  return readKey();
}

export type FmpPeer = { symbol: string; name: string | null };

export type FmpFundamentals = {
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

async function fmpGet<T>(path: string): Promise<T | null> {
  const key = readKey();
  if (!key) return null;
  const sep = path.includes("?") ? "&" : "?";
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12_000);
  try {
    const res = await fetch(`${BASE}/${path}${sep}apikey=${key}`, {
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// "201.5-334.68" → { low: 201.5, high: 334.68 }
function parseRange(range: unknown): { low: number | null; high: number | null } {
  if (typeof range !== "string") return { low: null, high: null };
  const m = range.match(/([\d.]+)\s*-\s*([\d.]+)/);
  if (!m) return { low: null, high: null };
  return { low: Number(m[1]), high: Number(m[2]) };
}

// Trae los fundamentales de un símbolo (3 calls FMP). Devuelve null si no
// hay key o si el profile falla (sin profile no hay nada que mostrar). Los
// otros dos (ratios, peers) degradan a null/[] sin tumbar el conjunto.
export async function fetchFundamentals(
  symbol: string,
): Promise<FmpFundamentals | null> {
  const sym = symbol.toUpperCase();
  const [profileRaw, ratiosRaw, peersRaw] = await Promise.all([
    fmpGet<Array<Record<string, unknown>>>(`profile?symbol=${sym}`),
    fmpGet<Array<Record<string, unknown>>>(`ratios-ttm?symbol=${sym}`),
    fmpGet<Array<Record<string, unknown>>>(`stock-peers?symbol=${sym}`),
  ]);

  const profile = Array.isArray(profileRaw) ? profileRaw[0] : null;
  if (!profile) return null;

  const { low, high } = parseRange(profile.range);
  const ratios = Array.isArray(ratiosRaw) ? ratiosRaw[0] : null;
  const peNum =
    ratios && typeof ratios.priceToEarningsRatioTTM === "number"
      ? Number(ratios.priceToEarningsRatioTTM)
      : null;

  const peers: FmpPeer[] = Array.isArray(peersRaw)
    ? peersRaw
        .filter((p) => p && typeof p.symbol === "string")
        .slice(0, 6)
        .map((p) => ({
          symbol: String(p.symbol).toUpperCase(),
          name: typeof p.companyName === "string" ? p.companyName : null,
        }))
    : [];

  const num = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;
  const str = (v: unknown): string | null =>
    typeof v === "string" && v.trim() ? v.trim() : null;

  return {
    marketCap: num(profile.marketCap),
    pe: peNum != null && peNum > 0 ? Math.round(peNum * 10) / 10 : null,
    beta: num(profile.beta),
    sector: str(profile.sector),
    industry: str(profile.industry),
    yearHigh: high,
    yearLow: low,
    ceo: str(profile.ceo),
    peers,
  };
}

export function hasFmpKey(): boolean {
  return Boolean(readKey());
}
