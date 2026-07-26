// Matemática de cartera. TS PURO: sin BD, sin fetch, sin `server-only`.
//
// Vive aquí y no dentro de `lib/ask/` porque tiene dos consumidores que no
// pueden compartir código de servidor: el rail de la watchlist (componente
// cliente, pinta peso y P&L con los quotes que ya refresca cada 60s) y el
// retrieval de la revisión de cartera (servidor). Una sola definición de
// "cuánto pesa esto" evita que la pantalla y la revisión digan cosas
// distintas sobre la misma posición — el tipo de discrepancia que destruye
// la confianza en un dashboard.

export type Position = {
  symbol: string;
  name: string | null;
  sector: string | null;
  /** NULL = solo seguimiento · 0 = cerrada · >0 = viva. */
  shares: number | null;
  avgCost: number | null;
};

export type PricedPosition = Position & {
  shares: number;
  price: number | null;
  dayChangePct: number | null;
  /** shares × price. NULL si no hay precio. */
  marketValue: number | null;
  /** shares × avgCost. NULL si no registraste coste. */
  costBasis: number | null;
  unrealizedAbs: number | null;
  unrealizedPct: number | null;
  /** % sobre el valor TOTAL VALORABLE (ver nota en buildPortfolio). */
  weightPct: number | null;
};

export type SectorWeight = {
  sector: string;
  weightPct: number;
  symbols: string[];
};

export type Portfolio = {
  /** Posiciones vivas (shares > 0), ordenadas por peso descendente. */
  positions: PricedPosition[];
  /** shares NULL — se siguen pero no se poseen. */
  watchOnly: Position[];
  /** shares === 0 — cerradas pero aún vigiladas. */
  closed: Position[];
  totalValue: number;
  /** Coste sólo de las posiciones que TIENEN coste registrado. */
  totalCost: number;
  totalUnrealizedAbs: number | null;
  totalUnrealizedPct: number | null;
  /** Movimiento de hoy de la cartera, ponderado por peso. */
  dayChangePct: number | null;
  sectors: SectorWeight[];
  /** Posiciones vivas sin precio: los pesos NO las incluyen. */
  unpricedSymbols: string[];
  /** Posiciones vivas sin coste medio: no reportan P&L. */
  noCostSymbols: string[];
};

export type QuoteLike = { price: number; changePercent: number } | null;

function isLive(p: Position): p is Position & { shares: number } {
  return p.shares !== null && p.shares > 0;
}

/**
 * Construye la foto de la cartera a partir de las filas de watchlist y un
 * mapa de quotes.
 *
 * DECISIÓN QUE IMPORTA — el denominador de los pesos es la suma de las
 * posiciones que SE HAN PODIDO VALORAR, no de todas. Si Finnhub y Yahoo
 * fallan para 2 de 10 nombres (pasa: `getQuotesMap` devuelve null por
 * símbolo en un 429), incluirlas como 0 repartiría su peso entre las
 * demás y la revisión hablaría de una concentración inventada. Excluirlas
 * del denominador da pesos correctos ENTRE lo valorable, y por eso
 * `unpricedSymbols` sale en el tipo: quien pinte esto está obligado a
 * decir sobre cuánto se está calculando.
 */
