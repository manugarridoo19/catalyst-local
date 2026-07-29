// Ask Catalyst — responder preguntas SOBRE EL ARCHIVO, con citas.
//
// Regla que define la feature: el modelo sólo puede usar lo recuperado. No
// es un chat de mercados, es un lector del archivo de Catalyst. Si el
// retrieval no trae cobertura, la respuesta correcta es "no hay cobertura",
// no una respuesta plausible sacada del conocimiento del modelo — que
// además estaría congelada en su fecha de corte y sonaría igual de segura.
//
// Los NÚMEROS vienen del bloque de agregados SQL (lib/ask/retrieve.ts), no
// de las citas: el research es explícito en que el RAG vectorial falla en
// conteos y agregados.

import { proseCompletion } from "@/lib/ai/prose-chain";
import { looksLikeScratchpad } from "@/lib/ai/guards";
import type {
  Retrieval,
  Citation,
  StructuredFacts,
  EarningsRead,
} from "@/lib/ask/retrieve";

const ASK_BASE_RULES = `You answer questions about a proprietary news archive (Catalyst). You are a librarian of that archive, NOT a market commentator.
You receive: (a) numbered ARCHIVE ITEMS retrieved for the question, and optionally (b) COMPUTED FACTS — aggregates calculated by SQL over structured filings data.
Item types you may see:
- EARNINGS RELEASE: the company's OWN press release (SEC 8-K exhibit 99.1), already read. This is FIRST-PARTY evidence and outranks any journalism about it. Its CONTENT carries the quarter's real numbers, and a "NOT SAID OUT LOUD" line with what a careful reader notices that the release does not advertise.
- News items. Some carry a CONTENT line: the extracted body of the article. When present, base your answer on the CONTENT, not the headline — the substance (and sometimes a contradiction of the headline) lives there.
Rules:
- Use ONLY the provided items and facts. If they do not answer the question, say so plainly and set "coverage":"none". NEVER fall back on your own knowledge of companies, prices or events — your training data is stale and the user cannot tell the difference.
- Cite with bracketed numbers matching the item numbers, e.g. "Nvidia disclosed a 9.3% stake in Nebius [2]". Every factual claim needs a citation, except numbers taken from COMPUTED FACTS (those are already exact — attribute them as "the filings data shows").
- NEVER do arithmetic. Do not compute percentages, differences, beats, misses or totals from numbers you were given — quote each number as printed and let them sit side by side. Any percentage you did not read verbatim in an item is a fabrication.
- "used": the item numbers you actually cited. Do not list items you did not use.
- "coverage": "full" if the archive answers the question, "partial" if it only touches on it (say what is missing), "none" if it does not cover it.
- Answer in the SAME LANGUAGE as the question (Spanish or English).
- Desk-analyst register: concrete, no hedging boilerplate, no investment advice, no "as an AI".
- Dates matter: the items carry publication dates. When something is older than a few days, say when it happened rather than implying it is current.
- Prefer the specific over the general: a number, a name and a date beat any adjective. If an item only supports a vague claim, leave the claim out.`;

// Respuesta ESTRUCTURADA. Se usa sólo cuando el retrieval trajo material de
// verdad (ver `answerShape`): con dos titulares sueltos, cuatro epígrafes
// producen un esqueleto con secciones vacías, que se lee peor que un párrafo.
const ASK_SECTIONS_PROMPT = `${ASK_BASE_RULES}

Output ONLY a JSON object:
{"sections": [{"key": "numbers", "title": "...", "text": "..."}], "used": [1,4,7], "coverage": "full"}

Write up to FOUR sections, in this order, using exactly these keys:
- "numbers"    — the hard figures. What the company itself reported, and the consensus it was measured against when COMPUTED FACTS provides one. Quote both as printed; never compute the gap between them.
- "reading"    — how the coverage read it, and where sources disagree with each other or with the release. If the price moved against the fundamentals, say so and attribute it.
- "overlooked" — what almost nobody is saying: the NOT SAID OUT LOUD line of the release, a segment shrinking inside a growing total, a contradiction between body and headline. This is the section the reader cannot get from a search engine.
- "watch"      — what is already scheduled or committed: next reporting date and its consensus, pending deals, filings expected. Only dates and commitments that appear in the material. No forecasts.

Section rules:
- "title": a SHORT all-caps label in the question's language (e.g. "LOS NÚMEROS", "THE NUMBERS").
- OMIT any section the material does not support. Four thin sections are worse than two solid ones — an empty heading is a lie about how much the archive knows. Never pad.
- 2-5 sentences per section. Each section carries its own citations.`;

