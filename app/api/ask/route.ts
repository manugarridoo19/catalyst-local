import { NextResponse } from "next/server";
import {
  extractQuestionSymbols,
  ledgerCandidates,
  retrieve,
  type Citation,
  type StructuredFacts,
} from "@/lib/ask/retrieve";
import {
  askArchive,
  hasCoverage,
  type AskSection,
  type AskTurn,
} from "@/lib/ai/ask";
import { extractForwardLedger, type ForwardItem } from "@/lib/ai/forward-ledger";
import { embedBatch, EmbedQuotaError } from "@/lib/providers/gemini-embed";
import { isWorkersRuntime, llmAllowed, rateLimited } from "@/lib/ask/gate";
import {
  classifyFocus,
  classifyJob,
  classifyScope,
  type AskFocus,
  type AskJob,
  type AskScope,
} from "@/lib/ask/intent";
import { parseAxes, type Axes } from "@/lib/coach/frames";
import {
  buildDecisionFacts,
  type DatedFact,
  type DecisionFacts,
  type PositionContext,
  type Pressure,
} from "@/lib/ask/decision";
import {
  buildPortfolio,
  dayAttribution,
  type DayAttribution,
  type Portfolio,
} from "@/lib/portfolio";
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
// Límites del historial de conversación: 3 turnos y respuestas recortadas.
// El historial es CONTEXTO para el seguimiento, no material — con más se
// come el presupuesto de tokens del material real, que es el que manda.
const MAX_HISTORY_TURNS = 3;
const MAX_HISTORY_ANSWER_CHARS = 700;
const SYMBOL_RE = /^[A-Z0-9.\-]{1,10}$/;

type HistoryIn = { question: string; answer: string; symbols: string[] };

/** Valida y acota el historial que manda el cliente. Formato hostil no
 *  rompe nada: lo que no case, se tira. */
function parseHistory(raw: unknown): HistoryIn[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (t): t is { question: string; answer: string; symbols?: unknown } =>
        !!t &&
        typeof (t as { question?: unknown }).question === "string" &&
        typeof (t as { answer?: unknown }).answer === "string",
    )
    .slice(-MAX_HISTORY_TURNS)
    .map((t) => ({
      question: t.question.trim().slice(0, MAX_QUESTION_CHARS),
      answer: t.answer.trim().slice(0, MAX_HISTORY_ANSWER_CHARS),
      symbols: Array.isArray(t.symbols)
        ? t.symbols
            .filter((s): s is string => typeof s === "string")
            .map((s) => s.toUpperCase())
            .filter((s) => SYMBOL_RE.test(s))
            .slice(0, 8)
        : [],
    }))
    .filter((t) => t.question.length >= 3);
}

