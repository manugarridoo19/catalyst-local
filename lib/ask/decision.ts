// Los HECHOS de una pregunta de decisión, ya cerrados en números.
//
// Doctrina del proyecto aplicada aquí sin excepciones: si un número va a
// salir en pantalla, lo calcula el código. La revisión de cartera ya midió
// el modo de fallo (lib/ai/portfolio-review.ts): puesto a estimar pesos y
// betas, el modelo acertaba POR POCO — que es peor que fallar, porque nadie
// lo audita. En una pregunta de "¿vendo una parte?" el número que decide es
// justamente el peso de la posición, así que ninguna de estas cifras puede
// pasar por el LLM.
//
// Lo que este módulo produce son PRESIONES con lado. No son consejos: son
// hechos duros ya clasificados por hacia dónde empujan, para que el
// redactor no tenga que inferir la dirección (que es donde inventaría).

import { concentrationFlags, type Portfolio } from "@/lib/portfolio";
import type { RiskFact, StructuredFacts } from "@/lib/ask/retrieve";
import type { EarningsBar, PendingDeal, SystematicSeller } from "@/lib/ask/forward";

/**
 * UMBRALES. Es la única parte de este archivo que es una PREFERENCIA y no
 * una definición: cambiar 25 por 35 cambia qué preguntas reciben presión de
 * recorte. Es tolerancia al riesgo, no un hecho de mercado — están aquí
 * arriba, con nombre y sueltos, para que se toquen sin leer el resto.
 *
 * Los de concentración conviven a propósito con `CONCENTRATION` de
 * lib/portfolio.ts y no lo reutilizan: aquél decide de qué AVISA la revisión
 * de cartera (30% = una posición domina el resultado); éste decide cuándo
 * recortar es una respuesta defendible a una pregunta concreta, y ese listón
 * es más bajo porque la pregunta ya la hizo el usuario.
 */
export const DECISION_THRESHOLDS = {
  /** Peso por encima del cual "recortar una parte" reduce riesgo real y no
   *  es sólo mover dinero de sitio. */
  weightTrimPct: 25,
  /** Peso por debajo del cual recortar es ruido: la posición no mueve la
   *  cartera y vender paga comisión y fiscalidad para nada. */
  weightMinPct: 5,
  /** Plusvalía no realizada que convierte "dejar correr" en una decisión
   *  activa (hay algo concreto que asegurar). */
  bigGainPct: 40,
  /** Minusvalía a partir de la cual conviene decir en voz alta que el
   *  precio de entrada NO es un dato del negocio. */
  bigLossPct: -20,
  /** Un evento fechado dentro de esta ventana ocurre antes de que dé tiempo
   *  a reaccionar: entra en "lo que lo decide", no en el debate. */
  eventSoonDays: 14,
  /** Flujo insider neto (mercado abierto, 30d) que ya no es ruido. */
  insiderNetUsd: 1_000_000,
  /** Days-to-cover a partir del cual el corto es estructura, no anécdota. */
  daysToCoverHigh: 5,
  /** Variación del interés corto entre las dos liquidaciones de FINRA que
   *  deja de ser ruido de medición. */
  shortChangePct: 15,
  /** Beta por encima de la cual una posición grande amplifica el resultado
   *  de la cartera de forma que el peso por sí solo no comunica. */
  betaHigh: 1.4,
} as const;

/** La posición del usuario en un símbolo de la pregunta. Todo precalculado
 *  por `buildPortfolio`, que es la ÚNICA fuente de estas cuentas en el
 *  proyecto (tabla, rail y prompts leen de ahí). */
export type PositionContext = {
  symbol: string;
  /** false = está en la watchlist sin acciones, o no está. La pregunta
   *  sigue siendo legítima ("¿entro en $RKLB?") pero sin peso ni P&L. */
  held: boolean;
  shares: number | null;
  avgCost: number | null;
  price: number | null;
  marketValue: number | null;
  weightPct: number | null;
  unrealizedPct: number | null;
  unrealizedAbs: number | null;
  dayChangePct: number | null;
  /** Contexto de cartera, para que "el 34%" signifique algo. */
  portfolioValue: number;
  positionCount: number;
};

/** Un hecho duro ya orientado. `neutral` = importa para decidir pero no
 *  empuja a ningún lado por sí solo (una plusvalía grande es argumento de
 *  los dos bandos según a quién le preguntes).
 *
 *  `add` existe desde 2026-07-31: "¿qué te parece una inversión en $SOFI a
 *  largo plazo?" preguntaba por AMPLIAR y el esquema sólo conocía aguantar
 *  y recortar — la respuesta no podía recomendar invertir más ni teniendo
 *  los datos delante. Aguantar y ampliar no son el mismo lado: uno defiende
 *  lo que hay, el otro pide dinero nuevo. */
