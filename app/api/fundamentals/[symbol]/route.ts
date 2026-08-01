import { NextResponse } from "next/server";
import { getOrFetchFundamentals } from "@/lib/fundamentals";
import { guardSpend, llmAllowed } from "@/lib/ask/gate";

// GET /api/fundamentals/AAPL → { fundamentals } | { fundamentals: null }.
// Node runtime: toca FMP + BD. La cache (tabla ticker_fundamentals, TTL 7d)
// vive en getOrFetchFundamentals; no-store porque el caché real es la BD.
//
// GATE (2026-08-01): el plan free de FMP son 250 llamadas AL DÍA y cada
// símbolo no cacheado cuesta 3, así que ~84 símbolos distintos agotaban el
// presupuesto del proyecto entero desde una ruta pública y enumerable. El
// anónimo pasa con `allowFetch: false`: lee la caché (incluso rancia) y
// nunca dispara una llamada a FMP.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  req: Request,
  ctx: { params: Promise<{ symbol: string }> },
) {
  const { symbol: raw } = await ctx.params;
  const symbol = raw.toUpperCase();
  if (!/^[A-Z0-9.\-]{1,10}$/.test(symbol)) {
    return NextResponse.json({ error: "invalid symbol" }, { status: 400 });
  }
  const denied = await guardSpend(req, { mode: "degrade" });
  if (denied) return denied;

  try {
    const fundamentals = await getOrFetchFundamentals(symbol, {
      allowFetch: await llmAllowed(),
    });
    return NextResponse.json(
      { fundamentals },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    console.warn(
      `[api/fundamentals] ${symbol} failed:`,
      err instanceof Error ? err.message.slice(0, 140) : err,
    );
    return NextResponse.json(
      { fundamentals: null },
      { headers: { "Cache-Control": "no-store" } },
    );
  }
}
