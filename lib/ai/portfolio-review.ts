// Revisión de cartera — el modo "analista de mesa" del Ask.
//
// `lib/ai/ask.ts` es un BIBLIOTECARIO: responde preguntas sobre el archivo
// y tiene prohibido opinar. Este módulo es lo contrario por diseño, y por
// eso vive aparte en vez de como un flag del otro: mezclar los dos
// registros en un prompt acabaría diluyendo la regla que hace útil al
// primero ("no rellenes con tu conocimiento").
//
// Lo que NO cambia entre los dos, y es la columna vertebral de ambos: cada
// afirmación tiene que apoyarse en una cita del archivo o en un agregado
// SQL. Aquí esa regla no se le pide al modelo — se COMPRUEBA en código
// (`applyEvidenceGate`). Un modelo puede ignorar una instrucción del
// prompt; no puede ignorar un filtro que se ejecuta sobre su salida.

import { proseCompletion } from "@/lib/ai/prose-chain";
import { looksLikeScratchpad } from "@/lib/ai/guards";
import { getEmpiricalPriors } from "@/lib/signals/priors";
import type { PortfolioRetrieval, PositionFacts } from "@/lib/ask/portfolio";
import type { PricedPosition } from "@/lib/portfolio";

/** Postura sobre una posición. Tokens estables en inglés: la traducción
 *  vive en la UI, así el prompt no cambia si mañana se pinta en otro
 *  idioma. `none` NO lo produce el modelo — lo pone el gate de evidencia. */
export type Stance = "add" | "hold" | "watch" | "review" | "none";

export type PositionVerdict = {
  symbol: string;
  stance: Stance;
  why: string;
  used: number[];
  /** true si el gate degradó la postura por falta de respaldo. */
  degraded?: boolean;
};

export type PortfolioReview = {
  verdict: string;
  positions: PositionVerdict[];
  watchNext: string[];
  model: string;
};

const SYSTEM_PROMPT = `Eres un analista de mesa revisando la cartera de un inversor particular. No eres un asesor: eres quien le pone delante lo que los datos dicen de cada posición, incluido lo que no le va a gustar.

Recibes: (a) la CARTERA con pesos, coste y P&L; (b) HECHOS por posición calculados por SQL sobre datos regulatorios (insiders, 13D/G, resultados, short interest, cobertura y sentimiento); (c) NOTICIAS numeradas del archivo; (d) el CALENDARIO de catalizadores ya conocidos.

Devuelve SOLO un objeto JSON:
{"verdict": "...", "positions": [{"symbol": "AAA", "stance": "add|hold|watch|review", "why": "...", "used": [1,4]}], "watchNext": ["...", "..."]}

Reglas:
- "verdict": 2-4 frases sobre la CARTERA COMO CONJUNTO, no sobre valores sueltos. Concentración, exposición a un mismo catalizador, sesgo sectorial, cuántas posiciones dependen de la misma semana de resultados. Es lo primero que se lee: que diga lo más importante, no un resumen genérico.
- NO HAGAS ARITMÉTICA. No sumes pesos, no promedies betas, no calcules porcentajes agregados. Todos los agregados que necesitas ya vienen calculados en el bloque AGREGADOS. Si un número que quieres decir no está escrito literalmente en la entrada, no lo digas.
- "positions": una entrada por posición sobre la que tengas algo QUE DECIR. No inventes una para cada símbolo — omitir es correcto y preferible a rellenar.
- "stance": add = los datos apoyan reforzar · hold = la tesis sigue intacta · watch = hay algo que vigilar de cerca · review = hay evidencia que contradice la tesis y merece revisarse.
- "why": UNA frase, concreta, con el dato dentro. "Insiders vendieron 2,1M$ netos en 30d con el sentimiento plano" sirve; "el momentum parece débil" no sirve.
- "used": los números de las noticias que sostienen ese "why". Si el "why" sale solo de los HECHOS calculados, deja [] — pero entonces el dato exacto TIENE que aparecer en la frase.
- "watchNext": 2-5 puntos sobre lo que viene, SIEMPRE anclados en el calendario o en procesos ya abiertos (resultados con fecha, señales sin madurar, un 13D reciente que puede escalar). PROHIBIDO predecir precios o direcciones. "MSFT y META reportan el mismo día: dos de tus mayores pesos se juegan a la vez" es válido; "espero que NVDA suba" no lo es.
- NUNCA uses tu propio conocimiento sobre estas empresas. Tus datos de entrenamiento están caducados y el usuario no puede distinguirlo. Si una posición no tiene material, no la incluyas.
- Si un valor aparece marcado como SIN COBERTURA, puedes mencionarlo en el veredicto como punto ciego, pero no le pongas postura.
- Español. Registro de mesa: concreto, sin coletillas, sin descargos de responsabilidad, sin "como IA".`;

