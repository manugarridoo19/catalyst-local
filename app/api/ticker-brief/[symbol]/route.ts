import { NextResponse } from "next/server";
import { maybeGenerateTickerBrief } from "@/lib/ai/ticker-brief";

// GET /api/ticker-brief/MSFT → { brief, status } (ver TickerBriefResult).
// Node runtime: el generador toca Neon + OpenRouter/Groq. force-dynamic +
// no-store: el caché real vive en la tabla ticker_briefs con invalidación
// por cobertura nueva — un edge-cache por delante solo taparía el estado.
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
    const result = await maybeGenerateTickerBrief(symbol);
    return NextResponse.json(result, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (err) {
    // Generación fallida sin brief previo que servir. 200 con estado
    // explícito: el cliente pinta "unavailable", no un error de red.
    console.warn(
      `[api/ticker-brief] ${symbol} failed:`,
      err instanceof Error ? err.message.slice(0, 160) : err,
    );
    return NextResponse.json(
      { brief: null, status: "error" },
      { headers: { "Cache-Control": "no-store" } },
    );
  }
}