// Respuesta en PROSA. La forma histórica, para preguntas con poco material.
const ASK_PROSE_PROMPT = `${ASK_BASE_RULES}

Output ONLY a JSON object: {"answer": "...", "used": [1,4,7], "coverage": "full" | "partial" | "none"}
- 2-6 sentences, one paragraph.`;

/** Un bloque de la respuesta. `title` null = prosa sin epígrafe. */
export type AskSection = {
  key: string;
  title: string | null;
  text: string;
};

export type AskAnswer = {
  /** Texto plano de toda la respuesta (secciones unidas). Se conserva para
   *  quien sólo quiera el cuerpo sin maquetar. */
  answer: string;
  sections: AskSection[];
  citations: Citation[];
  coverage: "full" | "partial" | "none";
  model: string;
};

function formatFacts(facts: StructuredFacts[]): string {
  if (!facts.length) return "";
  const lines = facts.map((f) => {
    const bits: string[] = [`${f.symbol}${f.name ? ` (${f.name})` : ""}:`];
    bits.push(`${f.newsCount7d} archive items in the last 7d`);
    if (f.avgSentiment7d !== null) {
      bits.push(`avg sentiment ${f.avgSentiment7d.toFixed(2)} (scale -5..+5)`);
    }
    if (f.insiderNet7d !== null && f.insiderNet7d !== 0) {
      bits.push(`insider net 7d $${Math.round(f.insiderNet7d).toLocaleString("en-US")}`);
    }
    if (f.insiderNet30d !== null && f.insiderNet30d !== 0) {
      bits.push(
        `insider net 30d $${Math.round(f.insiderNet30d).toLocaleString("en-US")} (${f.insiderBuyers30d} buyers / ${f.insiderSellers30d} sellers, open-market only)`,
      );
    }
    for (const s of f.stakes) {
      bits.push(
        `13D/G stake by ${s.filer ?? "undisclosed filer"}${s.pct !== null ? ` ${s.pct}% of class` : ""} filed ${s.filedAt}`,
      );
    }
    if (f.nextEarnings) {
      // La fecha sola no dice si la noticia va a ser buena. El consenso sí,
      // y llevaba meses en `earnings_events` sin que /ask lo leyera.
      const est: string[] = [];
      if (f.nextEarningsEps !== null) est.push(`consensus EPS ${f.nextEarningsEps}`);
      if (f.nextEarningsRevenue !== null) {
        est.push(`consensus revenue $${f.nextEarningsRevenue.toLocaleString("en-US")}`);
      }
      bits.push(
        `next earnings ${f.nextEarnings}${f.nextEarningsHour ? ` (${f.nextEarningsHour})` : ""}${
          est.length ? ` — ${est.join(", ")}` : ""
        }`,
      );
    }
    if (f.lastPick) {
      bits.push(`last AI Pick (${f.lastPick.generatedAt}): ${f.lastPick.thesis}`);
    }
    return `- ${bits.join(" · ")}`;
  });
  return `COMPUTED FACTS (exact, from structured filings — use these for any number):\n${lines.join("\n")}`;
}

/**
 * Contenido del ítem cuando la cita ES el comunicado de resultados.
 *
 * Va dentro del propio ítem numerado y no en un bloque aparte para que el
 * modelo pueda CITARLO como cualquier otra fuente: el lector pincha el [1] y
 * aterriza en el exhibit del 8-K en EDGAR. Un bloque suelto sería
 * inverificable, que es justo lo que esta feature no puede permitirse.
 */
function formatEarningsContent(e: EarningsRead): string {
  const lines = e.summary.map((b) => `      • ${b}`);
  const out = [`    CONTENT (the company's own release):`, ...lines];
  if (e.readBetweenLines) {
    out.push(`    NOT SAID OUT LOUD: ${e.readBetweenLines}`);
  }
  const est: string[] = [];
  if (e.epsEstimate !== null) est.push(`EPS ${e.epsEstimate}`);
  if (e.revenueEstimate !== null) {
    est.push(`revenue $${e.revenueEstimate.toLocaleString("en-US")}`);
  }
  if (est.length) {
    out.push(
      `    CONSENSUS THIS QUARTER WAS MEASURED AGAINST: ${est.join(", ")} (quote it next to the reported figure; do NOT compute the difference)`,
    );
  }
  return out.join("\n");
}

