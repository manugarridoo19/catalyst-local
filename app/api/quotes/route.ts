import { NextResponse } from "next/server";
import { getQuotesMap } from "@/lib/providers/finnhub";

// Node runtime: edge no es viable porque lib/providers/finnhub.ts importa
// hashUrl (node:crypto) — tree-shake no lo elimina del bundle aunque /quotes
// no use hash. Como mitigación, el WatchlistPanel pasa de polling 60s → 5min
// (5x menos invocaciones), que es donde estaba el coste real.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/quotes?symbols=AAPL,MSFT,GOOG → { quotes: { [symbol]: Quote|null } }.
// Cap a 20 símbolos por request (watchlist típica <10).
export async function GET(req: Request) {
  const url = new URL(req.url);
  const raw = url.searchParams.get("symbols") ?? "";
  const symbols = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 20);
  if (!symbols.length) return NextResponse.json({ quotes: {} });
  const quotes = await getQuotesMap(symbols);
  return NextResponse.json({ quotes });
}
