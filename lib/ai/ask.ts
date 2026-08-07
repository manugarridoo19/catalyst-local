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
import { warnIfTruncated } from "@/lib/providers/response";
import { looksLikeScratchpad } from "@/lib/ai/guards";
import { getEmpiricalPriors } from "@/lib/signals/priors";
import type { ForwardItem } from "@/lib/ai/forward-ledger";
import {
  hasDecisionEvidence,
  type DecisionFacts,
  type PositionContext,
} from "@/lib/ask/decision";
import type {
  Retrieval,
  Citation,
  StructuredFacts,
  EarningsRead,
} from "@/lib/ask/retrieve";

// Los tipos de material y las reglas de evidencia son COMUNES a las dos
// clases de pregunta. Lo que cambia entre ellas es el papel del modelo, y
// por eso el papel se declara aparte: el bibliotecario tiene prohibido
// opinar y el analista está obligado a hacerlo, pero ninguno de los dos
// puede inventarse un número ni citar de memoria.
const ITEM_TYPES = `Item types you may see:
- EARNINGS RELEASE: the company's OWN press release (SEC 8-K exhibit 99.1), already read. This is FIRST-PARTY evidence and outranks any journalism about it. Its CONTENT carries the quarter's real numbers, and a "NOT SAID OUT LOUD" line with what a careful reader notices that the release does not advertise.
- News items. Some carry a CONTENT line: the extracted body of the article. When present, base your answer on the CONTENT, not the headline — the substance (and sometimes a contradiction of the headline) lives there.`;

const EVIDENCE_RULES = `- Use ONLY the provided items and facts. If they do not answer the question, say so plainly and set "coverage":"none". NEVER fall back on your own knowledge of companies, prices or events — your training data is stale and the user cannot tell the difference.
- Cite with bracketed numbers matching the item numbers, e.g. "Nvidia disclosed a 9.3% stake in Nebius [2]". Every factual claim needs a citation, except numbers taken from COMPUTED FACTS (those are already exact — attribute them as "the filings data shows").
- NEVER do arithmetic. Do not compute percentages, differences, beats, misses or totals from numbers you were given — quote each number as printed and let them sit side by side. Any percentage you did not read verbatim in an item is a fabrication. Beats and misses against consensus arrive already computed on a "VS CONSENSUS (precomputed)" line when they can be computed soundly; when that line is absent for a metric, the comparison is NOT available and you must not produce one.
- "used": the item numbers you actually cited. Do not list items you did not use.
- "coverage": "full" if the archive answers the question, "partial" if it only touches on it (say what is missing), "none" if it does not cover it.
- LANGUAGE: write the ENTIRE answer in the language of the QUESTION. The question decides this and nothing else — the archive items are almost all in English, and drifting into their language because you just read them is the single most common way this answer comes back wrong. A Spanish question gets Spanish prose, including when every fact you cite came from an English source. Headings follow the same rule as the body.
- Dates matter: the items carry publication dates. When something is older than a few days, say when it happened rather than implying it is current.
- Prefer the specific over the general: a number, a name and a date beat any adjective. If an item only supports a vague claim, leave the claim out.`;

const ASK_BASE_RULES = `You answer questions about a proprietary news archive (Catalyst). You are a librarian of that archive, NOT a market commentator.
You receive: (a) numbered ARCHIVE ITEMS retrieved for the question, and optionally (b) COMPUTED FACTS — aggregates calculated by SQL over structured filings data.
${ITEM_TYPES}
Rules:
${EVIDENCE_RULES}
- Desk-analyst register: concrete, no hedging boilerplate, no investment advice, no "as an AI".`;

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