function fmtMoney(n: number): string {
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (abs >= 1e9) return `${sign}${(abs / 1e9).toFixed(1)}B$`;
  if (abs >= 1e6) return `${sign}${(abs / 1e6).toFixed(1)}M$`;
  if (abs >= 1e3) return `${sign}${(abs / 1e3).toFixed(0)}k$`;
  return `${sign}${abs.toFixed(0)}$`;
}

function pct(n: number): string {
  return `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`;
}

function formatPortfolio(r: PortfolioRetrieval): string {
  const p = r.portfolio;
  const head: string[] = [
    `CARTERA — ${p.positions.length} posiciones, valor ${fmtMoney(p.totalValue)}`,
  ];
  if (p.totalUnrealizedPct !== null) {
    head.push(
      `P&L no realizado ${pct(p.totalUnrealizedPct)} (${fmtMoney(p.totalUnrealizedAbs ?? 0)})`,
    );
  }
  if (p.dayChangePct !== null) head.push(`hoy ${pct(p.dayChangePct)}`);

  const lines = p.positions.map((pos: PricedPosition) => {
    const bits = [`${pos.symbol}: peso ${pos.weightPct?.toFixed(1) ?? "?"}%`];
    if (pos.unrealizedPct !== null) bits.push(`P&L ${pct(pos.unrealizedPct)}`);
    if (pos.dayChangePct !== null) bits.push(`hoy ${pct(pos.dayChangePct)}`);
    if (pos.sector) bits.push(pos.sector);
    return `- ${bits.join(" · ")}`;
  });

  const sectors = p.sectors
    .map((s) => `${s.sector} ${s.weightPct.toFixed(0)}%`)
    .join(" · ");

  const out = [head.join(" · "), ...lines, `SECTORES: ${sectors}`];

  // Las advertencias de calidad del dato van DENTRO del prompt, no sólo en
  // la UI: si 3 de 10 posiciones no se pudieron valorar, el modelo tiene
  // que saber que los pesos que está leyendo son parciales antes de
  // afirmar nada sobre concentración.
  if (p.unpricedSymbols.length) {
    out.push(
      `AVISO: sin precio para ${p.unpricedSymbols.join(", ")} — quedan fuera de los pesos.`,
    );
  }
  if (p.noCostSymbols.length) {
    out.push(
      `AVISO: sin coste registrado en ${p.noCostSymbols.join(", ")} — esas posiciones no tienen P&L.`,
    );
  }
  if (r.concentration.length) {
    out.push(
      `CONCENTRACIÓN: ${r.concentration.map((c) => `${c.label} ${c.weightPct.toFixed(0)}%`).join(" · ")}`,
    );
  }
  if (r.blindSpots.length) {
    out.push(
      `SIN COBERTURA en el archivo (punto ciego): ${r.blindSpots.join(", ")}`,
    );
  }

  // Los agregados van con su propio encabezado y en cifras ya cerradas
  // justamente para que el modelo no tenga NINGÚN motivo para multiplicar
  // nada por su cuenta.
  const agg: string[] = [];
  if (r.derived.weightedBeta !== null) {
    agg.push(
      `- Beta de la cartera ponderada por peso: ${r.derived.weightedBeta.toFixed(2)} (calculada sobre el ${r.derived.betaCoveragePct.toFixed(0)}% del peso, el resto no tiene beta conocida)`,
    );
  }
  for (const c of r.derived.earningsClusters) {
    agg.push(
      `- ${c.date}: reportan ${c.symbols.join(", ")} — ${c.weightPct.toFixed(1)}% de la cartera en esa sesión`,
    );
  }
  if (agg.length) {
    out.push(
      `AGREGADOS (ya calculados — úsalos tal cual, no recalcules):\n${agg.join("\n")}`,
    );
  }
  return out.join("\n");
}

