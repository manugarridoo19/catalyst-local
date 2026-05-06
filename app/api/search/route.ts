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
    const results = raw
      .filter((r) => r.type === "Common Stock" || r.type === "ADR")
      .slice(0, 10)
      .map((r) => ({
        symbol: r.displaySymbol || r.symbol,
        name: r.description,
      }));
    return NextResponse.json({ results });
  } catch (err) {
    return NextResponse.json(
      { results: [], error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
