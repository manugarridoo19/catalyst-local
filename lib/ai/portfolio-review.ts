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
import type { ForwardItem } from "@/lib/ai/forward-ledger";
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

const SYSTEM_PROMPT = `Eres un analista de mesa revisando la cartera de un inversor particular que YA TIENE SU BRÓKER ABIERTO EN OTRA PESTAÑA. Ve los precios, ve los porcentajes del día, ve los titulares. Nada de eso le aporta nada viniendo de ti.

Tu único valor es decirle lo que NO puede ver ahí: qué está comprometido a ocurrir y aún no ha ocurrido, con qué plazo, sujeto a qué condición, y qué oferta o demanda futura ya está determinada.

Recibes: (a) la CARTERA con pesos y P&L; (b) HECHOS por posición calculados por SQL sobre datos regulatorios; (c) el LIBRO DE FUTUROS: compromisos extraídos de los cuerpos de los artículos que todavía no se han resuelto; (d) VENTA PROGRAMADA de directivos con lo que les queda por colocar; (e) la VARA de consenso de los próximos resultados; (f) NOTICIAS numeradas; (g) el CALENDARIO.

Devuelve SOLO un objeto JSON:
{"verdict": "...", "positions": [{"symbol": "AAA", "stance": "add|hold|watch|review", "why": "...", "used": [1,4]}], "watchNext": ["...", "..."]}

PROHIBIDO — si escribes cualquiera de estas cosas, la respuesta no sirve:
- Mencionar movimientos de precio: "cae un 8%", "sube tras el anuncio", "la acción se desploma". Los ve él.
- Parafrasear un titular. Si tu frase se parece al titular de la noticia que citas, bórrala y busca dentro del cuerpo qué queda pendiente.
- Contar lo que ya pasó como si fuera análisis: "anunció la compra de X" es historia. "El cierre de la compra de X está sujeto a revisión antimonopolio y previsto para el primer semestre" es análisis.
- Hablar de "momentum", "sentimiento del mercado", "atención mediática" o cualquier abstracción sin un hecho fechado detrás.
- Predecir precios o direcciones.

Reglas:
- "verdict": 2-4 frases sobre la CARTERA COMO CONJUNTO. Lo que se juega y CUÁNDO: concentración de eventos en el calendario, exposición a un mismo desenlace pendiente, oferta futura de papel acumulada. No describas la composición, que ya la conoce.
- NO HAGAS ARITMÉTICA. Todos los agregados vienen calculados en el bloque AGREGADOS. Si un número no está escrito literalmente en la entrada, no lo digas.
- "positions": sólo las posiciones sobre las que tengas algo pendiente o estructural que decir. Omitir es correcto y muy preferible a rellenar. Es mejor devolver tres posiciones con sustancia que siete con relleno.
- "stance": add = lo pendiente juega a favor · hold = nada pendiente cambia la tesis · watch = hay un desenlace fechado que puede cambiarla · review = hay un compromiso o una constricción futura que la contradice.
- QUE UNA EMPRESA PRESENTE RESULTADOS NO ES MOTIVO DE POSTURA. Todas presentan resultados. Si lo único que tienes de una posición es su fecha y su consenso, OMÍTELA de "positions": ya aparece en watchNext y repetirla ahí es relleno. Sólo entra en "positions" lo que tenga un compromiso pendiente, una constricción de oferta futura, una condición regulatoria o una contradicción real.
- Si todas tus posturas salen iguales, no has encontrado nada que las distinga: devuelve menos posiciones, no todas con la misma etiqueta.
- NO escribas marcadores [n] dentro de "why". Los números van SÓLO en "used".
- "why": UNA frase que contenga un plazo, una condición o una cantidad futura. Ejemplos válidos: "cierre de la compra de Iridium sujeto a aprobación antimonopolio, previsto para el primer semestre de 2027 [3]"; "el consejero X lleva 5 ventas programadas y le quedan 81.109 acciones por colocar"; "reporta el 29 con un consenso de 7,38$ de BPA tras haber guiado por debajo". Ejemplo inválido: "los insiders están vendiendo y el sentimiento cae".
- "used": los números de las noticias que sostienen el "why". Si sale sólo de los hechos calculados, deja [] — pero el dato exacto tiene que aparecer en la frase.
- "watchNext": 2-5 puntos, cada uno un DESENLACE PENDIENTE con su plazo o su condición, sacados del LIBRO DE FUTUROS o del CALENDARIO. Ordénalos por proximidad. Si el libro de futuros viene vacío, dilo explícitamente en vez de rellenar con generalidades.
- NUNCA uses tu propio conocimiento sobre estas empresas. Tus datos de entrenamiento están caducados y el usuario no puede distinguirlo.
- Si un valor aparece SIN COBERTURA, menciónalo en el veredicto como punto ciego y no le pongas postura.
- Español. Registro de mesa: concreto, sin coletillas, sin descargos, sin "como IA".`;

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