function formatFacts(facts: PositionFacts[]): string {
  const lines = facts.map((f) => {
    const bits: string[] = [];
    bits.push(`${f.news7d} noticias 7d (previos 7d: ${f.newsPrior7d})`);
    if (f.avgSentiment7d !== null) {
      const prior =
        f.avgSentimentPrior7d !== null
          ? ` desde ${f.avgSentimentPrior7d.toFixed(2)}`
          : "";
      bits.push(`sentimiento ${f.avgSentiment7d.toFixed(2)}${prior} (escala -5..+5)`);
    }
    if (f.insiderNet7d) bits.push(`insiders neto 7d ${fmtMoney(f.insiderNet7d)}`);
    if (f.insiderNet30d) {
      bits.push(
        `insiders neto 30d ${fmtMoney(f.insiderNet30d)} (${f.insiderBuyers30d} compradores / ${f.insiderSellers30d} vendedores, solo mercado abierto)`,
      );
    }
    for (const s of f.stakes) {
      bits.push(
        `13D/G de ${s.filer ?? "declarante no identificado"}${s.pct !== null ? ` ${s.pct}%` : ""} el ${s.filedAt}`,
      );
    }
    if (f.nextEarnings) {
      bits.push(`resultados ${f.nextEarnings}${f.earningsHour ? ` (${f.earningsHour})` : ""}`);
    }
    for (const s of f.signals) {
      bits.push(
        `señal ${s.label} el ${s.detectedAt}${s.matured ? "" : " (sin medir aún)"}`,
      );
    }
    if (f.daysToCover !== null) bits.push(`days-to-cover ${f.daysToCover.toFixed(1)}`);
    if (f.beta !== null) bits.push(`beta ${f.beta.toFixed(2)}`);
    if (f.pe !== null) bits.push(`PER ${f.pe.toFixed(1)}`);
    if (f.citationNums.length) bits.push(`noticias [${f.citationNums.join(",")}]`);
    return `- ${f.symbol}: ${bits.join(" · ")}`;
  });
  return `HECHOS CALCULADOS (exactos, de datos regulatorios — cualquier número sale de aquí):\n${lines.join("\n")}`;
}

function formatCitations(r: PortfolioRetrieval): string {
  return r.citations
    .map((c) => {
      const head = `[${c.n}] ${c.publishedAt.slice(0, 10)} [${c.symbols.join(",")}] ${c.headline}${c.summary ? ` — ${c.summary}` : ""} (${c.source})`;
      return c.body ? `${head}\n    CONTENIDO: ${c.body}` : head;
    })
    .join("\n");
}

function formatCalendar(r: PortfolioRetrieval): string {
  if (!r.calendar.length) return "";
  const lines = r.calendar
    .slice(0, 25)
    .map((c) => `- ${c.date ?? "sin fecha"} · ${c.symbol}: ${c.what}`);
  return `CALENDARIO DE CATALIZADORES CONOCIDOS (hechos ya publicados o procesos abiertos — no hay ninguna predicción aquí):\n${lines.join("\n")}`;
}

/**
 * ¿Tiene esta posición algún hecho duro que pueda sostener una postura por
 * sí solo, sin citar noticia?
 *
 * Deliberadamente NO cuenta como evidencia el volumen de cobertura ni el
 * sentimiento medio: son agregados blandos con los que se puede justificar
 * cualquier cosa ("mucha atención mediática", "sentimiento tibio"). Sí
 * cuenta un dato que alguien tuvo que declarar ante la SEC o una fecha ya
 * publicada.
 */
