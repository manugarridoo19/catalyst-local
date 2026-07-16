import { NextResponse } from "next/server";
import { getQuotesMap } from "@/lib/providers/finnhub";

// Node runtime: edge isn't viable yet because `lib/providers/finnhub.ts`
// imports `hashUrl` (node:crypto) for news ingestion, and Next.js doesn't
// tree-shake that import out even though /quotes never touches news code.
// Mitigations in place:
//   1. Cache-Control below — repeated polling of the same symbol set hits
//      the Vercel edge cache for s-maxage seconds before any function
//      invocation. With watchlist refresh at 60s (`watchlist-panel.tsx`),
//      s-maxage=30 gives roughly a 50% cache hit on bursty multi-tab use.
//   2. Watchlist polling pauses when the tab is hidden (visibilitychange).
// To remove the Node-runtime constraint entirely, split `lib/providers/
// finnhub.ts` so quote/search live in a hash-free module — see the audit
// note dated 2026-05-18 for the recommended split.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/quotes?symbols=AAPL,MSFT,GOOG → { quotes: { [symbol]: Quote|null } }.
// Cap at 20 symbols per request (typical watchlist <10).
export async function GET(req: Request) {
  const url = new URL(req.url);
  const raw = url.searchParams.get("symbols") ?? "";
  // Valida cada símbolo con el mismo patrón que /ticker y /feed antes de
  // gastar quota Finnhub — evita fan-out de peticiones basura.
  const symbols = raw
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter((s) => /^[A-Z0-9.\-]{1,10}$/.test(s))
    .slice(0, 20);
  if (!symbols.length) return NextResponse.json({ quotes: {} });
  const quotes = await getQuotesMap(symbols);
  return NextResponse.json(
    { quotes },
    {
      headers: {
        // s-maxage: edge cache TTL in seconds. Same-symbol-set polling within
        // this window short-circuits before reaching the function, which is
        // the primary Vercel CPU cost on Hobby.
        // stale-while-revalidate: serve stale up to N seconds while the
        // background revalidation runs, so the UX never sees a gap on the
        // cadence boundary.
        "Cache-Control": "public, s-maxage=30, stale-while-revalidate=60",
      },
    },
  );
}
