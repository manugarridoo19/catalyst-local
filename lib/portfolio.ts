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
 * Umbrales de concentración. Están AQUÍ arriba y con nombre porque son la
 * única parte de este módulo que es una preferencia y no una definición:
 * cambiar 30 por 25 cambia de qué habla la revisión, y es una decisión de
 * tolerancia al riesgo, no un hecho.
 */
export const CONCENTRATION = {
  /** Una posición por encima de esto domina el resultado de la cartera. */
  positionWarn: 30,
  positionInfo: 20,
  /** Un sector por encima de esto convierte la cartera en una apuesta
   *  sectorial, tenga los nombres que tenga. */
  sectorWarn: 50,
  sectorInfo: 35,
  /** Las tres mayores juntas. Captura la concentración repartida entre
   *  varias posiciones que individualmente no llegan al umbral. */
  topThreeWarn: 70,
  /** Por debajo de esto, la concentración por posición es ARITMÉTICA y no
   *  una decisión: con 4 nombres equiponderados cada uno pesa 25%. Avisar
   *  de cada posición sería ruido, así que se avisa del recuento. */
  minPositionsForPositionFlags: 5,
  /** Peso sin clasificar a partir del cual los pesos sectoriales dejan de
   *  ser fiables. No es riesgo de mercado: es calidad del dato. */
  unclassifiedInfo: 25,
} as const;

/**
 * Riesgos de concentración de la cartera.
 *
 * Lo que se devuelve aquí es lo que la revisión presenta como "riesgo", así
 * que la regla de fondo es no gritar por lo inevitable: una cartera de tres
 * nombres está concentrada por definición y decirlo tres veces (una por
 * posición) no informa de nada. Por eso las banderas por posición se
 * silencian en carteras pequeñas y se sustituyen por una sola sobre el
 * recuento.
 */
export function concentrationFlags(p: Portfolio): ConcentrationFlag[] {
  const flags: ConcentrationFlag[] = [];
  // Una cartera vacía no tiene concentración que declarar.
  if (!p.positions.length) return flags;

  const n = p.positions.length;

  if (n < CONCENTRATION.minPositionsForPositionFlags) {
    flags.push({
      kind: "position",
      label: `${n} ${n === 1 ? "posición" : "posiciones"}`,
      weightPct: n ? 100 / n : 0,
      level: n <= 2 ? "warn" : "info",
    });
  } else {
    for (const pos of p.positions) {
      const w = pos.weightPct;
      if (w === null) continue;
      if (w >= CONCENTRATION.positionWarn) {
        flags.push({ kind: "position", label: pos.symbol, weightPct: w, level: "warn" });
      } else if (w >= CONCENTRATION.positionInfo) {
        flags.push({ kind: "position", label: pos.symbol, weightPct: w, level: "info" });
      }
    }

    // Sólo tiene sentido como bandera aparte si NINGUNA posición suelta ya
    // disparó un warn: si una pesa el 40%, decir además que las tres
    // mayores suman el 72% es la misma noticia contada dos veces.
    const top3 = p.positions
      .slice(0, 3)
      .reduce((acc, x) => acc + (x.weightPct ?? 0), 0);
    const yaHayWarnDePosicion = flags.some(
      (f) => f.kind === "position" && f.level === "warn",
    );
    if (top3 >= CONCENTRATION.topThreeWarn && !yaHayWarnDePosicion) {
      flags.push({
        kind: "position",
        label: "las 3 mayores",
        weightPct: top3,
        level: "warn",
      });
    }
  }

  for (const s of p.sectors) {
    // "Unknown" no es un sector: es dato que falta, y va como bandera
    // propia más abajo. Contarlo como concentración sectorial diría que
    // una cartera sin clasificar está concentrada en nada.
    if (s.sector === "Unknown") continue;
    if (s.weightPct >= CONCENTRATION.sectorWarn) {
      flags.push({ kind: "sector", label: s.sector, weightPct: s.weightPct, level: "warn" });
    } else if (s.weightPct >= CONCENTRATION.sectorInfo) {
      flags.push({ kind: "sector", label: s.sector, weightPct: s.weightPct, level: "info" });
    }
  }

  const unknown = p.sectors.find((s) => s.sector === "Unknown");
  if (unknown && unknown.weightPct >= CONCENTRATION.unclassifiedInfo) {
    flags.push({
      kind: "unclassified",
      label: "sin sector",
      weightPct: unknown.weightPct,
      level: "info",
    });
  }

  // Los warn primero y, dentro de cada nivel, lo más pesado antes: es el
  // orden en que se pintan y en que los lee el modelo.
  return flags.sort(
    (a, b) =>
      (a.level === b.level ? 0 : a.level === "warn" ? -1 : 1) ||
      b.weightPct - a.weightPct,
  );
}
