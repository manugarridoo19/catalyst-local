import { NextResponse } from "next/server";
import { searchSymbols } from "@/lib/providers/finnhub";

// Node runtime forzado: lib/providers/finnhub.ts importa hashUrl
// (node:crypto), incompatible con edge aunque /search no lo use.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Cache LRU módulo-level (audit 2026-05-12 #6): autocomplete debouncea 200ms
// cliente, pero un usuario que tipea "NVID" produce 4 requests ("N", "NV",
// "NVI", "NVID") y los símbolos cambian raras veces. Cache TTL 5min
// + cap 200 entries (LRU naïf: borra el más viejo si llena). Beneficio: la
// quota Finnhub 60 RPM se reserva para crons + watchlist polling, no para
// keystroke fan-out. Coste memoria: ~200 × ~1KB = 200KB tope.
type CacheEntry = {
  data: { symbol: string; name: string }[];
  expiresAt: number;
};
const searchCache = new Map<string, CacheEntry>();
const SEARCH_TTL_MS = 5 * 60 * 1000;
const SEARCH_CACHE_MAX = 200;

function readCache(key: string) {
  const hit = searchCache.get(key);
  if (!hit) return null;
  if (hit.expiresAt <= Date.now()) {
    searchCache.delete(key);
    return null;
  }
  // LRU bump: re-insertar mueve al final del orden de iteración.
  searchCache.delete(key);
  searchCache.set(key, hit);
  return hit.data;
}

function writeCache(key: string, data: { symbol: string; name: string }[]) {
  if (searchCache.size >= SEARCH_CACHE_MAX) {
    const oldest = searchCache.keys().next().value;
    if (oldest !== undefined) searchCache.delete(oldest);
  }
  searchCache.set(key, { data, expiresAt: Date.now() + SEARCH_TTL_MS });
}

// Autocomplete: cliente debouncea y nos llama con `q`. Devolvemos top 10.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const q = url.searchParams.get("q")?.trim() ?? "";
  if (q.length < 1) return NextResponse.json({ results: [] });

  const key = q.toLowerCase();
  const cached = readCache(key);
  if (cached) {
    return NextResponse.json(
      { results: cached },
      { headers: { "Cache-Control": "private, max-age=300", "X-Cache": "HIT" } },
    );
  }

  try {
    const raw = await searchSymbols(q);
    // Finnhub devuelve el mismo `displaySymbol` para múltiples exchanges
    // (META en NASDAQ, META.BA en Buenos Aires, META.NEO en Neo). El cliente
    // usa `key={r.symbol}` así que duplicates crashea React. Dedupe primero.
    const seen = new Set<string>();
    const results: { symbol: string; name: string }[] = [];
    for (const r of raw) {
      if (r.type !== "Common Stock" && r.type !== "ADR") continue;
      const symbol = r.displaySymbol || r.symbol;
      if (!symbol || seen.has(symbol)) continue;
      seen.add(symbol);
      results.push({ symbol, name: r.description });
      if (results.length >= 10) break;
    }
    writeCache(key, results);
    return NextResponse.json(
      { results },
      { headers: { "Cache-Control": "private, max-age=300", "X-Cache": "MISS" } },
    );
  } catch (err) {
    return NextResponse.json(
      { results: [], error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