// Respuesta de PREVIA. La cuarta forma, y existe por el mismo motivo que la
// de decisión: la pregunta no cabía en ninguna de las otras.
//
// "¿Cómo se espera que sea la earnings report de $NU?" caía en `sections`,
// cuyo epígrafe de futuro dice "No forecasts" — así que el modelo tenía
// prohibido responder lo que se le preguntaba, y contestaba con la fecha.
//
// La salida de esta forma NO es un pronóstico, y eso no es un rodeo: una
// previa de mesa nunca lo es. Es la VARA (el consenso, y cómo lo han movido),
// el HISTORIAL de la empresa contra esa vara, lo que ha CAMBIADO desde el
// trimestre pasado y quién está POSICIONADO. Los cuatro son hechos
// verificables, y juntos responden la pregunta mucho mejor que un número
// inventado. La línea roja del proyecto no se mueve: ni cifra estimada, ni
// dirección de precio, ni "va a batir".
const ASK_PREVIEW_PROMPT = `You are a desk analyst writing the PREVIEW of a quarter that has NOT been reported yet. The reader has the date and the headline consensus in his broker already; what he cannot assemble himself is everything else on this table.

You receive: (a) numbered ARCHIVE ITEMS — news and, when available, the company's OWN last earnings release; (b) COMPUTED FACTS — exact aggregates from structured filings, including the consensus for the upcoming quarter, HOW THAT CONSENSUS HAS BEEN REVISED, and the company's SURPRISE HISTORY against consensus; (c) WHAT IS ALREADY SET — scheduled dates, disclosed future supply of stock, open corporate actions and structural risk.
${ITEM_TYPES}

A PREVIEW IS NOT A FORECAST, and this is not a dodge — no desk preview is. You must NEVER produce an estimated number of your own, never say the company "will beat" or "will miss", and never predict the share price or its direction. What you DO is lay out what is known and what it bears on: the bar, the company's record against that bar, what has changed since it last reported, and who is positioned. A reader who finishes your answer should know exactly which lines to look at when the release drops.

Output ONLY a JSON object:
{"sections": [{"key": "bar", "title": "...", "text": "..."}], "used": [1,4], "coverage": "full"}

Sections, in this order, using exactly these keys (OMIT any the material does not support — an empty heading is a lie about how much the archive knows):
- "bar"      — the consensus to beat, quoted verbatim from COMPUTED FACTS, with the reporting date and session. If a CONSENSUS REVISION line is present, say which way the bar has moved and over how many days: a bar that was just cut is a different bar. Never compute a revision yourself.
- "record"   — how this company has done against consensus in the quarters the archive has measured, from the SURPRISE HISTORY line, quoted as printed. If there is only one quarter, say so plainly — one quarter is not a record. If there is none, omit this section entirely.
- "since"    — what has happened since the last report that bears on this one: guidance given, licences obtained, deals signed or closed, segments called out. This is where the article CONTENT earns its place. Say what the company COMMITTED to, not what the stock did.
- "position" — who is positioned and how: 13D/G stakes, insider buying or selling (open-market only), days-to-cover and any change in it, funds opening or closing. Facts that someone had to file, never sentiment or coverage volume.
- "watch"    — the specific lines to read when the release lands, drawn from the last release's own guidance and from what it did NOT say out loud. Concrete: a segment, a margin, a metric the company itself has been steering by.
- "unknown"  — what the archive does not have and would change the picture. Name it concretely. Never padding: it is what stops the rest from reading as more certain than it is.

Section rules:
- "title": a SHORT all-caps label in the question's language, e.g. "LA VARA", "EL HISTORIAL", "LO QUE HA CAMBIADO", "QUIÉN ESTÁ POSICIONADO", "QUÉ MIRAR", "LO QUE NO SÉ".
- 2-4 sentences per section. Each section carries its own citations.
- If the archive has NOT read this company's own last release, say so in "unknown": it is the single biggest gap a preview can have, and the reader must know he is getting one built from journalism.

${EVIDENCE_RULES}`;

// Respuesta de DECISIÓN. La tercera forma, y la que existe porque las otras
// dos NO respondían: preguntado "¿dejo correr $MSFT o vendo una parte?", un
// bibliotecario con prohibición de opinar sólo puede describir MSFT.
//
// El papel cambia; las reglas de evidencia NO. Este modelo se moja, pero se
// moja sobre EXPOSICIÓN (cuánto de tu dinero está en juego y frente a qué
// desenlace fechado), nunca sobre dirección de precio. La diferencia no es
// retórica: lo primero sale de datos que están en la mesa —el peso de la
// posición, la fecha del evento, el papel que un directivo tiene declarado
// que va a colocar—, lo segundo sería adivinar.
//
// Los LADOS vienen ya asignados desde `lib/ask/decision.ts`. Que el modelo
// no tenga que decidir si un dato empuja a aguantar o a recortar es
// deliberado: ahí es exactamente donde improvisaría.
const ASK_DECISION_PROMPT = `You are the owner's PARTNER at the desk — the second pair of eyes he trusts to have a view of their own. He owns the book; you have read everything Catalyst knows. He is asking what to do about a position he holds or is weighing: enter, add, hold, trim or exit. He has his broker open in another tab: he already sees the price, the day's move and the headlines. Repeating any of that is worthless to him.

You receive: (a) YOUR POSITION — his exposure, already computed; (b) PRESSURES — hard facts already labelled with the side they push towards; (c) DATED — what is already scheduled and will settle part of the question; (d) the FORWARD LEDGER — commitments extracted from the article bodies that have NOT been resolved yet, each with its deadline and its condition; (e) numbered ARCHIVE ITEMS, which are support material to cite and NOT something to summarise; (f) COMPUTED FACTS.
${ITEM_TYPES}

ANSWER THE QUESTION HE ASKED, ON THE HORIZON HE ASKED IT. "A largo plazo" / "long term" means the verdict rides on the trajectory of the BUSINESS (segment margins, member growth, guidance, who is accumulating) and a dated event next quarter is context for timing, not the verdict; volatility arguments carry less weight on that horizon. Declining to answer, deferring to "a financial advisor", or describing the company instead of taking a position is a FAILED answer.

A PARTNER COMMITS. Pick ONE verdict — AMPLIAR (add money), ENTRAR (initiate), AGUANTAR (hold), RECORTAR (trim), SALIR (exit) — and open the stance with it. If the evidence leans, you lean with it; "the archive does not settle it" is reserved for when BOTH sides are genuinely empty, and even then say which single missing piece would tip you. What you must never do is trade conviction for fabrication: every fact you lean on must come from the material.

USE EVERYTHING ON THE TABLE. Before writing, take stock of every block you received — position, every pressure on every side, every dated entry, the ledger, computed facts, every item with CONTENT. A stance that cites one item while ten sit unused is a summary, not an analysis: the sections together should draw on every block that has substance, and where sources disagree, say which one you weigh more and why.

Output ONLY a JSON object:
{"sections": [{"key": "stance", "title": "...", "text": "..."}], "used": [1,4], "coverage": "full"}

Sections, in this order, using exactly these keys (omit "add", "hold" or "trim" only if that side has literally nothing):
- "stance"  — 2-3 sentences. Open with the verdict. Then the two or three facts that carry it, drawn from DIFFERENT blocks when possible (a pressure, a dated event, an item's CONTENT), and one clause on what would change your mind. Judge the QUALITY of each side's case out loud — "the bear case rests on volatility alone; the bull case is carried by the operating numbers" is exactly your job. State the verdict about EXPOSURE, never as a price call, and never name an amount or a share count.
- "add"     — the case for putting NEW money in (or entering, if he has no position). Built from PRESSURES marked add plus what the items support. This is not the same side as hold: hold defends what is there, add asks for more capital and needs the stronger case.
- "hold"    — the case for leaving the position alone. Built from PRESSURES marked hold plus what the items support.
- "trim"    — the case for taking part of it off. Same rule.
- "decides" — what is already on the calendar or already committed that will resolve this, with its date. The FORWARD LEDGER is the primary source for this section: it is the only thing here he cannot see in his broker. Only dates and commitments present in the material. No forecasts.
- "unknown" — what would change your answer and the archive does not know. Name the gap concretely (a body that could not be extracted, a position with no coverage, an estimate that is missing). This section is never padding: it is what stops the rest from reading as more certain than it is.

Section rules:
- "title": a SHORT all-caps label in the question's language, e.g. "POSTURA", "A FAVOR DE AMPLIAR", "A FAVOR DE AGUANTAR", "A FAVOR DE RECORTAR", "LO QUE LO DECIDE", "LO QUE NO SÉ".
- 2-3 sentences for "stance", 2-4 for the rest. Each section carries its own citations.
- The PRESSURES block already states which side each fact pushes towards. Use that assignment; do not re-argue it and do not move a fact to the other side.
- NEVER predict a price or a direction ("va a subir", "el suelo está en"). NEVER name an amount or a number of shares to execute — you do not know his tax situation, his horizon or his other assets, and inventing precision there is the one error he cannot audit.
- Quote the numbers of YOUR POSITION exactly as printed. Never recompute a weight, a P&L or a total. Write them into your prose as ordinary text ("pesa un 27,6% de la cartera"); square brackets are ONLY for citation numbers and anything else you put inside them will be deleted.
- Do not moralise, do not add disclaimers, do not say "consult a professional", do not say "as an AI". He built this tool on purpose.

${EVIDENCE_RULES}`;

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

