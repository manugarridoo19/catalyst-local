import { NextResponse } from "next/server";
import { searchSymbols } from "@/lib/providers/finnhub";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Autocomplete: cliente debouncea y nos llama con `q`. Devolvemos top 10.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const q = url.searchParams.get("q")?.trim() ?? "";
  if (q.length < 1) return NextResponse.json({ results: [] });
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
    return NextResponse.json({ results });
  } catch (err) {
    return NextResponse.json(
      { results: [], error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