export type Pressure = {
  symbol: string;
  side: "add" | "hold" | "trim" | "neutral";
  text: string;
};

/** Algo ya publicado que va a resolver parte de la duda, con su fecha. */
export type DatedFact = {
  symbol: string;
  date: string | null;
  text: string;
};

export type DecisionFacts = {
  contexts: PositionContext[];
  pressures: Pressure[];
  dated: DatedFact[];
};

function money(n: number): string {
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

/** Días entre hoy y una fecha `yyyy-mm-dd`. Sobre UTC a mediodía para que
 *  el redondeo no baile con el huso. */
export function daysUntil(date: string, today = new Date()): number | null {
  const t = Date.parse(`${date}T12:00:00Z`);
  if (!Number.isFinite(t)) return null;
  const now = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate(), 12);
  return Math.round((t - now) / 86_400_000);
}

/** La posición del usuario en cada símbolo preguntado. */
export function positionContexts(
  symbols: string[],
  portfolio: Portfolio | null,
): PositionContext[] {
  if (!portfolio) return [];
  const bySymbol = new Map(portfolio.positions.map((p) => [p.symbol, p]));
  return symbols.map((symbol) => {
    const p = bySymbol.get(symbol);
    return {
      symbol,
      held: Boolean(p),
      shares: p?.shares ?? null,
      avgCost: p?.avgCost ?? null,
      price: p?.price ?? null,
      marketValue: p?.marketValue ?? null,
      weightPct: p?.weightPct ?? null,
      unrealizedPct: p?.unrealizedPct ?? null,
      unrealizedAbs: p?.unrealizedAbs ?? null,
      dayChangePct: p?.dayChangePct ?? null,
      portfolioValue: portfolio.totalValue,
      positionCount: portfolio.positions.length,
    };
  });
}

/**
 * Convierte hechos duros en presiones con lado.
 *
 * Regla de admisión, y es la que da valor al bloque: sólo entra un dato que
 * ALGUIEN TUVO QUE DECLARAR (SEC, FINRA, el calendario de resultados) o que
 * sale de la aritmética de la propia cartera. Quedan fuera a propósito el
 * volumen de cobertura y el sentimiento medio: con "mucha atención
 * mediática" y "sentimiento tibio" se justifica cualquier cosa y las dos
 * frases suenan igual de informadas. Es el mismo criterio que
 * `hasHardEvidence` en la revisión de cartera.
 */
