import { NextResponse } from "next/server";
import { retrieve, type Citation, type StructuredFacts } from "@/lib/ask/retrieve";
import { askArchive, hasCoverage, type AskSection } from "@/lib/ai/ask";
import { embedBatch, EmbedQuotaError } from "@/lib/providers/gemini-embed";
import { isWorkersRuntime, llmAllowed, rateLimited } from "@/lib/ask/gate";

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
  question: string;
  answer: string | null;
  /** Respuesta troceada en epígrafes cuando el material daba para ello.
   *  Vacío en modo búsqueda y en las respuestas en prosa antiguas. */
  sections: AskSection[];
  coverage: "full" | "partial" | "none";
  citations: Citation[];
  facts: StructuredFacts[];
  symbols: string[];
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

  try {
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
    const r = await retrieve({ question, queryVec, harvest: allowLlm });

    if (!allowLlm) {
      return NextResponse.json(
        {
          mode: "search",
          question,
          answer: null,
          sections: [],
          coverage: hasCoverage(r) ? "partial" : "none",
          citations: r.citations,
          facts: r.facts,
          symbols: r.symbols,
          model: null,
        } satisfies AskResponse,
        { headers: { "Cache-Control": "no-store" } },
      );
    }

    const a = await askArchive(r, question);
    return NextResponse.json(
      {
        mode: "answer",
        question,
        answer: a.answer || null,
        sections: a.sections,
        coverage: a.coverage,
        citations: a.citations,
        facts: r.facts,
        symbols: r.symbols,
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
        question,
        answer: null,
        sections: [],
        coverage: "none",
        citations: [],
        facts: [],
        symbols: [],
        model: null,
        note: "El generador no respondió. Inténtalo de nuevo en un momento.",
      } satisfies AskResponse,
      { headers: { "Cache-Control": "no-store" } },
    );
  }
}