function formatItems(citations: Citation[], earnings: EarningsRead[]): string {
  const bySymbol = new Map(earnings.map((e) => [e.symbol, e]));
  return citations
    .map((c) => {
      const date = c.publishedAt.slice(0, 10);
      const syms = c.symbols.length ? ` [${c.symbols.join(",")}]` : "";
      if (c.via === "filing") {
        const e = bySymbol.get(c.symbols[0]);
        const head = `[${c.n}] ${date}${syms} EARNINGS RELEASE — ${c.headline} (${c.source})`;
        return e ? `${head}\n${formatEarningsContent(e)}` : head;
      }
      const head = `[${c.n}] ${date}${syms} ${c.headline}${c.summary ? ` — ${c.summary}` : ""} (${c.source})`;
      // El cuerpo extraído del artículo (cuando existe) es lo que permite
      // ANALIZAR en vez de parafrasear el titular — p.ej. el titular dice
      // "cae la acción" y el cuerpo cuenta las compras institucionales.
      return c.body ? `${head}\n    CONTENT: ${c.body}` : head;
    })
    .join("\n");
}

/**
 * Puerta de cobertura ANTES de gastar una llamada LLM.
 *
 * Decide si el retrieval trae material suficiente para que responder tenga
 * sentido. Devolver `false` corta aquí: el usuario ve "no hay cobertura en
 * el archivo" sin que se genere nada.
 *
 * El compromiso: ser estricto evita respuestas construidas sobre dos
 * titulares tangenciales (el modo de fallo que hace inútil un RAG), pero
 * ser demasiado estricto rechaza preguntas legítimas sobre temas con poca
 * cobertura, que son justo donde el archivo aporta algo que Google no.
 */
// Umbral de distancia coseno para "esta cita habla de lo que preguntan".
// gemini-embedding-001@768 normalizado: pares relacionados suelen caer en
// ~0.3-0.5 y ruido temático en >0.65. 0.62 por defecto, ajustable por env
// sin desplegar (ASK_MAX_DIST) — calibrar mirando `dist` en las citas.
const MAX_VECTOR_DIST = Number(process.env.ASK_MAX_DIST ?? 0.62);

export function hasCoverage(r: Retrieval): boolean {
  // Símbolo reconocido → hay agregados SQL reales que contar: siempre vale.
  if (r.facts.length > 0) return true;
  if (r.vectorUsed) {
    // Pregunta temática sin ticker: exigir ≥2 citas semánticamente CERCA.
    // El caso real que motiva esto: "quantum computing" recuperó 18 items,
    // ninguno relevante, y se gastó la llamada LLM para oír "no coverage".
    const near = r.citations.filter(
      (c) => c.via === "vector" && c.dist !== undefined && c.dist <= MAX_VECTOR_DIST,
    );
    return near.length >= 2;
  }
  // Léxico puro (anónimo o cuota agotada): no hay distancia que juzgar;
  // con ≥2 matches se intenta — el coste es una query, no una llamada LLM.
  return r.citations.length >= 2;
}

/**
 * ¿Respuesta por secciones o en prosa? Lo decide el MATERIAL, no el modelo.
 *
 * Con un comunicado de resultados leído, o con bastantes citas de las que
 * varias traen cuerpo, hay sustancia para separar cifras / lectura / lo que
 * nadie mira / qué viene. Sin eso, los epígrafes salen medio vacíos y el
 * andamiaje aparenta una profundidad que el archivo no tiene — que es
 * exactamente el fallo que esta feature existe para no cometer.
 */
export function answerShape(r: Retrieval): "sections" | "prose" {
  if (r.earnings.length > 0) return "sections";
  if (r.citations.length >= 6 && r.bodiesAvailable >= 2) return "sections";
  return "prose";
}

/** Techo de salida por forma. En prosa el prompt pide 2-6 frases y el cap
 *  nunca se roza (medido: ~90 tokens); en secciones sí hace falta sitio. */
const MAX_TOKENS: Record<"sections" | "prose", number> = {
  sections: 1600,
  prose: 700,
};

const SECTION_KEYS = ["numbers", "reading", "overlooked", "watch"];