function hasHardEvidence(f: PositionFacts | undefined): boolean {
  if (!f) return false;
  return Boolean(
    f.insiderNet7d ||
      f.insiderNet30d ||
      f.stakes.length ||
      f.signals.length ||
      f.nextEarnings ||
      (f.daysToCover !== null && f.daysToCover >= 5),
  );
}

/**
 * El gate. Convierte la regla editorial en una comprobación ejecutable.
 *
 * Tres cosas, en este orden:
 *   1. Descarta posturas sobre símbolos que no están en la cartera (el
 *      modelo alucinando un ticker de su memoria — pasa).
 *   2. Limpia `used` de números que no existen entre las citas recuperadas.
 *   3. Si tras limpiar no queda NI cita NI hecho duro, la postura se
 *      degrada a "none" y se marca `degraded`. No se borra la entrada: que
 *      el modelo quisiera decir algo sin respaldo es información, y la UI
 *      la pinta como "sin evidencia suficiente" en vez de ocultarla.
 */
export function applyEvidenceGate(
  positions: PositionVerdict[],
  r: PortfolioRetrieval,
): PositionVerdict[] {
  const inPortfolio = new Set(r.portfolio.positions.map((p) => p.symbol));
  const validNums = new Set(r.citations.map((c) => c.n));
  const factsBySymbol = new Map(r.facts.map((f) => [f.symbol, f]));

  return positions
    .filter((p) => inPortfolio.has(p.symbol))
    .map((p) => {
      const used = (p.used ?? []).filter((n) => validNums.has(n));
      const backed = used.length > 0 || hasHardEvidence(factsBySymbol.get(p.symbol));
      if (backed) return { ...p, used };
      return { ...p, used, stance: "none" as Stance, degraded: true };
    });
}

const STANCES = new Set<Stance>(["add", "hold", "watch", "review"]);

export async function reviewPortfolio(
  r: PortfolioRetrieval,
): Promise<PortfolioReview> {
  if (!r.portfolio.positions.length) {
    return { verdict: "", positions: [], watchNext: [], model: "none" };
  }

  // Los priors del Lab entran como CALIBRACIÓN, no como dato a citar: si
  // los upgrades de analista no han batido a SPY, el modelo debe ser más
  // duro con una posición que sólo se sostiene en un upgrade. El propio
  // helper ya prohíbe citarlos y exige n>=20.
  const priors = await getEmpiricalPriors().catch(() => null);

  const userBlock = [
    formatPortfolio(r),
    "",
    formatFacts(r.facts),
    "",
    "NOTICIAS DEL ARCHIVO:",
    formatCitations(r),
    "",
    formatCalendar(r),
    priors ?? "",
  ]
    .filter(Boolean)
    .join("\n");

  const res = await proseCompletion({
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userBlock },
    ],
    temperature: 0.3,
    maxTokens: 1800,
    tag: "portfolio",
    jsonMode: true,
  });

  let parsed: {
    verdict?: string;
    positions?: Array<{ symbol?: string; stance?: string; why?: string; used?: number[] }>;
    watchNext?: string[];
  };
  try {
    parsed = JSON.parse(
      res.content.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, ""),
    );
  } catch {
    throw new Error("portfolio-review: respuesta no parseable como JSON");
  }

  const verdict = (parsed.verdict ?? "").trim();
  if (!verdict || looksLikeScratchpad(verdict)) {
    throw new Error("portfolio-review: veredicto vacío o con scratchpad");
  }

  const raw: PositionVerdict[] = (parsed.positions ?? [])
    .filter((p) => typeof p.symbol === "string" && typeof p.why === "string")
    .map((p) => ({
      symbol: (p.symbol as string).toUpperCase(),
      stance: STANCES.has(p.stance as Stance) ? (p.stance as Stance) : "watch",
      why: (p.why as string).trim(),
      used: Array.isArray(p.used) ? p.used.filter(Number.isInteger) : [],
    }))
    .filter((p) => p.why.length > 0);

  const watchNext = (parsed.watchNext ?? [])
    .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
    .map((s) => s.trim())
    .slice(0, 6);

  return {
    verdict,
    positions: applyEvidenceGate(raw, r),
    watchNext,
    model: res.model,
  };
}
