import { NextResponse } from "next/server";
import {
  getLatestTickerBrief,
  maybeGenerateTickerBrief,
} from "@/lib/ai/ticker-brief";
import { guardSpend, llmAllowed } from "@/lib/ask/gate";

// GET /api/ticker-brief/MSFT → { brief, status } (ver TickerBriefResult).
// Node runtime: el generador toca Neon + OpenRouter/Groq. force-dynamic +
// no-store: el caché real vive en la tabla ticker_briefs con invalidación
// por cobertura nueva — un edge-cache por delante solo taparía el estado.
//
// GATE (2026-08-01): esta ruta se saltaba el patrón de /api/article y era la
// forma más barata de drenar el pool de prosa del proyecto. El caché de
// `ticker_briefs` es POR SÍMBOLO, así que repetir el mismo símbolo era barato
// pero ENUMERAR símbolos distintos no: cada símbolo con cobertura en 24h y
// sin brief cacheado costaba una llamada completa de la cadena de prosa, y
// hay varios cientos de símbolos distintos en `news_tickers` cada día.
// El anónimo sigue viendo el brief que YA existe (leer la tabla es gratis y
// la página del ticker debe seguir sirviendo para algo); lo que no puede es
// provocar una generación nueva.
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
  // `degrade` y no `deny`: al anónimo se le sirve el caché, no un 403.
  const denied = await guardSpend(req, { mode: "degrade" });
  if (denied) return denied;

  if (!(await llmAllowed())) {
    const brief = await getLatestTickerBrief(symbol).catch(() => null);
    return NextResponse.json(
      { brief, status: brief ? "cached" : "unavailable" },
      { headers: { "Cache-Control": "no-store" } },
    );
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