export type AskResponse = {
  mode: "answer" | "search";
  /** Qué TRABAJO se detectó. La UI pinta la exposición y las presiones sólo
   *  en `decision` — en una consulta de archivo serían ruido. */
  job: AskJob;
  /** Sobre QUÉ va: un valor nombrado, la cartera entera o un tema. Se
   *  devuelve para poder auditar desde fuera el fallo que abrió esto — una
   *  pregunta sobre "mi cartera" que acaba respondiendo sobre Altria. */
  scope: AskScope;
  /** Qué decisión se pregunta (entrar dinero / sacarlo / general). Se
   *  devuelve para poder auditar desde fuera que el veredicto respondió a
   *  la pregunta que se hizo. */
  focus: AskFocus;
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
  let history: HistoryIn[] = [];
  try {
    const body = (await req.json()) as { question?: unknown; history?: unknown };
    question = typeof body.question === "string" ? body.question.trim() : "";
    history = parseHistory(body.history);
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  if (question.length < 3) {
    return NextResponse.json({ error: "question_too_short" }, { status: 400 });
  }
  question = question.slice(0, MAX_QUESTION_CHARS);

  const allowLlm = await llmAllowed();
  const job = classifyJob(question);
  const focus = classifyFocus(question);
  // Arranca en `thematic` y se afina dentro del try, en cuanto se sabe si la
  // pregunta nombra algún valor. Vive fuera para que el `catch` pueda
  // devolverlo: una respuesta fallida también tiene que decir cómo se
  // enrutó, que es lo que hizo falta para diagnosticar esto.
  let scope: AskScope = "thematic";

  try {
    // Los símbolos se extraen UNA sola vez, aquí, y viajan a `retrieve`. El
    // alcance depende de si la pregunta nombra alguno y `retrieve` necesita
    // el mismo resultado: extraerlo dos veces sería una query por pregunta a
    // cambio de nada.
    const named = await extractQuestionSymbols(question);
    scope = classifyScope(question, named.length > 0);

    // La cartera se pide EN PARALELO con el retrieval, no después: son dos
    // ramas independientes (una consulta a Neon + Finnhub, la otra al
    // archivo) y encadenarlas sumaba su latencia a una pregunta que el
    // usuario está esperando con la pantalla delante.
    //
    // Con alcance de cartera hace falta además ANTES del retrieval, porque
    // los símbolos salen de ella. Sigue lanzándose aquí para que se solape
    // con el embedding de la pregunta, que es lo que va justo debajo.
    const portfolioP: Promise<PortfolioWithFrames> =
      job === "decision" || scope === "portfolio"
        ? loadPortfolio()
        : Promise.resolve({ portfolio: null, frames: new Map() });

    // El embedding de la pregunta es cuota: sólo para el dueño. Si falla
    // (cuota agotada), NO se aborta — se degrada a léxico + SQL, que sigue
    // respondiendo bastantes preguntas.
    let queryVec: number[] | null = null;
    let note: string | undefined;
    // En un seguimiento, la pregunta sola es mal vector: "¿y a largo
    // plazo?" no significa nada sin la pregunta anterior. Se embebe la
    // última pregunta + la nueva (mismo coste: sigue siendo 1 embedding).
    const lastTurn = history.at(-1);
    const embedText = lastTurn
      ? `${lastTurn.question}\n${question}`
      : question;
    if (allowLlm) {
      try {
        [queryVec] = await embedBatch([embedText], { taskType: "RETRIEVAL_QUERY" });
      } catch (err) {
        // CUALQUIER fallo del embed degrada; antes sólo lo hacía
        // `EmbedQuotaError` y el resto se relanzaba, tumbando la pregunta
        // entera. Pero `embedBatch` marca como no-cuota todo lo que no sea
        // 429/401/403 (un 503 de Google, un `shape mismatch`), así que un
        // incidente pasajero del proveedor devolvía "El generador no
        // respondió" cuando los canales léxico y SQL —que no gastan cuota—
        // habrían contestado igual. El vector es UN canal de tres, y perderlo
        // nunca puede costar los otros dos.
        note =
          err instanceof EmbedQuotaError
            ? "Búsqueda semántica sin cuota ahora mismo — resultados sólo por texto."
            : "Búsqueda semántica no disponible ahora mismo — resultados sólo por texto.";
        if (!(err instanceof EmbedQuotaError)) {
          console.warn(
            "[api/ask] embed de la pregunta falló, se sigue sin vectorial:",
            err instanceof Error ? err.message.slice(0, 140) : err,
          );
        }
      }
    }

    // ── El alcance de CARTERA se resuelve aquí, y es el arreglo del fallo
    // que abrió esto: los siete valores del libro no se adivinan desde el
    // texto de la pregunta. Sin esto, "por qué cae mi cartera" no extraía
    // ningún símbolo y el retrieval se iba a buscar por parecido semántico —
    // devolviendo 20 de 20 citas de empresas que el usuario no tiene.
    let forceSymbols = named;
    let attribution: DayAttribution | undefined;
    if (scope === "portfolio") {
      const { portfolio } = await portfolioP;
      const held = portfolio?.positions.map((p) => p.symbol) ?? [];
      if (held.length) {
        forceSymbols = held;
        // El arrastre del día: la mitad de la respuesta a "por qué cae hoy",
        // y no sale de ninguna noticia. Aritmética en TS, jamás del modelo.
        attribution = dayAttribution(portfolio!);
      } else {
        // Sin posiciones registradas no HAY cartera de la que hablar, y
        // sostener el alcance produciría una respuesta sobre un conjunto
        // vacío. Degradar a temático deja que el archivo conteste lo que
        // pueda, que es lo honesto.
        scope = "thematic";
      }
    }

    // La cosecha de cuerpos (N fetches salientes) va gated a la sesión del
    // dueño, igual que el embedding y el LLM: un endpoint público y
    // enumerable no puede convertirse en un proxy de descargas para bots.
    const r = await retrieve({
      question,
      queryVec,
      harvest: allowLlm,
      job,
      scope,
      forceSymbols,
      // Herencia de símbolos del turno anterior — solo actúa si la
      // pregunta nueva no nombra ninguno (ver retrieve).
      carrySymbols: lastTurn?.symbols,
    });

    // Los hechos de decisión se calculan SIEMPRE que la intención lo sea,
    // también para el anónimo: son aritmética sobre datos ya en BD, cuestan
    // cero cuota de proveedor y son la parte de la respuesta que no
    // necesita un LLM para ser verdad.
    let decision: DecisionFacts | undefined;
    if (job === "decision") {
      const { portfolio, frames } = await portfolioP;
      decision = buildDecisionFacts({
        symbols: r.symbols,
        portfolio,
        facts: r.facts,
        bars: r.forward.bars,
        sellers: r.forward.sellers,
        deals: r.forward.deals,
        risk: r.forward.risk,
        // Los 13F de las gestoras curadas. `fund_holdings` llevaba 1.782
        // filas leídas SÓLO por la página /insider (auditado 2026-08-07).
        fundChanges: r.forward.fundChanges,
        // El comunicado leído + el marco declarado: es lo que convierte
        // "ingresos récord y guía elevada" en presión dura del lado
        // AMPLIAR, con el mismo lector que el coach (2026-07-31).
        earnings: r.earnings,
        frames,
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
          job,
          scope,
          focus,
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
    if (job === "decision") {
      const { candidates, numberOf } = ledgerCandidates(r);
      const extracted = await extractForwardLedger(candidates, numberOf).catch(
        () => null,
      );
      ledger = extracted?.items ?? [];
    }

    const a = await askArchive(r, question, {
      decision,
      ledger,
      focus,
      history: history satisfies AskTurn[],
      attribution,
    });
    return NextResponse.json(
      {
        mode: "answer",
        job,
        scope,
        focus,
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
        job,
        scope,
        focus,
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
type PortfolioWithFrames = {
  portfolio: Portfolio | null;
  /** El MARCO declarado de cada símbolo (los ejes del coach), para leer la
   *  atribución del comunicado con el mismo lector que el panel. `null` en
   *  el mapa = posición sin clasificar, que también es información. */
  frames: Map<string, Axes | null>;
};

async function loadPortfolio(): Promise<PortfolioWithFrames> {
  try {
    const session = await ensureSessionCookie();
    const rows = await getWatchlist(session);
    const frames = new Map<string, Axes | null>(
      rows.map((r) => [
        r.symbol,
        parseAxes({
          madurez: r.frameMadurez,
          capital: r.frameCapital,
          ciclo: r.frameCiclo,
        }),
      ]),
    );
    const live = rows.filter((r) => r.shares !== null && r.shares > 0);
    if (!live.length) return { portfolio: null, frames };
    const quotes = await getQuotesMap(live.map((r) => r.symbol)).catch(() => ({}));
    return {
      portfolio: buildPortfolio(
        rows.map((r) => ({
          symbol: r.symbol,
          name: r.name,
          sector: r.sector,
          shares: r.shares,
          avgCost: r.avgCost,
        })),
        quotes,
      ),
      frames,
    };
  } catch (err) {
    console.warn(
      "[api/ask] cartera no disponible:",
      err instanceof Error ? err.message.slice(0, 120) : err,
    );
    return { portfolio: null, frames: new Map() };
  }
}
