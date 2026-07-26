import { NextResponse } from "next/server";
import { getWatchlist } from "@/lib/db/queries";
import { ensureSessionCookie } from "@/lib/session";
import { getQuotesMap } from "@/lib/providers/finnhub";
import { retrievePortfolio, type PortfolioRetrieval } from "@/lib/ask/portfolio";
import { reviewPortfolio, type PortfolioReview } from "@/lib/ai/portfolio-review";
import { isWorkersRuntime, llmAllowed, rateLimited } from "@/lib/ask/gate";

// POST /api/portfolio-review → revisión de la cartera del usuario.
//
// Endpoint aparte del /api/ask y no un `scope` suyo: la respuesta no se
// parece en nada (tablero estructurado vs respuesta con citas) y meter las
// dos en una unión discriminada obligaba al cliente a ramificar en cada
// campo. Comparten lo que sí tenía que compartirse — el gate y el cubo del
// rate limit — vía `lib/ask/gate.ts`.
//
// Sin cuota de embeddings: los símbolos vienen de la watchlist, así que no
// hay nada que adivinar y el retrieval es puramente simbólico. El único
// gasto de proveedor es UNA llamada de prosa.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export type PortfolioReviewResponse = {
  portfolio: PortfolioRetrieval["portfolio"];
  facts: PortfolioRetrieval["facts"];
  citations: PortfolioRetrieval["citations"];
  calendar: PortfolioRetrieval["calendar"];
  derived: PortfolioRetrieval["derived"];
  concentration: PortfolioRetrieval["concentration"];
  blindSpots: string[];
  review: PortfolioReview | null;
  note?: string;
};

export async function POST(req: Request) {
  if (isWorkersRuntime && rateLimited(req)) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  const session = await ensureSessionCookie();
  const rows = await getWatchlist(session);
  const live = rows.filter((r) => r.shares !== null && r.shares > 0);

  // Sin posiciones no hay nada que revisar, y es un estado NORMAL (una
  // watchlist recién creada, o de puro seguimiento). Se responde 200 con
  // el motivo, no un error: la UI pinta "añade tus posiciones", que es la
  // acción que corresponde.
  if (!live.length) {
    return NextResponse.json(
      {
        portfolio: {
          positions: [], watchOnly: rows.map(toPosition), closed: [],
          totalValue: 0, totalCost: 0, totalUnrealizedAbs: null,
          totalUnrealizedPct: null, dayChangePct: null, sectors: [],
          unpricedSymbols: [], noCostSymbols: [],
        },
        facts: [], citations: [], calendar: [], concentration: [],
        derived: { weightedBeta: null, betaCoveragePct: 0, earningsClusters: [] },
        blindSpots: [], review: null,
        note: "Aún no has registrado ninguna posición. Añade acciones y coste medio en el rail de la watchlist.",
      } satisfies PortfolioReviewResponse,
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  const allowLlm = await llmAllowed();

  try {
    // Quotes en vivo, no de caché: `quotes_cache` no la escribe nadie
    // (schema muerto) y los pesos y el P&L de una revisión no pueden salir
    // de un precio de ayer. Si un símbolo falla vuelve como null y
    // `buildPortfolio` lo saca del denominador en vez de contarlo como 0.
    const quotes = await getQuotesMap(live.map((r) => r.symbol)).catch(() => ({}));
    const r = await retrievePortfolio(rows.map(toPosition), quotes);

    let review: PortfolioReview | null = null;
    let note: string | undefined;
    if (allowLlm) {
      review = await reviewPortfolio(r);
    } else {
      note = "La revisión con IA es sólo para la sesión del dueño. Debajo tienes los datos calculados.";
    }

    return NextResponse.json(
      {
        portfolio: r.portfolio,
        facts: r.facts,
        citations: r.citations,
        calendar: r.calendar,
        derived: r.derived,
        concentration: r.concentration,
        blindSpots: r.blindSpots,
        review,
        note,
      } satisfies PortfolioReviewResponse,
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    console.warn(
      "[api/portfolio-review] failed:",
      err instanceof Error ? err.message.slice(0, 160) : err,
    );
    return NextResponse.json(
      { error: "review_failed" },
      { status: 502, headers: { "Cache-Control": "no-store" } },
    );
  }
}

type Row = Awaited<ReturnType<typeof getWatchlist>>[number];

function toPosition(r: Row) {
  return {
    symbol: r.symbol,
    name: r.name,
    sector: r.sector,
    shares: r.shares,
    avgCost: r.avgCost,
  };
}