/** El bloque que da sentido a todo el rediseño. Va ANTES que las noticias
 *  en el prompt a propósito: es lo que el modelo debe leer primero. */
function formatLedger(items: ForwardItem[]): string {
  if (!items.length) {
    return "LIBRO DE FUTUROS: VACÍO. Ningún artículo del archivo contiene compromisos pendientes para estas posiciones. Dilo explícitamente en watchNext en vez de rellenar con generalidades.";
  }
  const lines = items.map((i) => {
    const bits = [`${i.symbol} · ${i.event}`];
    if (i.when) bits.push(`plazo: ${i.when}`);
    if (i.whenDate) bits.push(`fecha: ${i.whenDate}`);
    if (i.condition) bits.push(`condición: ${i.condition}`);
    return `- [${i.source}] ${bits.join(" · ")}`;
  });
  return `LIBRO DE FUTUROS (compromisos SIN resolver, extraídos de los cuerpos de los artículos — esto es lo que el usuario no puede ver en su bróker):\n${lines.join("\n")}`;
}

function formatForwardFacts(r: PortfolioRetrieval): string {
  const out: string[] = [];

  if (r.forward.sellers.length) {
    const lines = r.forward.sellers.map((s) => {
      const quedan =
        s.sharesAfter != null
          ? `, le quedan ${Math.round(s.sharesAfter).toLocaleString("es-ES")} acciones declaradas`
          : "";
      const val = s.totalValue ? `, ${fmtMoney(s.totalValue)} en total` : "";
      return `- ${s.symbol}: ${s.owner}${s.title ? ` (${s.title})` : ""} — ${s.sales} ventas entre ${s.firstSale} y ${s.lastSale}${val}${quedan}`;
    });
    out.push(
      `VENTA PROGRAMADA DE DIRECTIVOS (patrón repetido en 90d = plan en curso; lo que queda es oferta futura ya conocida):\n${lines.join("\n")}`,
    );
  }

  const bars = r.forward.earningsBars.filter(
    (b) => b.epsEstimate != null || b.revenueEstimate != null,
  );
  if (bars.length) {
    const lines = bars.map((b) => {
      const eps = b.epsEstimate != null ? `BPA ${b.epsEstimate}$` : "";
      const rev =
        b.revenueEstimate != null
          ? `${eps ? ", " : ""}ingresos ${(b.revenueEstimate / 1e9).toFixed(2)}B$`
          : "";
      return `- ${b.symbol}: ${b.date} (dentro de ${b.daysAway} días) — consenso ${eps}${rev}`;
    });
    out.push(
      `VARA DE LOS PRÓXIMOS RESULTADOS (el consenso a batir, no el resultado):\n${lines.join("\n")}`,
    );
  }

  // Diagnóstico de la propia cosecha. Si el archivo no dio cuerpos, el
  // modelo tiene que saberlo para no fingir profundidad que no tiene.
  if (r.forward.bodiesAvailable === 0 && r.forward.candidates.length > 0) {
    out.push(
      `AVISO: no se pudo extraer el cuerpo de ninguno de los ${r.forward.candidates.length} artículos candidatos (fuentes bloqueadas o de pago). Trabajas sólo con titulares y datos estructurados: sé más breve y no simules profundidad.`,
    );
  }

  return out.join("\n\n");
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
  const factsBySymbol = new Map(r.facts.map((f) => [f.symbol, f]));
  // Qué símbolos respalda cada cita. Se usa para rechazar atribuciones
  // cruzadas: en la primera prueba real el modelo colgó de META la cita
  // [18], que era el artículo de la compra de Iridium por RKLB. Existía
  // (pasaba el filtro de "número válido") pero no hablaba de META, y una
  // cita que no sostiene lo que acompaña es peor que ninguna: parece
  // verificación y no lo es.
  const symbolsOfCitation = new Map(
    r.citations.map((c) => [c.n, new Set(c.symbols)]),
  );

  return positions
    .filter((p) => inPortfolio.has(p.symbol))
    .map((p) => {
      const { why, inline } = splitInlineMarkers(p.why);
      const merged = [...new Set([...(p.used ?? []), ...inline])];
      const used = merged.filter((n) => symbolsOfCitation.get(n)?.has(p.symbol));
      const backed = used.length > 0 || hasHardEvidence(factsBySymbol.get(p.symbol));
      if (backed) return { ...p, why, used };
      return { ...p, why, used, stance: "none" as Stance, degraded: true };
    });
}

