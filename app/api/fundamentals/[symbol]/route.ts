import { NextResponse } from "next/server";
import { getOrFetchFundamentals } from "@/lib/fundamentals";

// GET /api/fundamentals/AAPL → { fundamentals } | { fundamentals: null }.
// Node runtime: toca FMP + BD. La cache (tabla ticker_fundamentals, TTL 7d)
// vive en getOrFetchFundamentals; no-store porque el caché real es la BD.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ symbol: string }> },
) {
  const { symbol: raw } = await ctx.params;
  const symbol = raw.toUpperCase();
  if (!/^[A-Z0-9.\-]{1,10}$/.test(symbol)) {
    return NextResponse.json({ error: "invalid symbol" }, { status: 400 });
  }
  try {
    const fundamentals = await getOrFetchFundamentals(symbol);
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
