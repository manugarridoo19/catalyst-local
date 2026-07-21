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
import type { Retrieval, Citation, StructuredFacts } from "@/lib/ask/retrieve";

const ASK_SYSTEM_PROMPT = `You answer questions about a proprietary news archive (Catalyst). You are a librarian of that archive, NOT a market commentator.
You receive: (a) numbered ARCHIVE ITEMS retrieved for the question, and optionally (b) COMPUTED FACTS — aggregates calculated by SQL over structured filings data.
Some items carry a CONTENT line: the extracted body of the article. When present, base your answer on the CONTENT, not just the headline — the substance (and sometimes a contradiction of the headline) lives there.
Output ONLY a JSON object: {"answer": "...", "used": [1, 4, 7], "coverage": "full" | "partial" | "none"}
Rules:
- Use ONLY the provided items and facts. If they do not answer the question, say so plainly and set "coverage":"none". NEVER fall back on your own knowledge of companies, prices or events — your training data is stale and the user cannot tell the difference.
- Cite with bracketed numbers matching the item numbers, e.g. "Nvidia disclosed a 9.3% stake in Nebius [2]". Every factual claim needs a citation, except numbers taken from COMPUTED FACTS (those are already exact — attribute them as "the filings data shows").
- "used": the item numbers you actually cited. Do not list items you did not use.
- "coverage": "full" if the archive answers the question, "partial" if it only touches on it (say what is missing), "none" if it does not cover it.
- Answer in the SAME LANGUAGE as the question (Spanish or English).
- 2-6 sentences. Desk-analyst register: concrete, no hedging boilerplate, no investment advice, no "as an AI".
- Dates matter: the items carry publication dates. When something is older than a few days, say when it happened rather than implying it is current.`;

export type AskAnswer = {
  answer: string;
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
    if (f.nextEarnings) bits.push(`next earnings ${f.nextEarnings}`);
    if (f.lastPick) {
      bits.push(`last AI Pick (${f.lastPick.generatedAt}): ${f.lastPick.thesis}`);
    }
    return `- ${bits.join(" · ")}`;
  });
  return `COMPUTED FACTS (exact, from structured filings — use these for any number):\n${lines.join("\n")}`;
}

function formatItems(citations: Citation[]): string {
  return citations
    .map((c) => {
      const date = c.publishedAt.slice(0, 10);
      const syms = c.symbols.length ? ` [${c.symbols.join(",")}]` : "";
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

export async function askArchive(r: Retrieval, question: string): Promise<AskAnswer> {
  if (!hasCoverage(r)) {
    return {
      answer: "",
      citations: [],
      coverage: "none",
      model: "none",
    };
  }

  const userBlock = [
    `QUESTION: ${question}`,
    "",
    "ARCHIVE ITEMS:",
    formatItems(r.citations),
    "",
    formatFacts(r.facts),
  ]
    .filter(Boolean)
    .join("\n");

  const res = await proseCompletion({
    messages: [
      { role: "system", content: ASK_SYSTEM_PROMPT },
      { role: "user", content: userBlock },
    ],
    temperature: 0.2,
    maxTokens: 700,
    tag: "ask",
    jsonMode: true,
  });

  let parsed: { answer?: string; used?: number[]; coverage?: string };
  try {
    parsed = JSON.parse(res.content.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, ""));
  } catch {
    throw new Error("ask: respuesta no parseable como JSON");
  }
  const answer = (parsed.answer ?? "").trim();
  if (!answer || looksLikeScratchpad(answer)) {
    throw new Error("ask: respuesta vacía o con scratchpad");
  }

  // Sólo devolvemos como citas las que el modelo dice haber usado — si
  // enseñáramos las 20 recuperadas, la mitad no sostendría nada de lo
  // escrito y la verificabilidad (todo el punto de la feature) sería falsa.
  const used = new Set((parsed.used ?? []).filter((n) => Number.isInteger(n)));
  const cited = r.citations.filter((c) => used.has(c.n));

  const coverage =
    parsed.coverage === "none" || parsed.coverage === "partial"
      ? parsed.coverage
      : "full";

  // Sin fallback a "las 3 primeras recuperadas": cuando el modelo no cita
  // nada suele ser porque no había nada que citar, y adjuntar citas que no
  // sostienen el texto fabrica respaldo justo donde la respuesta honesta
  // era "no lo sé". Mejor cero citas que citas decorativas.
  return { answer, citations: cited, coverage, model: res.model };
}