export function buildDecisionFacts(input: {
  symbols: string[];
  portfolio: Portfolio | null;
  facts: StructuredFacts[];
  bars?: EarningsBar[];
  sellers?: SystematicSeller[];
  deals?: PendingDeal[];
  risk?: RiskFact[];
  today?: Date;
}): DecisionFacts {
  const { symbols, portfolio, facts } = input;
  const T = DECISION_THRESHOLDS;
  const contexts = positionContexts(symbols, portfolio);
  const factsBy = new Map(facts.map((f) => [f.symbol, f]));
  const barsBy = new Map((input.bars ?? []).map((b) => [b.symbol, b]));
  const riskBy = new Map((input.risk ?? []).map((r) => [r.symbol, r]));
  const ctxBy = new Map(contexts.map((c) => [c.symbol, c]));
  // Los pesos por SECTOR ya los calcula `buildPortfolio`; sólo había que
  // mirarlos. Ver el bloque de abajo para por qué cambian la respuesta.
  const flags = portfolio ? concentrationFlags(portfolio) : [];
  const sectorOf = new Map(
    (portfolio?.positions ?? []).map((p) => [p.symbol, p.sector?.trim() || "Unknown"]),
  );

  const pressures: Pressure[] = [];
  const dated: DatedFact[] = [];

  // Se itera sobre los SÍMBOLOS y no sobre los contextos: sin cartera
  // cargada —watchlist vacía, o un 429 de Finnhub -- `contexts` viene vacío,
  // y recorrerlo dejaba fuera insiders, 13D y calendario, que son verdad
  // igual y no dependen de que el usuario tenga la posición. La respuesta
  // salía sin una sola presión justo el día que el proveedor de precios
  // fallaba, sin ningún error a la vista.
  for (const symbol of symbols) {
    const ctx = ctxBy.get(symbol);
    const f = factsBy.get(symbol);

    // ── La cartera ──────────────────────────────────────────────────────
    if (ctx && ctx.weightPct !== null) {
      if (ctx.weightPct >= T.weightTrimPct) {
        pressures.push({
          symbol,
          side: "trim",
          text: `pesa ${ctx.weightPct.toFixed(1)}% de tu cartera valorable (${money(ctx.marketValue ?? 0)} de ${money(ctx.portfolioValue)}, ${ctx.positionCount} posiciones) — por encima del umbral de concentración de ${T.weightTrimPct}%`,
        });
      } else if (ctx.weightPct < T.weightMinPct) {
        pressures.push({
          symbol,
          side: "hold",
          text: `pesa sólo ${ctx.weightPct.toFixed(1)}% de la cartera: recortar aquí no cambia el riesgo del conjunto`,
        });
      }
    }
    if (ctx && ctx.unrealizedPct !== null) {
      if (ctx.unrealizedPct >= T.bigGainPct) {
        pressures.push({
          symbol,
          side: "neutral",
          text: `plusvalía no realizada ${pct(ctx.unrealizedPct)} (${money(ctx.unrealizedAbs ?? 0)}): recortar la asegura y tributa; aguantar la mantiene expuesta`,
        });
      } else if (ctx.unrealizedPct <= T.bigLossPct) {
        pressures.push({
          symbol,
          side: "neutral",
          text: `minusvalía no realizada ${pct(ctx.unrealizedPct)} (${money(ctx.unrealizedAbs ?? 0)}): tu precio de entrada no es un dato del negocio y no debe entrar en la decisión`,
        });
      }
    }
    // Sólo se afirma "no la tienes" cuando la cartera SE PUDO LEER. Con
    // `portfolio` a null no sabemos nada de su exposición, y decir que no
    // tiene posición sería inventar el dato central de la respuesta.
    if (portfolio && !ctx?.held) {
      pressures.push({
        symbol,
        side: "neutral",
        text: `no tienes posición registrada en ${symbol}: la pregunta es de entrada, no de recorte`,
      });
    }

    // ── Riesgo estructural ──────────────────────────────────────────────
    //
    // Beta y days-to-cover llevaban meses en la BD sin que /ask los leyera,
    // y son justo lo que CUALIFICA un peso: un 27% con beta 1,9 amplifica
    // el resultado de la cartera de una forma que el porcentaje solo no
    // comunica. Ninguno de los dos es un precio — no repiten lo que ya ve
    // en el bróker, que es la regla que gobierna todo este modo.
    const risk = riskBy.get(symbol);
    if (risk?.beta != null && risk.beta >= T.betaHigh && ctx?.held) {
      pressures.push({
        symbol,
        side: "trim",
        text: `beta ${risk.beta.toFixed(2)}: con ${ctx.weightPct !== null ? `${ctx.weightPct.toFixed(1)}% de la cartera` : "esta posición"} el valor amplifica el movimiento del mercado, no lo diluye`,
      });
    }
    if (risk?.daysToCover != null && risk.daysToCover >= T.daysToCoverHigh) {
      // Deliberadamente NEUTRAL. Un days-to-cover alto es a la vez apuesta
      // contraria acumulada (argumento para recortar) y combustible de
      // squeeze (argumento para aguantar). Asignarle lado sería elegir una
      // narrativa, que es exactamente lo que este bloque existe para no
      // hacer. La derivada sí se declara, porque distingue estructura de
      // gente tomando posición ahora.
      const deriva =
        risk.shortChangePct != null && Math.abs(risk.shortChangePct) >= T.shortChangePct
          ? `, y el interés corto ${risk.shortChangePct > 0 ? "subió" : "bajó"} ${Math.abs(risk.shortChangePct).toFixed(0)}% respecto a la liquidación anterior de FINRA`
          : " y estable respecto a la liquidación anterior";
      pressures.push({
        symbol,
        side: "neutral",
        text: `days-to-cover ${risk.daysToCover.toFixed(1)}${deriva}: hay apuesta contraria acumulada, que es a la vez presión vendedora y combustible de un squeeze`,
      });
    }

    if (!f) continue;

    // ── Lo declarado ante el regulador ──────────────────────────────────
    //
    // Compras netas y 13D/G van al lado AMPLIAR, no a aguantar: los dos son
    // dinero nuevo entrando declarado ante la SEC — gente poniendo capital,
    // no gente conservando el que tenía. Ponerlos en "aguantar" (como hasta
    // el 2026-07-31) los infravendía: son el único hecho duro que puede
    // sostener una recomendación de invertir más.
    const net = f.insiderNet30d;
    if (net !== null && Math.abs(net) >= T.insiderNetUsd) {
      pressures.push({
        symbol,
        side: net > 0 ? "add" : "trim",
        text: `insiders neto 30d ${money(net)} en mercado abierto (${f.insiderBuyers30d} compradores / ${f.insiderSellers30d} vendedores)`,
      });
    }
    for (const s of f.stakes) {
      pressures.push({
        symbol,
        side: "add",
        text: `13D/G de ${s.filer ?? "declarante no identificado"}${s.pct !== null ? ` con ${s.pct}% del capital` : ""} declarado el ${s.filedAt} — hay un tercero acumulando con intención declarada`,
      });
    }

    // ── Lo que está fechado ─────────────────────────────────────────────
    if (f.nextEarnings) {
      const d = daysUntil(f.nextEarnings, input.today);
      const bar = barsBy.get(symbol);
      const eps = f.nextEarningsEps ?? bar?.epsEstimate ?? null;
      const rev = f.nextEarningsRevenue ?? bar?.revenueEstimate ?? null;
      const vara = [
        eps !== null ? `consenso BPA ${eps}$` : "",
        rev !== null ? `ingresos ${(rev / 1e9).toFixed(2)}B$` : "",
      ]
        .filter(Boolean)
        .join(" e ");
      dated.push({
        symbol,
        date: f.nextEarnings,
        text: `resultados${f.nextEarningsHour ? ` (${f.nextEarningsHour})` : ""}${
          d !== null ? `, dentro de ${d} día${Math.abs(d) === 1 ? "" : "s"}` : ""
        }${vara ? ` — la vara a batir: ${vara}` : ""}`,
      });
      // Un evento fechado ANTES de que dé tiempo a reaccionar no es un
      // argumento del debate: es la fecha en la que el debate se resuelve
      // solo. Va a "lo que lo decide" y además presiona, porque mantener
      // el 100% de la posición a través de él es una decisión, no la
      // ausencia de una.
      if (d !== null && d >= 0 && d <= T.eventSoonDays && ctx?.held) {
        pressures.push({
          symbol,
          side: "trim",
          text: `reporta en ${d} día${d === 1 ? "" : "s"} (${f.nextEarnings}): llegar entero al evento es exponer ${ctx.weightPct !== null ? `${ctx.weightPct.toFixed(1)}% de la cartera` : "toda la posición"} a un desenlace binario con fecha`,
        });
      }
    }
    if (f.lastPick) {
      dated.push({
        symbol,
        date: f.lastPick.generatedAt,
        text: `tesis del último AI Pick de Catalyst: ${f.lastPick.thesis}`,
      });
    }
  }

  // ── Concentración SECTORIAL ───────────────────────────────────────────
  //
  // El dato que puede dar la vuelta a la respuesta y que ya estaba
  // calculado en `buildPortfolio` sin que nadie lo mirara: recortar una
  // posición del 27% suena a reducir riesgo, pero si su sector pesa el 70%
  // de la cartera el riesgo de verdad no está en el nombre, está en la
  // apuesta sectorial — y venderla para comprar otra tecnológica no cambia
  // nada. Es la diferencia entre responder a la pregunta que se hizo y
  // responder a la que había que hacerse.
  for (const symbol of symbols) {
    const sector = sectorOf.get(symbol);
    if (!sector || sector === "Unknown") continue;
    const flag = flags.find((fl) => fl.kind === "sector" && fl.label === sector);
    if (!flag) continue;
    pressures.push({
      symbol,
      side: flag.level === "warn" ? "trim" : "neutral",
      text: `su sector (${sector}) pesa ${flag.weightPct.toFixed(0)}% de la cartera: recortar ${symbol} reduce el riesgo del NOMBRE, no el de la apuesta sectorial — sustituirlo por otro valor del mismo sector dejaría la exposición donde estaba`,
    });
  }

  // ── Oferta futura ya conocida y operaciones sin cerrar ────────────────
  for (const s of input.sellers ?? []) {
    const quedan =
      s.sharesAfter != null
        ? `, le quedan ${Math.round(s.sharesAfter).toLocaleString("es-ES")} acciones declaradas`
        : "";
    pressures.push({
      symbol: s.symbol,
      side: "trim",
      text: `${s.owner}${s.title ? ` (${s.title})` : ""} lleva ${s.sales} ventas entre ${s.firstSale} y ${s.lastSale}${quedan} — plan de venta en curso, oferta futura ya conocida`,
    });
  }
  for (const d of input.deals ?? []) {
    // La etiqueta NO dice "sin cerrar". Estas noticias se eligen por
    // categoría y vocabulario, y nadie ha comprobado que la operación siga
    // abierta — eso sólo lo hace el extractor LLM del libro de futuros, que
    // este camino no usa. Afirmarlo sería exactamente el tipo de precisión
    // fabricada que el resto del módulo existe para impedir.
    dated.push({
      symbol: d.symbol,
      date: d.publishedAt,
      text: `operación corporativa anunciada (no verificado que siga abierta): ${d.headline}`,
    });
  }

  dated.sort((a, b) => (a.date ?? "9999").localeCompare(b.date ?? "9999"));
  return { contexts, pressures, dated };
}

/** ¿Hay algo duro sobre lo que inclinarse? Lo consume el gate de
 *  `lib/ai/ask.ts`: sin esto, una postura es una opinión sin respaldo. */
export function hasDecisionEvidence(d: DecisionFacts): boolean {
  return d.pressures.some((p) => p.side !== "neutral") || d.dated.length > 0;
}