export function buildPortfolio(
  rows: Position[],
  quotes: Record<string, QuoteLike>,
): Portfolio {
  const watchOnly = rows.filter((p) => p.shares === null);
  const closed = rows.filter((p) => p.shares === 0);
  const live = rows.filter(isLive);

  const priced = live.map((p) => {
    const q = quotes[p.symbol] ?? null;
    const price = q && q.price > 0 ? q.price : null;
    const marketValue = price !== null ? p.shares * price : null;
    const costBasis = p.avgCost !== null ? p.shares * p.avgCost : null;
    const unrealizedAbs =
      marketValue !== null && costBasis !== null ? marketValue - costBasis : null;
    const unrealizedPct =
      unrealizedAbs !== null && costBasis !== null && costBasis > 0
        ? (unrealizedAbs / costBasis) * 100
        : null;
    return {
      ...p,
      price,
      dayChangePct: q?.changePercent ?? null,
      marketValue,
      costBasis,
      unrealizedAbs,
      unrealizedPct,
      weightPct: null as number | null,
    };
  });

  const totalValue = priced.reduce((acc, p) => acc + (p.marketValue ?? 0), 0);
  for (const p of priced) {
    p.weightPct =
      p.marketValue !== null && totalValue > 0
        ? (p.marketValue / totalValue) * 100
        : null;
  }
  priced.sort((a, b) => (b.weightPct ?? -1) - (a.weightPct ?? -1));

  // El P&L agregado sólo suma posiciones que tienen AMBOS lados (valor y
  // coste). Mezclar un valor sin su coste daría un porcentaje sin sentido.
  const withBoth = priced.filter(
    (p) => p.marketValue !== null && p.costBasis !== null,
  );
  const totalCost = withBoth.reduce((acc, p) => acc + (p.costBasis ?? 0), 0);
  const valueOfCosted = withBoth.reduce(
    (acc, p) => acc + (p.marketValue ?? 0),
    0,
  );
  const totalUnrealizedAbs = withBoth.length ? valueOfCosted - totalCost : null;
  const totalUnrealizedPct =
    totalUnrealizedAbs !== null && totalCost > 0
      ? (totalUnrealizedAbs / totalCost) * 100
      : null;

  // Movimiento del día ponderado por peso — no la media simple, que daría
  // el mismo voto a una posición del 2% que a una del 30%.
  const movers = priced.filter(
    (p) => p.dayChangePct !== null && p.weightPct !== null,
  );
  const dayChangePct = movers.length
    ? movers.reduce(
        (acc, p) => acc + (p.dayChangePct ?? 0) * ((p.weightPct ?? 0) / 100),
        0,
      )
    : null;

  return {
    positions: priced,
    watchOnly,
    closed,
    totalValue,
    totalCost,
    totalUnrealizedAbs,
    totalUnrealizedPct,
    dayChangePct,
    sectors: sectorWeights(priced),
    unpricedSymbols: priced.filter((p) => p.price === null).map((p) => p.symbol),
    noCostSymbols: priced.filter((p) => p.avgCost === null).map((p) => p.symbol),
  };
}

/** Peso por sector. Los nombres sin sector se agrupan en "Unknown" en vez
 *  de descartarse: una cartera con la mitad sin clasificar debe VERSE, no
 *  parecer perfectamente diversificada por omisión. */
export function sectorWeights(positions: PricedPosition[]): SectorWeight[] {
  const acc = new Map<string, { w: number; symbols: string[] }>();
  for (const p of positions) {
    if (p.weightPct === null) continue;
    const key = p.sector?.trim() || "Unknown";
    const cur = acc.get(key) ?? { w: 0, symbols: [] };
    cur.w += p.weightPct;
    cur.symbols.push(p.symbol);
    acc.set(key, cur);
  }
  return [...acc.entries()]
    .map(([sector, v]) => ({ sector, weightPct: v.w, symbols: v.symbols }))
    .sort((a, b) => b.weightPct - a.weightPct);
}

export type ConcentrationFlag = {
  kind: "position" | "sector" | "unclassified";
  label: string;
  weightPct: number;
  /** "info" se menciona de pasada; "warn" sube al veredicto principal. */
  level: "info" | "warn";
};

/**
 * Riesgos de concentración de la cartera.
 *
 * ⚠️ PENDIENTE — los umbrales los decides tú (ver mensaje del agente).
 * Esto no es un detalle de implementación: define qué se le presenta al
 * modelo como "riesgo" y, por tanto, de qué va a hablar la revisión.
 * Devolver [] deja la revisión sin capa de concentración, no la rompe.
 */
export function concentrationFlags(p: Portfolio): ConcentrationFlag[] {
  const flags: ConcentrationFlag[] = [];
  // Una cartera vacía no tiene concentración que declarar.
  if (!p.positions.length) return flags;

  // TODO(usuario): reglas de concentración. Materia prima disponible:
  //   p.positions[i].weightPct  — peso de cada posición (ya ordenado desc)
  //   p.sectors[i].weightPct    — peso por sector, con sus símbolos
  //   p.positions.length        — nº de posiciones vivas
  // Empuja un ConcentrationFlag por cada regla que se dispare.

  return flags;
}
