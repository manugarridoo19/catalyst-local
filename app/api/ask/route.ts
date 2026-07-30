import { NextResponse } from "next/server";
import {
  ledgerCandidates,
  retrieve,
  type Citation,
  type StructuredFacts,
} from "@/lib/ask/retrieve";
import { askArchive, hasCoverage, type AskSection } from "@/lib/ai/ask";
import { extractForwardLedger, type ForwardItem } from "@/lib/ai/forward-ledger";
import { embedBatch, EmbedQuotaError } from "@/lib/providers/gemini-embed";
import { isWorkersRuntime, llmAllowed, rateLimited } from "@/lib/ask/gate";
import { classifyIntent, type AskIntent } from "@/lib/ask/intent";
import {
  buildDecisionFacts,
  type DatedFact,
  type DecisionFacts,
  type PositionContext,
  type Pressure,
} from "@/lib/ask/decision";
import { buildPortfolio, type Portfolio } from "@/lib/portfolio";
import { getWatchlist } from "@/lib/db/queries";
import { getQuotesMap } from "@/lib/providers/finnhub";
import { ensureSessionCookie } from "@/lib/session";

// POST /api/ask { question } → respuesta con citas sobre el archivo.
//
// DOS MODOS, y la diferencia es de cuota, no de producto:
//   - Dueño de la sesión: embebe la pregunta (1 unidad de cuota) + genera
//     la respuesta con LLM. Retrieval híbrido completo.
//   - Anónimo en el Worker público: SOLO búsqueda léxica + agregados SQL.
//     Cero llamadas a cualquier proveedor. Sigue siendo útil (devuelve las
//     noticias del archivo que casan) y no lo puede drenar un bot.
//
// Es el mismo patrón que /api/article: la generación va gated a la sesión
// del dueño porque el endpoint es público y enumerable.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_QUESTION_CHARS = 300;

export type AskResponse = {
  mode: "answer" | "search";
  /** Qué clase de pregunta se detectó. La UI pinta la exposición y las
   *  presiones sólo en `decision` — en una consulta de archivo serían ruido. */
  intent: AskIntent;
  question: string;
  answer: string | null;
  /** Respuesta troceada en epígrafes cuando el material daba para ello.
   *  Vacío en modo búsqueda y en las respuestas en prosa antiguas. */
  sections: AskSection[];
  coverage: "full" | "partial" | "none";
  citations: Citation[];
  facts: StructuredFacts[];
  symbols: string[];
  /** Exposición real del usuario en los símbolos preguntados. Se devuelve
   *  aparte de la prosa a propósito: son las cifras que sostienen la
   *  respuesta y tienen que poder verse aunque el redactor falle. */
  position: PositionContext[];
  pressures: Pressure[];
  dated: DatedFact[];
  /** Compromisos sin resolver extraídos de los cuerpos. Va fuera de la
   *  prosa por el mismo criterio que en la revisión de cartera: es lo más
   *  valioso de la respuesta y no puede depender de que el redactor
   *  acierte. Si la 2ª llamada falla, esto se pinta igual. */
  ledger: ForwardItem[];
  model: string | null;
  note?: string;
};