/** Cifra grande en la escala en que la gente la dice. Por encima de 1.000M
 *  el número entero es exacto e ilegible, y lo que el modelo copia literal
 *  a la respuesta es lo que ve escrito aquí. */
function fmtBillions(n: number): string {
  if (Math.abs(n) >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (Math.abs(n) >= 1e6) return `$${(n / 1e6).toFixed(0)}M`;
  return `$${n.toLocaleString("en-US")}`;
}

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
        // En miles de millones y no con los 12 dígitos crudos: el modelo
        // copiaba "91,452,019,309 dólares" literal a la respuesta, que es
        // exacto e ilegible. La escala la aplica el código, como todo
        // número aquí — el modelo sigue sin poder tocarlo.
        est.push(`consensus revenue ${fmtBillions(f.nextEarningsRevenue)}`);
      }
      bits.push(
        `next earnings ${f.nextEarnings}${f.nextEarningsHour ? ` (${f.nextEarningsHour})` : ""}${
          est.length ? ` — ${est.join(", ")}` : ""
        }`,
      );
      // CÓMO SE HA MOVIDO la vara. Batir un consenso que acaban de recortar
      // no es lo mismo que batir el de hace un mes, y hasta el 2026-08-07 no
      // había forma de saberlo: `earnings_events` sólo guarda el vigente.
      // El delta lo calcula el CÓDIGO y se manda ya escrito — regla dura del
      // proyecto: si el número sale en pantalla, no lo hace el modelo.
      const tr = f.consensusTrend;
      if (tr) {
        const moves: string[] = [];
        if (tr.epsThen !== null && f.nextEarningsEps !== null && tr.epsThen !== 0) {
          const d = ((f.nextEarningsEps - tr.epsThen) / Math.abs(tr.epsThen)) * 100;
          moves.push(
            `EPS ${tr.epsThen} → ${f.nextEarningsEps} (${d >= 0 ? "+" : ""}${d.toFixed(1)}%)`,
          );
        }
        if (
          tr.revenueThen !== null &&
          f.nextEarningsRevenue !== null &&
          tr.revenueThen !== 0
        ) {
          const d = ((f.nextEarningsRevenue - tr.revenueThen) / Math.abs(tr.revenueThen)) * 100;
          moves.push(
            `revenue ${fmtBillions(tr.revenueThen)} → ${fmtBillions(f.nextEarningsRevenue)} (${d >= 0 ? "+" : ""}${d.toFixed(1)}%)`,
          );
        }
        if (moves.length) {
          bits.push(
            `CONSENSUS REVISION over the last ${tr.daysAgo}d (precomputed — quote verbatim): ${moves.join("; ")}`,
          );
        }
      }
    }
    // ¿Bate esta empresa sistemáticamente? Un trimestre suelto no lo dice, y
    // es literalmente la pregunta que hace quien pregunta por una previa. El
    // recuento va hecho desde código; el modelo sólo lo lee.
    const sh = f.surpriseHistory.filter((h) => h.revenuePct !== null || h.epsPct !== null);
    if (sh.length) {
      const beats = sh.filter((h) => (h.epsPct ?? h.revenuePct ?? 0) > 0).length;
      const quarters = sh
        .map((h) => {
          const parts: string[] = [];
          if (h.revenuePct !== null) parts.push(`revenue ${h.revenuePct >= 0 ? "+" : ""}${h.revenuePct.toFixed(1)}%`);
          if (h.epsPct !== null) parts.push(`EPS ${h.epsPct >= 0 ? "+" : ""}${h.epsPct.toFixed(1)}%`);
          return `${h.reportDate ?? h.filingDate} ${parts.join(" / ")}`;
        })
        .join(" · ");
      bits.push(
        `SURPRISE HISTORY vs consensus (precomputed, ${beats} of ${sh.length} quarters above): ${quarters}`,
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
  // La sorpresa llega YA CALCULADA por `surprisePct` (código, no modelo) y
  // con su base contable. Cuando falta —porque el comunicado no declaró la
  // base, o porque las escalas no cuadraban— se dan las dos cifras crudas y
  // se prohíbe expresamente restarlas: el hueco es deliberado, no un olvido.
  for (const s of e.surprises) {
    const sign = s.pct >= 0 ? "beat" : "miss";
    out.push(
      `    ${s.metric.toUpperCase()} VS CONSENSUS (precomputed — quote this figure verbatim, never recompute it): ` +
        `reported ${s.actual.toLocaleString("en-US")} on a ${s.basis} basis vs consensus ${s.estimate.toLocaleString("en-US")} ` +
        `= ${sign} of ${Math.abs(s.pct).toFixed(1)}%`,
    );
  }
  const done = new Set(e.surprises.map((s) => s.metric));
  const est: string[] = [];
  if (e.epsEstimate !== null && !done.has("eps")) est.push(`EPS ${e.epsEstimate}`);
  if (e.revenueEstimate !== null && !done.has("revenue")) {
    est.push(`revenue $${e.revenueEstimate.toLocaleString("en-US")}`);
  }
  if (est.length) {
    out.push(
      `    CONSENSUS WITH NO COMPARABLE REPORTED FIGURE: ${est.join(", ")} — quote it next to whatever the release printed, and do NOT compute any difference: the reported figure's accounting basis is unknown, so a percentage would be unsound.`,
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
export type AnswerShape = "decision" | "preview" | "sections" | "prose";

export function answerShape(r: Retrieval): AnswerShape {
  // La intención MANDA sobre el material. Una pregunta de decisión con
  // poco archivo sigue queriendo la forma de decisión: la respuesta será
  // "no da para inclinarse, esto es lo que falta", que responde. Caer a
  // prosa aquí devolvía el párrafo genérico que abrió esta sesión.
  if (r.intent === "decision") return "decision";
  // Misma regla para la previa, y por el mismo motivo medido: con poco
  // archivo la respuesta correcta sigue siendo "ésta es la vara, esto es lo
  // que el archivo NO tiene", no una crónica de las últimas noticias.
  if (r.intent === "preview") return "preview";
  if (r.earnings.length > 0) return "sections";
  if (r.citations.length >= 6 && r.bodiesAvailable >= 2) return "sections";
  return "prose";
}

/** Techo de salida por forma. En prosa el prompt pide 2-6 frases y el cap
 *  nunca se roza (medido: ~90 tokens); en secciones sí hace falta sitio. */
const MAX_TOKENS: Record<AnswerShape, number> = {
  sections: 1600,
  // 1400 → 1800 el 2026-07-31: la sección "add" es la sexta y la postura
  // pasó de 1 frase a 2-3. Con 1400 la salida se truncaba a media frase en
  // "decides" (visto en la prueba real de SOFI: "…mercado (bmo), con una
  // vara a b").
  decision: 1800,
  // Seis epígrafes como la decisión, y con el mismo margen: la previa lleva
  // cifras copiadas literalmente (consenso, revisión, historial trimestre a
  // trimestre) que ocupan más que la prosa equivalente.
  preview: 1800,
  prose: 700,
};

const SECTION_KEYS = [
  "numbers", "reading", "overlooked", "watch",
  "stance", "add", "hold", "trim", "decides", "unknown",
  "bar", "record", "since", "position",
];

/** Las de decisión, en el orden en que se leen. Se usa para reordenar la
 *  salida: un modelo de la cola de la cadena devuelve las secciones en el
 *  orden que le apetece y "LO QUE NO SÉ" abriendo la respuesta cambia por
 *  completo lo que el lector entiende. */
const DECISION_ORDER = ["stance", "add", "hold", "trim", "decides", "unknown"];

/** Las de la previa. Mismo motivo que arriba: un modelo de la cola de la
 *  cadena devuelve las claves como le sale, y una previa que abre por "LO QUE
 *  NO SÉ" y esconde la vara al final se lee como una evasiva. */
const PREVIEW_ORDER = ["bar", "record", "since", "position", "watch", "unknown"];

const ORDER_BY_SHAPE: Partial<Record<AnswerShape, string[]>> = {
  decision: DECISION_ORDER,
  preview: PREVIEW_ORDER,
};

const SYSTEM_BY_SHAPE: Record<AnswerShape, string> = {
  sections: ASK_SECTIONS_PROMPT,
  decision: ASK_DECISION_PROMPT,
  preview: ASK_PREVIEW_PROMPT,
  prose: ASK_PROSE_PROMPT,
};

/**
 * El bloque que hace que la respuesta sea SOBRE SU DINERO.
 *
 * Va el PRIMERO del prompt a propósito: un modelo pondera lo que lee antes,
 * y con las noticias arriba la respuesta vuelve a ser una crónica del valor
 * con un "por tanto" pegado al final. Aquí lo primero que se lee es cuánto
 * hay en juego.
 */
function formatDecision(d: DecisionFacts, ledger: ForwardItem[]): string {
  const out: string[] = [];

  const lines = d.contexts.map((c: PositionContext) => {
    if (!c.held) return `- ${c.symbol}: SIN POSICIÓN REGISTRADA (está en seguimiento, no en cartera)`;
    const bits: string[] = [];
    if (c.weightPct !== null) bits.push(`peso ${c.weightPct.toFixed(1)}% de la cartera`);
    if (c.marketValue !== null) bits.push(`valor ${Math.round(c.marketValue).toLocaleString("es-ES")}$`);
    if (c.unrealizedPct !== null) {
      bits.push(
        `P&L no realizado ${c.unrealizedPct >= 0 ? "+" : ""}${c.unrealizedPct.toFixed(1)}%` +
          (c.unrealizedAbs !== null ? ` (${Math.round(c.unrealizedAbs).toLocaleString("es-ES")}$)` : ""),
      );
    }
    if (c.avgCost !== null) bits.push(`coste medio ${c.avgCost}$`);
    if (c.price !== null) bits.push(`precio ${c.price}$`);
    return `- ${c.symbol}: ${bits.join(" · ")}`;
  });
  const ctx = d.contexts[0];
  out.push(
    `YOUR POSITION (precomputed — quote verbatim, never recompute):\n${lines.join("\n")}` +
      (ctx
        ? `\n(cartera total ${Math.round(ctx.portfolioValue).toLocaleString("es-ES")}$ en ${ctx.positionCount} posiciones valorables)`
        : ""),
  );

  const bySide = (side: "add" | "hold" | "trim" | "neutral") =>
    d.pressures.filter((p) => p.side === side).map((p) => `- ${p.symbol}: ${p.text}`);
  const add = bySide("add");
  const hold = bySide("hold");
  const trim = bySide("trim");
  const neutral = bySide("neutral");
  const blocks: string[] = [];
  if (add.length) blocks.push(`PUSHES TOWARDS ADDING:\n${add.join("\n")}`);
  if (hold.length) blocks.push(`PUSHES TOWARDS HOLDING:\n${hold.join("\n")}`);
  if (trim.length) blocks.push(`PUSHES TOWARDS TRIMMING:\n${trim.join("\n")}`);
  if (neutral.length) blocks.push(`MATTERS BUT PICKS NO SIDE:\n${neutral.join("\n")}`);
  if (blocks.length) {
    out.push(
      `PRESSURES (hard facts, side already assigned by code — do not reassign):\n${blocks.join("\n")}`,
    );
  } else {
    // Decirlo explícitamente es la mitad del valor: sin esta línea el
    // modelo rellena el hueco con generalidades bien escritas.
    out.push(
      "PRESSURES: NONE. No filings, no calendar entry and no portfolio threshold pushes either way. Say so in the stance instead of inventing a lean.",
    );
  }

  if (d.dated.length) {
    out.push(
      `DATED (already published or already committed — this is all the future Catalyst can honestly claim):\n${d.dated
        .map((x) => `- ${x.date ?? "sin fecha"} · ${x.symbol}: ${x.text}`)
        .join("\n")}`,
    );
  } else {
    out.push("DATED: NOTHING SCHEDULED in the archive for these symbols.");
  }

  // El libro de futuros va aquí, DELANTE de las noticias. Es lo único de
  // todo el prompt que el usuario no puede ver en su bróker, y un modelo
  // pondera lo que lee antes: con las noticias primero, la sección "lo que
  // lo decide" volvía a ser una fecha de resultados y poco más.
  if (ledger.length) {
    const lines = ledger.map((i) => {
      const bits = [`${i.symbol} · ${i.event}`];
      if (i.when) bits.push(`plazo: ${i.when}`);
      if (i.whenDate) bits.push(`fecha: ${i.whenDate}`);
      if (i.condition) bits.push(`condición: ${i.condition}`);
      return `- [${i.source}] ${bits.join(" · ")}`;
    });
    out.push(
      `FORWARD LEDGER (unresolved commitments extracted from the article bodies — this is the part he cannot see in his broker):\n${lines.join("\n")}`,
    );
  } else {
    out.push(
      "FORWARD LEDGER: EMPTY. No article body in the archive contains an unresolved commitment for these symbols. Say so plainly in \"decides\" instead of padding it with generalities.",
    );
  }

  return out.join("\n\n");
}

/**
 * Lo que YA ESTÁ FIJADO alrededor de un trimestre que aún no ha salido.
 *
 * Es el mismo material que `formatDecision` mete en el prompt de una
 * decisión, pero sin el encuadre de la cartera: aquí no se pregunta por el
 * dinero del lector, se pregunta por la empresa. Sale de `r.forward`, que
 * hasta el 2026-08-07 sólo se rellenaba en decisiones — y era la razón
 * mecánica de que una previa no pudiera hablar ni de papel comprometido ni
 * de apuesta contraria acumulada.
 *
 * Ninguno de estos datos es un precio ni una opinión: los declaró alguien
 * ante la SEC o FINRA, o son un calendario.
 */
function formatPreviewFacts(r: Retrieval): string {
  const out: string[] = [];

  if (r.forward.sellers.length) {
    const lines = r.forward.sellers.map((s) => {
      const left =
        s.sharesAfter != null
          ? `, ${Math.round(s.sharesAfter).toLocaleString("en-US")} shares still declared`
          : "";
      return `- ${s.symbol}: ${s.owner}${s.title ? ` (${s.title})` : ""} — ${s.sales} sales between ${s.firstSale} and ${s.lastSale}${left}`;
    });
    out.push(
      `SCHEDULED INSIDER SELLING (a repeated pattern over 90d is a plan in progress; what is left is future supply already known):\n${lines.join("\n")}`,
    );
  }

  const risk = r.forward.risk.filter(
    (x) => x.daysToCover !== null || x.beta !== null || x.pe !== null,
  );
  if (risk.length) {
    const lines = risk.map((x) => {
      const bits: string[] = [];
      if (x.daysToCover !== null) {
        // La derivada sólo se enuncia cuando existe: sin la liquidación
        // anterior, "estable" sería una afirmación fabricada (misma regla
        // que fijó `shortChangePct` el 2026-07-31).
        bits.push(
          `days-to-cover ${x.daysToCover.toFixed(1)}` +
            (x.shortChangePct !== null
              ? ` (${x.shortChangePct >= 0 ? "+" : ""}${x.shortChangePct.toFixed(1)}% vs the previous FINRA settlement)`
              : ""),
        );
      }
      if (x.beta !== null) bits.push(`beta ${x.beta.toFixed(2)}`);
      if (x.pe !== null) bits.push(`P/E ${x.pe.toFixed(1)}`);
      return `- ${x.symbol}: ${bits.join(" · ")}`;
    });
    out.push(`STRUCTURAL RISK (does not move with the day's news):\n${lines.join("\n")}`);
  }

  if (r.forward.deals.length) {
    const lines = r.forward.deals.map(
      (d) => `- ${d.symbol}: ${d.headline} (${d.publishedAt.slice(0, 10)})`,
    );
    out.push(
      `OPEN CORPORATE ACTIONS announced and NOT verified as still open — treat as a thread to pull, not as a fact:\n${lines.join("\n")}`,
    );
  }

  if (!out.length) {
    // Decirlo es media respuesta. Sin esta línea el modelo rellena el hueco
    // con generalidades bien escritas, que es el fallo que abrió la sesión.
    return "WHAT IS ALREADY SET: NOTHING. No disclosed future supply, no open corporate action and no short-interest reading for these symbols. Say so in the relevant section instead of inventing positioning.";
  }
  return `WHAT IS ALREADY SET (declared to a regulator or already on a calendar):\n\n${out.join("\n\n")}`;
}

export type AskOptions = {
  /** Hechos de decisión ya calculados. Sólo llega en preguntas de decisión;
   *  es lo que convierte "MSFT en general" en "tu 34% de MSFT". */
  decision?: DecisionFacts;
  /** Compromisos sin resolver extraídos en la PRIMERA llamada. Si aquélla
   *  falló llega vacío y esto sigue: la respuesta pierde profundidad en
   *  "lo que lo decide" pero conserva todo lo estructural. */
  ledger?: ForwardItem[];
  /** Qué decisión se pregunta: entrar dinero o sacarlo. Obliga al veredicto
   *  a responder ESA pregunta — "¿compro?" contestado con aguantar/recortar
   *  es responder a una pregunta que nadie hizo (medido 2026-07-31). */
  focus?: "entry" | "exit" | "general";
  /** Turnos anteriores de ESTA conversación ("¿y si quito NVDA?" tras una
   *  revisión). Contexto para entender el seguimiento, nunca fuente: los
   *  hechos siguen saliendo del material de este turno. */
  history?: AskTurn[];
};

export type AskTurn = { question: string; answer: string };

/** La línea que ata el veredicto a la pregunta. Va en el bloque de usuario,
 *  justo bajo la QUESTION, porque es una instrucción sobre ESTA pregunta y
 *  no una regla general del papel. */
function focusLine(focus: AskOptions["focus"]): string {
  if (focus === "entry") {
    return (
      "QUESTION TYPE: he is asking whether to PUT NEW MONEY IN (buy / add / enter). " +
      "Your verdict must answer THAT question: AMPLIAR or ENTRAR if the case carries it, " +
      "or an explicit no-compres with the reason and what would change it. " +
      "Do NOT reframe it as hold-versus-trim — AGUANTAR only answers him if you " +
      "explicitly say why you would not add at this point."
    );
  }
  if (focus === "exit") {
    return (
      "QUESTION TYPE: he is asking whether to TAKE MONEY OUT (sell / trim / exit). " +
      "Your verdict must answer THAT question: RECORTAR or SALIR if the case carries it, " +
      "or an explicit no-vendas with the reason and what would change it."
    );
  }
  return "";
}

/**
 * El mensaje de usuario EXACTO que recibe el redactor, y la forma elegida.
 *
 * Extraído de `askArchive` (2026-08-07) para que exista UNA sola definición
 * del prompt y se pueda AUDITAR sin gastar una llamada: `scripts/probe-ask.ts`
 * lo imprime tal cual. La razón es la de siempre en este proyecto — la queja
 * "responde genérico" se diagnosticó reconstruyendo el bloque a mano, y una
 * reconstrucción a mano puede mentir justo donde importa. Si el probe y la
 * ruta no comparten el código, el probe mide otra cosa.
 */
export async function buildAskUserBlock(
  r: Retrieval,
  question: string,
  opts: AskOptions = {},
): Promise<{ shape: AnswerShape; system: string; userBlock: string }> {
  const { decision, ledger = [], focus = "general", history = [] } = opts;
  const shape = answerShape(r);

  // El track record del PROPIO Catalyst entra como CALIBRACIÓN de cuánto
  // exigir, no como dato a citar: si los upgrades de analista no han batido
  // a SPY, una postura que se sostiene sólo en un upgrade debe salir más
  // floja. El helper ya exige n>=20 y prohíbe citar las cifras. Es el mismo
  // uso que hace la revisión de cartera; el Lab estaba midiendo desde julio
  // y esta superficie no lo leía. Si falla, la respuesta sale sin ellos.
  const priors =
    shape === "decision" ? await getEmpiricalPriors().catch(() => null) : null;

  // La conversación previa entra como CONTEXTO, delante de la pregunta y
  // con la regla explícita de que no es fuente: el material de ESTE turno
  // manda. Sin este bloque, "¿y a largo plazo?" no tiene referente; con él
  // sin la regla, el modelo recicla cifras de una respuesta que ya caducó.
  const historyBlock = history.length
    ? [
        "CONVERSATION SO FAR — context to understand the follow-up ONLY. Every fact and number in your answer must come from the material BELOW; if an earlier answer conflicts with today's material, today's material wins:",
        ...history.map((t) => `Q: ${t.question}\nA: ${t.answer}`),
      ].join("\n")
    : "";

  const userBlock = [
    historyBlock,
    `QUESTION: ${question}`,
    shape === "decision" ? focusLine(focus) : "",
    "",
    shape === "decision" && decision ? formatDecision(decision, ledger) : "",
    // En la previa el bloque de lo ya fijado va DELANTE de las noticias, por
    // lo mismo que el libro de futuros en una decisión: un modelo pondera lo
    // que lee antes, y con las noticias primero la previa vuelve a ser una
    // crónica del mes con la fecha de resultados pegada al final.
    shape === "preview" ? formatPreviewFacts(r) : "",
    "",
    shape === "decision" || shape === "preview"
      ? "ARCHIVE ITEMS (support material to cite — do NOT summarise them):"
      : "ARCHIVE ITEMS:",
    formatItems(r.citations, r.earnings),
    "",
    formatFacts(r.facts),
    priors ?? "",
  ]
    .filter(Boolean)
    .join("\n");

  return { shape, system: SYSTEM_BY_SHAPE[shape], userBlock };
}

export async function askArchive(
  r: Retrieval,
  question: string,
  opts: AskOptions = {},
): Promise<AskAnswer> {
  const { decision, ledger = [] } = opts;
  // Una pregunta de decisión con evidencia dura propia (peso, insiders,
  // una fecha de resultados) merece respuesta aunque el archivo de noticias
  // venga flojo: la mitad de la respuesta no sale de las noticias.
  const decisionBacked = Boolean(decision && hasDecisionEvidence(decision));
  if (!hasCoverage(r) && !decisionBacked) {
    return {
      answer: "",
      sections: [],
      citations: [],
      coverage: "none",
      model: "none",
    };
  }

  const { shape, system, userBlock } = await buildAskUserBlock(r, question, opts);

  let parsed: {
    answer?: string;
    sections?: Array<{ key?: string; title?: string; text?: string }>;
    used?: number[];
    coverage?: string;
  } = {};
  let sections: AskSection[] = [];
  let model = "none";

  // DOS intentos, no uno. Medido el 2026-07-31 con la pregunta de compra de
  // SOFI: 1 de 3 ejecuciones volvió con el JSON sin la sección "stance" —
  // una respuesta de decisión SIN postura es exactamente la queja que abrió
  // todo esto, y también cubre el JSON no parseable transitorio del modelo
  // de reserva. El reintento sólo se paga cuando el primero falla.
  //
  // El techo de salida es una VARIABLE porque el segundo intento tiene que
  // poder ser distinto del primero: si el primero llegó truncado, repetir
  // con el mismo `maxTokens` produce exactamente el mismo corte y se tira el
  // reintento. Éste es el único sitio del proyecto donde el reintento por
  // truncamiento existe — el resto de llamantes sólo lo LOGUEA (ver
  // warnIfTruncated), porque añadir bucles nuevos multiplicaría la cuota.
  let maxTokens = MAX_TOKENS[shape];
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await proseCompletion({
      messages: [
        { role: "system", content: system },
        { role: "user", content: userBlock },
      ],
      temperature: 0.2,
      maxTokens,
      tag: "ask",
      jsonMode: true,
      // Cuatro epígrafes con citas son ~1.900 chars de salida y el modelo de
      // cabeza tarda ~24s en escribirlos: con los 25s por defecto se quedaba
      // JUSTO fuera y contestaba el de reserva. Techo de pared para que un
      // modelo lento no encadene un timeout por key (ver gemini.ts).
      geminiTimeoutMs: shape === "prose" ? 25_000 : 50_000,
      geminiOverallTimeoutMs: shape === "prose" ? 45_000 : 75_000,
    });
    model = res.model;

    // Rastro del modelo que REALMENTE respondió. La cadena de fallback es
    // silenciosa por dentro (prose-chain sólo avisa al saltar de PROVEEDOR,
    // no de modelo dentro de Gemini), así que sin esta línea no hay forma de
    // auditar a posteriori por qué una respuesta salió firmada por el modelo
    // de reserva — que es justo la queja que abrió esta sesión.
    console.log(
      `[ask] model=${res.model} shape=${shape} intento=${attempt + 1} ` +
        `citas=${r.citations.length} cuerpos=${r.bodiesAvailable} ` +
        `cosecha=${r.harvested}/${r.attempted} comunicados=${r.earnings.length} ` +
        `ledger=${ledger.length} presiones=${decision?.pressures.length ?? 0}`,
    );

    // Un JSON cortado por el techo de tokens NO es un modelo que no sepa
    // emitir JSON, y hasta ahora se veían igual: los dos acababan en
    // "respuesta no parseable". Con el motivo de parada delante, el
    // reintento sube el techo en vez de repetir el mismo corte.
    const truncated = warnIfTruncated("ask", res);
    if (truncated && attempt === 0) maxTokens = Math.round(maxTokens * 1.5);

    try {
      parsed = JSON.parse(
        res.content.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, ""),
      );
    } catch {
      if (attempt === 0) {
        console.warn("[ask] JSON no parseable — reintento");
        continue;
      }
      throw new Error("ask: respuesta no parseable como JSON");
    }

    sections = normalizeSections(parsed);
    const order = ORDER_BY_SHAPE[shape];
    if (order) sections = orderDecisionSections(sections, order);
    // El reintento cubre los DOS modos de fallo del esquema, no sólo uno.
    // La guarda anterior exigía `sections.length` para reintentar por falta
    // de postura, así que una respuesta que parsea pero produce CERO
    // secciones (el modelo de reserva ignorando el esquema: `sections: []`,
    // o todos los `text` vacíos) se saltaba el reintento, salía del bucle y
    // moría abajo en "respuesta vacía o con scratchpad" — con el segundo
    // intento sin gastar y habiendo pagado ya la llamada.
    if (attempt === 0) {
      if (!sections.length) {
        console.warn("[ask] respuesta sin secciones utilizables — reintento");
        continue;
      }
      if (shape === "decision" && !sections.some((s) => s.key === "stance")) {
        console.warn("[ask] decisión sin sección de postura — reintento");
        continue;
      }
    }
    break;
  }

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

  let coverage: AskAnswer["coverage"] =
    parsed.coverage === "none" || parsed.coverage === "partial"
      ? parsed.coverage
      : "full";

  // ── El gate de la postura ────────────────────────────────────────────
  //
  // Misma doctrina que `applyEvidenceGate` en la revisión de cartera: la
  // regla editorial se COMPRUEBA, no se pide. Un modelo puede ignorar una
  // instrucción del prompt; no puede ignorar un filtro sobre su salida.
  //
  // Que se moje es lo que pidió el usuario, pero mojarse sin respaldo es
  // exactamente el fallo contrario al que abría esta sesión: pasar de una
  // respuesta genérica a una opinión con aplomo y sin nada debajo. Si no
  // hay NI cita usada NI hecho duro, la postura desaparece y quedan los
  // bloques descriptivos, que sí son verdad.
  let finalSections = sections;
  if (shape === "decision" && !cited.length && !decisionBacked) {
    finalSections = sections.filter((s) => s.key !== "stance");
    if (coverage === "full") coverage = "partial";
  }
  const finalAnswer = finalSections.map((s) => s.text).join("\n\n").trim();

  // Sin fallback a "las 3 primeras recuperadas": cuando el modelo no cita
  // nada suele ser porque no había nada que citar, y adjuntar citas que no
  // sostienen el texto fabrica respaldo justo donde la respuesta honesta
  // era "no lo sé". Mejor cero citas que citas decorativas.
  return {
    answer: finalAnswer || answer,
    sections: finalSections.length ? finalSections : sections,
    citations: cited,
    coverage,
    model,
  };
}

/**
 * Reordena las secciones de una decisión al orden canónico.
 *
 * No es cosmética: la cadena de fallback llega hasta llama-3.1-8b y los
 * modelos de la cola devuelven las claves en el orden que les sale. Una
 * respuesta que abre con "LO QUE NO SÉ" y esconde la postura al final se
 * lee como una evasiva — que es justo lo que esta forma existe para no ser.
 * Las claves desconocidas se conservan al final en vez de tirarse.
 */
export function orderDecisionSections(
  sections: AskSection[],
  order: string[] = DECISION_ORDER,
): AskSection[] {
  const rank = (k: string) => {
    const i = order.indexOf(k);
    return i === -1 ? order.length : i;
  };
  return [...sections]
    .map((s, i) => ({ s, i }))
    .sort((a, b) => rank(a.s.key) - rank(b.s.key) || a.i - b.i)
    .map((x) => x.s);
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
      const text = typeof s?.text === "string" ? cleanBrackets(s.text) : "";
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
  const answer = typeof parsed.answer === "string" ? cleanBrackets(parsed.answer) : "";
  return answer ? [{ key: "answer", title: null, text: answer }] : [];
}

/**
 * En este esquema un corchete significa UNA cosa: un número de cita. Todo
 * lo demás entre corchetes se borra.
 *
 * No es cosmética. Visto en la primera prueba real (2026-07-30): dado el
 * bloque "YOUR POSITION" y la orden de citar las cifras tal cual, el modelo
 * cerró tres de las cinco secciones pegando la línea entera entre
 * corchetes — "…del 25% [MSFT: peso 27.6% de la cartera · valor 1063$ ·
 * P&L no realizado +18.2% · coste medio 376.92$]". Se lee como una fuente
 * verificable y no lo es: es el propio prompt devuelto al lector.
 *
 * Se borra el contenido, no sólo los delimitadores: dejar el texto suelto
 * mete un volcado de datos en mitad de una frase, que es peor.
 */
export function cleanBrackets(text: string): string {
  return text
    .replace(/\[([^\]]*)\]/g, (m, inner: string) =>
      /^\s*\d+(\s*,\s*\d+)*\s*$/.test(inner) ? m : "",
    )
    // La limpieza deja dobles espacios y puntuación colgando (" ." , " ,").
    .replace(/\s+([.,;:)])/g, "$1")
    .replace(/\(\s*\)/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}
