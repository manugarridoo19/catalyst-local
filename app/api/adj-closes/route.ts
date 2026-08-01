import { NextResponse } from "next/server";
import { getDailyAdjCloses } from "@/lib/providers/yahoo";
import { isWorkersRuntime, rateLimited } from "@/lib/ask/gate";

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
  // Rate limit y NO gate de sesión: el cliente legítimo es el cron de GitHub
  // Actions, que llega anónimo (sin cookie). Lo que se protege aquí no es
  // cuota propia sino la REPUTACIÓN IP de los Workers de Cloudflare — hoy el
  // único origen desde el que Yahoo no responde 429, y del que depende el
  // job de outcomes del Lab. Un bot usándolo de proxy gratuito provocaría
  // justo el bloqueo que esta ruta existe para esquivar.
  //
  // Cubo "prices" (60/min) y no el común de 8/min: una pasada de outcomes son
  // hasta 41 peticiones seguidas desde la misma IP del runner.
  if (isWorkersRuntime && rateLimited(req, "prices")) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }
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
    // 502 y NO 200 con series vacías. El 200 hacía que un 429 de Yahoo
    // llegara al llamante idéntico a "este símbolo no tiene datos":
    // `fetchViaProxy` mira `res.ok`, veía true, leía `dates: []` y el job de
    // outcomes gastaba uno de los 10 intentos del evento antes de
    // abandonarlo. Una ventana de bloqueo de Yahoo abandonaba eventos sanos
    // sin que nada lo dijera. El cuerpo mantiene la forma para que un
    // cliente que solo lea `dates`/`closes` no reviente.
    return NextResponse.json(
      {
        dates: [],
        closes: {},
        error: err instanceof Error ? err.message : String(err),
      },
      { status: 502 },
    );
  }
}
