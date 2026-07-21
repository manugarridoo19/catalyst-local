import { getDailyAdjCloses, type AdjCloseSeries } from "@/lib/providers/yahoo";
import { getFmpKey } from "@/lib/providers/fmp";

// Serie de cierres ajustados para el Signal Lab, con degradación controlada.
//
// Por qué existe esta capa en vez de llamar a Yahoo directo: el valor del Lab
// es ACUMULATIVO — cada horizonte que no se mide a tiempo es una observación
// perdida que no vuelve (el precio de hace 3 semanas se puede recuperar, sí,
// pero el evento se queda esperando y arrastra el contador de intentos hasta
// abandonarse). Yahoo es gratis y bueno, pero limita por IP sin avisar: desde
// esta misma máquina devolvió 429 a TODA petición de chart mientras se
// construía esto. Un único proveedor = el laboratorio entero parado.
//
// Orden: Yahoo (gratis, ilimitado en teoría, adjclose real) → FMP
// (`/stable/historical-price-eod/dividend-adjusted`, ajustado por splits Y
// dividendos, key que ya tenemos). Stooq quedó DESCARTADO: desde 2026 sirve
// un challenge JavaScript de proof-of-work, o sea scraping frágil, que la
// premisa 4 del diseño prohíbe explícitamente.
//
// Disciplina de cuota FMP (free = 250 llamadas/DÍA, compartidas con los
// fundamentales de las ticker pages): el fallback tiene presupuesto propio
// por proceso y se apaga con LAB_FMP_FALLBACK=0. Nunca es la vía primaria.

const FMP_BASE = "https://financialmodelingprep.com/stable";
// APAGADO POR DEFECTO, a propósito. El presupuesto es POR PROCESO, y el cron
// corre ~144 veces al día: un default de 20 permitiría 2.880 llamadas/día
// contra una cuota de 250 compartida con los fundamentales de las ticker
// pages. En el runner de GitHub, Yahoo responde de sobra (IP limpia por run),
// así que el fallback solo tiene sentido a mano, desde una IP a la que Yahoo
// esté limitando:
//   LAB_FMP_MAX_CALLS=20 pnpm exec tsx scripts/fill-outcomes.ts
const FMP_BUDGET = Number(process.env.LAB_FMP_MAX_CALLS ?? 0);
let fmpCallsUsed = 0;

export function fmpFallbackUsed(): number {
  return fmpCallsUsed;
}

type FmpBar = { date?: string; adjClose?: number };

async function fetchFmpAdjCloses(
  symbol: string,
  fromMs: number,
): Promise<AdjCloseSeries> {
  const key = getFmpKey();
  if (!key) throw new Error("sin FMP_API_KEY");
  const from = new Date(fromMs - 10 * 86_400_000).toISOString().slice(0, 10);
  const to = new Date().toISOString().slice(0, 10);
  const url =
    `${FMP_BASE}/historical-price-eod/dividend-adjusted` +
    `?symbol=${encodeURIComponent(symbol)}&from=${from}&to=${to}&apikey=${key}`;

  const res = await fetch(url, { signal: AbortSignal.timeout(12_000) });
  if (!res.ok) throw new Error(`FMP ${res.status}`);
  const json = (await res.json()) as FmpBar[] | { Error?: string };
  if (!Array.isArray(json)) throw new Error("FMP shape inesperado");

  // FMP devuelve descendente; el Lab cuenta días hábiles por POSICIÓN en el
  // array, así que el orden ascendente no es cosmético — es correctitud.
  const bars = json
    .filter((b) => b.date && typeof b.adjClose === "number")
    .sort((a, b) => (a.date! < b.date! ? -1 : 1));
  const dates: string[] = [];
  const closes = new Map<string, number>();
  for (const b of bars) {
    const day = b.date!.slice(0, 10);
    if (!closes.has(day)) dates.push(day);
    closes.set(day, b.adjClose!);
  }
  return { dates, closes };
}

// Proxy a través de nuestro propio Worker de Cloudflare. El límite de Yahoo
// es POR IP y resultó asimétrico (2026-07-21): 429 desde la IP del usuario y
// desde los runners de GitHub, pero responde normal desde Cloudflare. Como el
// job corre en GitHub Actions, pedirle los precios a nuestro Worker convierte
// un bloqueo duro en una llamada más — gratis, sin cuenta ni key nuevas.
async function fetchViaProxy(
  symbol: string,
  fromMs: number,
): Promise<AdjCloseSeries> {
  const base = process.env.LAB_PRICE_PROXY_URL;
  if (!base) return { dates: [], closes: new Map() };
  // Nunca desde dentro del propio Worker: sería una llamada a sí mismo.
  if (typeof (globalThis as { WebSocketPair?: unknown }).WebSocketPair !== "undefined") {
    return { dates: [], closes: new Map() };
  }
  const url = `${base.replace(/\/$/, "")}/api/adj-closes?symbol=${encodeURIComponent(symbol)}&from=${Math.floor(fromMs)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`proxy ${res.status}`);
  const json = (await res.json()) as {
    dates?: string[];
    closes?: Record<string, number>;
  };
  return {
    dates: json.dates ?? [],
    closes: new Map(Object.entries(json.closes ?? {})),
  };
}

export async function getAdjCloseSeries(
  symbol: string,
  fromMs: number,
): Promise<AdjCloseSeries> {
  const yahoo = await getDailyAdjCloses(symbol, fromMs);
  if (yahoo.dates.length > 0) return yahoo;

  // 2º: el mismo Yahoo, pero desde una IP que no está limitada.
  try {
    const viaProxy = await fetchViaProxy(symbol, fromMs);
    if (viaProxy.dates.length > 0) return viaProxy;
  } catch (err) {
    console.warn(
      `[prices] ${symbol}: proxy falló:`,
      err instanceof Error ? err.message : err,
    );
  }

  if (FMP_BUDGET <= 0 || fmpCallsUsed >= FMP_BUDGET) {
    console.warn(
      `[prices] ${symbol}: Yahoo vacío y fallback FMP sin presupuesto (LAB_FMP_MAX_CALLS=${FMP_BUDGET}) — se reintenta mañana`,
    );
    return yahoo;
  }
  try {
    fmpCallsUsed++;
    const fmp = await fetchFmpAdjCloses(symbol, fromMs);
    if (fmp.dates.length > 0) {
      console.log(
        `[prices] ${symbol}: fallback FMP (${fmp.dates.length} sesiones, ${fmpCallsUsed}/${FMP_BUDGET})`,
      );
    }
    return fmp;
  } catch (err) {
    console.warn(
      `[prices] ${symbol}: fallback FMP falló:`,
      err instanceof Error ? err.message : err,
    );
    return yahoo;
  }
}