export async function POST(req: Request) {
  // Solo en el Worker público: el daemon local no manda cf-connecting-ip y
  // meterle un cubo compartido castigaría al dueño por usar su dashboard.
  if (isWorkersRuntime && rateLimited(req)) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }
  let question = "";
  try {
    const body = (await req.json()) as { question?: unknown };
    question = typeof body.question === "string" ? body.question.trim() : "";
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  if (question.length < 3) {
    return NextResponse.json({ error: "question_too_short" }, { status: 400 });
  }
  question = question.slice(0, MAX_QUESTION_CHARS);

  const allowLlm = await llmAllowed();
  const intent = classifyIntent(question);

  try {
    // La cartera se pide EN PARALELO con el retrieval, no después: son dos
    // ramas independientes (una consulta a Neon + Finnhub, la otra al
    // archivo) y encadenarlas sumaba su latencia a una pregunta que el
    // usuario está esperando con la pantalla delante.
    const portfolioP: Promise<Portfolio | null> =
      intent === "decision" ? loadPortfolio() : Promise.resolve(null);

    // El embedding de la pregunta es cuota: sólo para el dueño. Si falla
    // (cuota agotada), NO se aborta — se degrada a léxico + SQL, que sigue
    // respondiendo bastantes preguntas.
    let queryVec: number[] | null = null;
    let note: string | undefined;
    if (allowLlm) {
      try {
        [queryVec] = await embedBatch([question], { taskType: "RETRIEVAL_QUERY" });
      } catch (err) {
        if (!(err instanceof EmbedQuotaError)) throw err;
        note = "Búsqueda semántica sin cuota ahora mismo — resultados sólo por texto.";
      }
    }

    // La cosecha de cuerpos (N fetches salientes) va gated a la sesión del
    // dueño, igual que el embedding y el LLM: un endpoint público y
    // enumerable no puede convertirse en un proxy de descargas para bots.
    const r = await retrieve({ question, queryVec, harvest: allowLlm, intent });

    // Los hechos de decisión se calculan SIEMPRE que la intención lo sea,
    // también para el anónimo: son aritmética sobre datos ya en BD, cuestan
    // cero cuota de proveedor y son la parte de la respuesta que no
    // necesita un LLM para ser verdad.
    let decision: DecisionFacts | undefined;
    if (intent === "decision") {
      decision = buildDecisionFacts({
        symbols: r.symbols,
        portfolio: await portfolioP,
        facts: r.facts,
        bars: r.forward.bars,
        sellers: r.forward.sellers,
        deals: r.forward.deals,
        risk: r.forward.risk,
      });
    }
    const decisionOut = {
      position: decision?.contexts ?? [],
      pressures: decision?.pressures ?? [],
      dated: decision?.dated ?? [],
    };

    if (!allowLlm) {
      return NextResponse.json(
        {
          mode: "search",
          intent,
          question,
          answer: null,
          sections: [],
          coverage: hasCoverage(r) ? "partial" : "none",
          citations: r.citations,
          facts: r.facts,
          symbols: r.symbols,
          ...decisionOut,
          // El anónimo no gasta cuota: sin llamada LLM no hay libro de
          // futuros, y devolver [] es lo honesto (no es que no haya
          // compromisos, es que no se han extraído).
          ledger: [],
          model: null,
        } satisfies AskResponse,
        { headers: { "Cache-Control": "no-store" } },
      );
    }

    // DOS llamadas encadenadas y no una, igual que la revisión de cartera.
    // La 1ª sólo EXTRAE compromisos sin resolver a un esquema donde "la
    // acción cayó" no cabe en ningún campo; la 2ª redacta con ese libro
    // delante de las noticias. Con una sola llamada el modelo resume
    // titulares por gradiente natural y ninguna instrucción del prompt lo
    // evita de forma fiable (medido en la revisión el 2026-07-25).
    //
    // Sólo en decisiones: una consulta de archivo no la necesita y pagaría
    // el doble de cuota por nada. Y si falla, la 2ª sigue igual.
    let ledger: ForwardItem[] = [];
    if (intent === "decision") {
      const { candidates, numberOf } = ledgerCandidates(r);
      const extracted = await extractForwardLedger(candidates, numberOf).catch(
        () => null,
      );
      ledger = extracted?.items ?? [];
    }

    const a = await askArchive(r, question, { decision, ledger });
    return NextResponse.json(
      {
        mode: "answer",
        intent,
        question,
        answer: a.answer || null,
        sections: a.sections,
        coverage: a.coverage,
        citations: a.citations,
        facts: r.facts,
        symbols: r.symbols,
        ...decisionOut,
        ledger,
        model: a.model === "none" ? null : a.model,
        note,
      } satisfies AskResponse,
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    console.warn(
      "[api/ask] failed:",
      err instanceof Error ? err.message.slice(0, 160) : err,
    );
    // 200 con estado explícito: el cliente pinta el fallo real, no un error
    // de red genérico (mismo criterio que /api/article).
    return NextResponse.json(
      {
        mode: "answer",
        intent,
        question,
        answer: null,
        sections: [],
        coverage: "none",
        citations: [],
        facts: [],
        symbols: [],
        position: [],
        pressures: [],
        dated: [],
        ledger: [],
        model: null,
        note: "El generador no respondió. Inténtalo de nuevo en un momento.",
      } satisfies AskResponse,
      { headers: { "Cache-Control": "no-store" } },
    );
  }
}

/**
 * La cartera del dueño de la sesión, valorada en vivo.
 *
 * Degrada a `null` ante cualquier fallo y NO tumba la pregunta: sin cartera
 * la respuesta pierde el peso y el P&L, pero conserva insiders, calendario
 * y citas. Un 429 de Finnhub no puede dejar sin responder una pregunta que
 * el archivo sí sabe contestar.
 *
 * Precios en VIVO, nunca de caché: un peso calculado con el precio de ayer
 * es justo el número sobre el que se apoyaría la postura. Mismo criterio
 * que /api/portfolio-review.
 */
async function loadPortfolio(): Promise<Portfolio | null> {
  try {
    const session = await ensureSessionCookie();
    const rows = await getWatchlist(session);
    const live = rows.filter((r) => r.shares !== null && r.shares > 0);
    if (!live.length) return null;
    const quotes = await getQuotesMap(live.map((r) => r.symbol)).catch(() => ({}));
    return buildPortfolio(
      rows.map((r) => ({
        symbol: r.symbol,
        name: r.name,
        sector: r.sector,
        shares: r.shares,
        avgCost: r.avgCost,
      })),
      quotes,
    );
  } catch (err) {
    console.warn(
      "[api/ask] cartera no disponible:",
      err instanceof Error ? err.message.slice(0, 120) : err,
    );
    return null;
  }
}