/**
 * Separa los marcadores [n] que el modelo escribe DENTRO del texto.
 *
 * El prompt pide que los números vayan sólo en `used`, y aun así aparecen
 * en línea — con lo que la UI, que añade los suyos al final, los pintaba
 * dos veces ("…quedan 81.109 acciones [4,18]. [4]"). Se extraen para no
 * perder la señal (a veces el modelo cita mejor en línea que en `used`) y
 * se limpian del texto.
 */
function splitInlineMarkers(text: string): { why: string; inline: number[] } {
  const inline: number[] = [];
  const why = text
    .replace(/\[(\d+(?:\s*,\s*\d+)*)\]/g, (_m, group: string) => {
      for (const part of group.split(",")) {
        const n = Number(part.trim());
        if (Number.isInteger(n)) inline.push(n);
      }
      return "";
    })
    // La limpieza deja huecos y puntuación colgando (" . ", " ,").
    .replace(/\s+([.,;:])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim()
    .replace(/[\s.]+$/, "");
  return { why: why ? `${why}.` : "", inline };
}

const STANCES = new Set<Stance>(["add", "hold", "watch", "review"]);

export async function reviewPortfolio(
  r: PortfolioRetrieval,
  ledger: ForwardItem[] = [],
): Promise<PortfolioReview> {
  if (!r.portfolio.positions.length) {
    return { verdict: "", positions: [], watchNext: [], model: "none" };
  }

  // Los priors del Lab entran como CALIBRACIÓN, no como dato a citar: si
  // los upgrades de analista no han batido a SPY, el modelo debe ser más
  // duro con una posición que sólo se sostiene en un upgrade. El propio
  // helper ya prohíbe citarlos y exige n>=20.
  const priors = await getEmpiricalPriors().catch(() => null);

  // ORDEN DELIBERADO: el libro de futuros va primero, las noticias al
  // final. Un modelo pondera lo que lee antes, y cuando las noticias
  // encabezaban el bloque la revisión salía siendo un resumen de noticias.
  const userBlock = [
    formatPortfolio(r),
    "",
    formatLedger(ledger),
    "",
    formatForwardFacts(r),
    "",
    formatCalendar(r),
    "",
    formatFacts(r.facts),
    "",
    "NOTICIAS DEL ARCHIVO (material de apoyo para citar — NO las resumas):",
    formatCitations(r),
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