export async function askArchive(r: Retrieval, question: string): Promise<AskAnswer> {
  if (!hasCoverage(r)) {
    return {
      answer: "",
      sections: [],
      citations: [],
      coverage: "none",
      model: "none",
    };
  }

  const shape = answerShape(r);
  const userBlock = [
    `QUESTION: ${question}`,
    "",
    "ARCHIVE ITEMS:",
    formatItems(r.citations, r.earnings),
    "",
    formatFacts(r.facts),
  ]
    .filter(Boolean)
    .join("\n");

  const res = await proseCompletion({
    messages: [
      {
        role: "system",
        content: shape === "sections" ? ASK_SECTIONS_PROMPT : ASK_PROSE_PROMPT,
      },
      { role: "user", content: userBlock },
    ],
    temperature: 0.2,
    maxTokens: MAX_TOKENS[shape],
    tag: "ask",
    jsonMode: true,
    // Cuatro epígrafes con citas son ~1.900 chars de salida y el modelo de
    // cabeza tarda ~24s en escribirlos: con los 25s por defecto se quedaba
    // JUSTO fuera y contestaba el de reserva. Techo de pared para que un
    // modelo lento no encadene un timeout por key (ver gemini.ts).
    geminiTimeoutMs: shape === "sections" ? 50_000 : 25_000,
    geminiOverallTimeoutMs: shape === "sections" ? 75_000 : 45_000,
  });

  // Rastro del modelo que REALMENTE respondió. La cadena de fallback es
  // silenciosa por dentro (prose-chain sólo avisa al saltar de PROVEEDOR,
  // no de modelo dentro de Gemini), así que sin esta línea no hay forma de
  // auditar a posteriori por qué una respuesta salió firmada por el modelo
  // de reserva — que es justo la queja que abrió esta sesión.
  console.log(
    `[ask] model=${res.model} shape=${shape} citas=${r.citations.length} ` +
      `cuerpos=${r.bodiesAvailable} cosecha=${r.harvested}/${r.attempted} ` +
      `comunicados=${r.earnings.length}`,
  );

  let parsed: {
    answer?: string;
    sections?: Array<{ key?: string; title?: string; text?: string }>;
    used?: number[];
    coverage?: string;
  };
  try {
    parsed = JSON.parse(res.content.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, ""));
  } catch {
    throw new Error("ask: respuesta no parseable como JSON");
  }

  const sections = normalizeSections(parsed);
  const answer = sections.map((s) => s.text).join("\n\n").trim();
  if (!answer || looksLikeScratchpad(answer)) {
    throw new Error("ask: respuesta vacía o con scratchpad");
  }

  // Sólo devolvemos como citas las que el modelo dice haber usado — si
  // enseñáramos las 20 recuperadas, la mitad no sostendría nada de lo
  // escrito y la verificabilidad (todo el punto de la feature) sería falsa.
  // Los `[n]` que el modelo escribe DENTRO del texto se FUSIONAN con `used`
  // (aquí no se limpian del texto, al revés que en la revisión de cartera:
  // la UI de /ask no añade marcadores propios, así que los inline son los
  // que ve el lector y quitarlos dejaría el texto sin respaldo visible).
  // Sin la fusión, una fuente citada en línea pero ausente de `used`
  // desaparecía de la lista de Sources y el [3] del texto no llevaba a nada.
  const used = new Set([
    ...(parsed.used ?? []).filter((n) => Number.isInteger(n)),
    ...inlineMarkers(answer),
  ]);
  const cited = r.citations.filter((c) => used.has(c.n));

  const coverage =
    parsed.coverage === "none" || parsed.coverage === "partial"
      ? parsed.coverage
      : "full";

  // Sin fallback a "las 3 primeras recuperadas": cuando el modelo no cita
  // nada suele ser porque no había nada que citar, y adjuntar citas que no
  // sostienen el texto fabrica respaldo justo donde la respuesta honesta
  // era "no lo sé". Mejor cero citas que citas decorativas.
  return { answer, sections, citations: cited, coverage, model: res.model };
}

/** Números de cita escritos en línea: "[4]" y también "[1, 2]". */
export function inlineMarkers(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(/\[(\d+(?:\s*,\s*\d+)*)\]/g)) {
    for (const part of m[1].split(",")) {
      const n = Number(part.trim());
      if (Number.isInteger(n)) out.push(n);
    }
  }
  return out;
}

/**
 * Normaliza la salida del modelo a secciones, venga en la forma que venga.
 *
 * Acepta las dos formas a propósito: el mismo parser sirve para la respuesta
 * en prosa (un `answer` suelto → una sección sin título) y para la
 * estructurada, y un modelo de reserva que ignore el esquema y devuelva
 * `answer` en modo secciones sigue produciendo una respuesta válida en vez
 * de un 500. La cadena de fallback llega hasta llama-3.1-8b: el parser tiene
 * que tolerar al peor eslabón.
 */
export function normalizeSections(parsed: {
  answer?: string;
  sections?: Array<{ key?: string; title?: string; text?: string }>;
}): AskSection[] {
  const out: AskSection[] = [];
  if (Array.isArray(parsed.sections)) {
    for (const s of parsed.sections) {
      const text = typeof s?.text === "string" ? s.text.trim() : "";
      if (!text) continue; // sección vacía = sección que no existe
      const key =
        typeof s.key === "string" && SECTION_KEYS.includes(s.key) ? s.key : "other";
      const title =
        typeof s.title === "string" && s.title.trim()
          ? s.title.trim().slice(0, 40)
          : null;
      out.push({ key, title, text });
    }
  }
  if (out.length) return out;
  const answer = typeof parsed.answer === "string" ? parsed.answer.trim() : "";
  return answer ? [{ key: "answer", title: null, text: answer }] : [];
}
