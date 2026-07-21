import { NextResponse } from "next/server";
import { getDailyAdjCloses } from "@/lib/providers/yahoo";

// Cierres diarios AJUSTADOS para el Signal Lab.
//
// Por qué esta ruta existe: Yahoo limita por IP, y el reparto resultó ser
// asimétrico (verificado 2026-07-21) — 429 desde la IP residencial del
// usuario Y desde los runners de GitHub Actions, pero responde con
// normalidad desde los Workers de Cloudflare. El job de outcomes vive en el
// cron de GitHub, así que sin esto no puede medir nada. Con esto, el Worker
// hace de proxy hacia nuestra propia infra: gratis, sin cuenta nueva, sin
// key nueva. Si Yahoo vuelve a responder directo, prices.ts ni la usa.
//
// runtime nodejs OBLIGATORIO (nunca "edge"): @opennextjs/cloudflare no
// soporta el edge runtime y la ruta daría 500 antes de entrar aquí — es el
// bug que tuvo los gráficos de ticker rotos desde julio.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_LOOKBACK_DAYS = 400;

export async function GET(req: Request) {
  const url = new URL(req.url);
  const symbol = (url.searchParams.get("symbol") ?? "").toUpperCase().trim();
  if (!/^[A-Z0-9.\-]{1,10}$/.test(symbol)) {
    return NextResponse.json({ error: "invalid_symbol" }, { status: 400 });
  }
  // `from` acotado: esta ruta es pública (como /api/bars), así que no puede
  // convertirse en una descarga de 20 años de histórico por request.
  const fromRaw = Number(url.searchParams.get("from") ?? 0);
  const floor = Date.now() - MAX_LOOKBACK_DAYS * 86_400_000;
  const from =
    Number.isFinite(fromRaw) && fromRaw > floor ? fromRaw : floor;

  try {
    const series = await getDailyAdjCloses(symbol, from);
    return NextResponse.json({
      dates: series.dates,
      // Map no es serializable a JSON — se manda como objeto plano.
      closes: Object.fromEntries(series.closes),
    });
  } catch (err) {
    return NextResponse.json(
      {
        dates: [],
        closes: {},
        error: err instanceof Error ? err.message : String(err),
      },
      { status: 200 },
    );
  }
}
