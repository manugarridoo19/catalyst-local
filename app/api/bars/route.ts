import { NextResponse } from "next/server";
import { getBars, type Period } from "@/lib/providers/yahoo";

// ⚠️ NO volver a poner `runtime = "edge"`. Era una optimización de la era
// Vercel (esta ruta solo hace fetch + parse, sin DB), pero
// @opennextjs/cloudflare NO soporta el edge runtime: el Worker devolvía 500
// ANTES de entrar en el handler — incluso en el camino de símbolo inválido,
// que responde 400 sin tocar la red. Los gráficos de ticker llevaban rotos en
// producción desde la migración del 2026-07-15 y el 429 de Yahoo lo tapaba
// (en local degradaba a `{"bars":[]}`, que parecía el mismo síntoma). Todas
// las demás rutas ya son "nodejs".
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VALID: Period[] = ["1d", "1w", "1m", "3m", "1y"];

export async function GET(req: Request) {
  const url = new URL(req.url);
  const symbol = (url.searchParams.get("symbol") ?? "").toUpperCase().trim();
  const period = (url.searchParams.get("period") ?? "1d") as Period;
  if (!/^[A-Z0-9.\-]{1,10}$/.test(symbol)) {
    return NextResponse.json({ error: "invalid_symbol" }, { status: 400 });
  }
  if (!VALID.includes(period)) {
    return NextResponse.json({ error: "invalid_period" }, { status: 400 });
  }
  try {
    const bars = await getBars(symbol, period);
    return NextResponse.json({ bars });
  } catch (err) {
    return NextResponse.json(
      { bars: [], error: err instanceof Error ? err.message : String(err) },
      { status: 200 }, // devolvemos 200 con array vacío para no romper la UI
    );
  }
}
