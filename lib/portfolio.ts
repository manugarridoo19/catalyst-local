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
  /** Dinero ganado o perdido HOY en esta posición: shares × (precio −
   *  cierre anterior). El porcentaje solo no responde a "¿cuánto llevo
   *  hoy?" cuando los pesos son dispares: un +5% en el 3% de la cartera
   *  pesa mucho menos que un −1% en el 40%. */
  dayChangeAbs: number | null;
  /** shares × price. NULL si no hay precio. */
  marketValue: number | null;
  /** shares × avgCost — el dinero que pusiste. NULL si no hay coste. */
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
  /** Dinero ganado o perdido hoy en total. Suma directa, no ponderada. */
  dayChangeAbs: number | null;
  sectors: SectorWeight[];
  /** Posiciones vivas sin precio: los pesos NO las incluyen. */
  unpricedSymbols: string[];
  /** Posiciones vivas sin coste medio: no reportan P&L. */
  noCostSymbols: string[];
};

export type QuoteLike = {
  price: number;
  changePercent: number;
  /** Cierre de la sesión anterior. Opcional porque no todas las fuentes lo
   *  traen; sin él se deriva del porcentaje (ver `prevCloseOf`). */
  prevClose?: number;
} | null;

/**
 * Cierre anterior, medido o derivado.
 *
 * Se prefiere SIEMPRE el valor declarado por la fuente. La derivación
 * `price / (1 + dp/100)` es aritméticamente equivalente pero arrastra el
 * redondeo del porcentaje (Finnhub lo da con 2 decimales), y ese error se
 * multiplica por el nº de acciones: en una posición de 10.000$ un dp
 * redondeado en la segunda cifra ya mueve el "ganado hoy" varios euros.
 */
function prevCloseOf(q: NonNullable<QuoteLike>): number | null {
  if (q.prevClose !== undefined && q.prevClose > 0) return q.prevClose;
  const factor = 1 + q.changePercent / 100;
  if (!Number.isFinite(factor) || factor <= 0) return null;
  return q.price / factor;
}

/**
 * Acciones equivalentes a un importe invertido a un precio dado.
 *
 * Existe porque casi nadie recuerda su posición en número de acciones —
 * se recuerda como "metí 500 en NVDA a 120". El esquema sigue guardando
 * `shares` + `avg_cost` como forma canónica (de ahí salen valor de mercado
 * y P&L); esto es sólo la conversión de entrada.
 */
export function sharesFromAmount(
  amount: number,
  pricePerShare: number,
): number | null {
  if (!Number.isFinite(amount) || !Number.isFinite(pricePerShare)) return null;
  if (amount < 0 || pricePerShare <= 0) return null;
  return amount / pricePerShare;
}

/** Una compra suelta: lo que acabas de ejecutar en el bróker. */
export type Lot = { shares: number; price: number };

export type PositionAfterLot = {
  shares: number;
  avgCost: number | null;
  /** true = el coste medio resultante NO se puede conocer y sale `null`.
   *  Se devuelve para que la UI lo DIGA en vez de enseñar un guion mudo. */
  avgCostUnknown: boolean;
};

/**
 * Posición resultante de reforzar con una compra nueva.
 *
 * Es la única definición de "precio medio ponderado" del proyecto: la usan
 * la previsualización del formulario y la escritura en BD. Que sea una sola
 * es lo que impide que la pantalla te prometa un coste medio y la fila
 * guarde otro.
 *
 * TRES casos, y el tercero es el que importa:
 *
 *  1. **Sin acciones previas** (null o 0) → el coste medio ES el precio de
 *     esta compra. No hay historia anterior cuyo coste se desconozca.
 *  2. **Con acciones y coste registrado** → media ponderada por acciones,
 *     que es la definición contable y la que mueve tu P&L.
 *  3. **Con acciones pero SIN coste registrado** (estado válido y admitido:
 *     "sé cuánto pesa, no registré a cuánto entré") → el coste medio
 *     resultante es **desconocido**, y se devuelve `null`.
 *
 *     La tentación es poner el precio de esta compra. Sería inventar que
 *     pagaste ese precio por TODAS las acciones, incluidas las viejas, y
 *     ese número no se queda quieto: alimenta el P&L, los pesos, la
 *     plusvalía no realizada y, desde el modo decisión, las presiones que
 *     deciden si /ask te dice que recortes. Un dato fabricado que además
 *     parece razonable es el peor de los errores posibles aquí, porque
 *     nadie lo audita. Mejor `null` y decirlo.
 */
export function addToPosition(
  current: { shares: number | null; avgCost: number | null },
  lot: Lot,
): PositionAfterLot {
  const prev = current.shares ?? 0;
  const shares = prev + lot.shares;
  if (prev <= 0) {
    return { shares, avgCost: lot.price, avgCostUnknown: false };
  }
  if (current.avgCost === null) {
    return { shares, avgCost: null, avgCostUnknown: true };
  }
  const avgCost = (prev * current.avgCost + lot.shares * lot.price) / shares;
  return { shares, avgCost, avgCostUnknown: false };
}

export type PositionAfterSale =
  | {
      ok: true;
      shares: number;
      /** El coste medio NO cambia al vender. Ver la nota de abajo. */
      avgCost: number | null;
      /** Ganancia o pérdida REALIZADA en esta venta. `null` si el coste
       *  medio no se conocía: sin él no hay nada contra lo que medirla. */
      realized: number | null;
      /** true si esta venta cierra la posición por completo. */
      closes: boolean;
    }
  | { ok: false; reason: "sin_posicion" | "excede" };

/**
 * Posición resultante de recortar (vender parte o todo).
 *
 * LA REGLA QUE MÁS SE INCUMPLE A MANO: **vender NO mueve el coste medio**.
 * Es intuitivo pensar que si vendes caro "subes tu precio medio", y es
 * falso: el coste medio es lo que pagaste por acción, y las acciones que
 * te quedan las pagaste exactamente igual que antes de vender. Lo que la
 * venta produce es P&L REALIZADO, que es otra magnitud y vive en otro
 * sitio (el diario de operaciones).
 *
 * Mover el coste medio al vender contamina hacia adelante todo lo que
 * cuelga de él: el P&L no realizado de lo que queda, y desde el modo
 * decisión de /ask, la plusvalía que se le enseña al modelo.
 *
 * El P&L realizado se calcula CONTRA EL COSTE MEDIO DEL MOMENTO y se
 * archiva. Recalcularlo más tarde daría otro número, porque una compra
 * posterior habrá movido la media — y esa diferencia no sería una
 * corrección, sería una falsificación de lo que ganaste ese día.
 */
export function reducePosition(
  current: { shares: number | null; avgCost: number | null },
  lot: Lot,
): PositionAfterSale {
  const prev = current.shares ?? 0;
  if (prev <= 0) return { ok: false, reason: "sin_posicion" };
  // Tolerancia de una millonésima de acción: con posiciones fraccionarias
  // (2,387774594078319 acciones) "vender todo" tecleado a mano nunca cuadra
  // al bit, y rechazar una venta por 1e-12 sería absurdo.
  if (lot.shares > prev + 1e-9) return { ok: false, reason: "excede" };

  const sold = Math.min(lot.shares, prev);
  const shares = prev - sold;
  const closes = shares <= 1e-9;
  return {
    ok: true,
    shares: closes ? 0 : shares,
    avgCost: current.avgCost,
    realized:
      current.avgCost !== null ? sold * (lot.price - current.avgCost) : null,
    closes,
  };
}

/** Lo que `journalCash` necesita de una fila del diario. Se declara aquí
 *  ESTRUCTURALMENTE en vez de importar `PositionTrade` de `lib/db/queries`
 *  porque este módulo lo consume el cliente y `lib/db` no puede entrar en
 *  su bundle ni como import de tipo encadenado. */
export type TradeLike = {
  side: "buy" | "sell" | "adjust";
  shares: number | null;
  price: number | null;
  realizedPnl: number | null;
  createdAt: string;
};

export type JournalCash = {
  /** Suma de P&L realizado. `null` si NINGUNA venta pudo medirlo (todas sin
   *  coste medio registrado): cero sería afirmar que no ganaste nada. */
  realized: number | null;
  /** Ventas que no pudieron medir su realizado. Quien pinte `realized`
   *  está obligado a decir que es parcial si esto es > 0. */
  realizedUnknownSales: number;
  /** Dinero que ENTRÓ por ventas desde que existe el diario. */
  proceeds: number;
  /** Dinero que SALIÓ en compras desde que existe el diario. */
  outlays: number;
  /** proceeds − outlays. NO es el saldo de tu bróker: ver el docstring. */
  net: number;
  /** Fecha de la operación más antigua del diario (ISO), o null si vacío.
   *  Es el "desde" obligatorio de cualquier rótulo que pinte `net`. */
  since: string | null;
  buys: number;
  sells: number;
};

/**
 * Flujo de caja DEL DIARIO — no un saldo de efectivo.
 *
 * LA DISTINCIÓN QUE JUSTIFICA TODO EL DISEÑO: `position_trades` empezó el
 * día que se creó la tabla y no contiene el historial anterior. Sumar sus
 * ventas y restar sus compras da un número real y verificable — *cuánto
 * dinero han movido las operaciones registradas* — pero NO da tu saldo en
 * el bróker, porque faltan todos los ingresos, retiradas, dividendos y
 * comisiones, y faltan las compras con las que montaste las posiciones que
 * ya tenías el primer día.
 *
 * La tentación es llamarlo "efectivo" a secas y dejar que se lea como el
 * saldo. Sería el mismo error que mover el coste medio al vender: un
 * número plausible, nunca auditado, que además contaminaría los pesos si
 * alguien lo sumara al valor de la cartera. Por eso el tipo obliga a
 * devolver `since` — quien lo pinte no puede omitir desde cuándo cuenta.
 *
 * `adjust` no mueve caja: una corrección a mano es un estado nuevo
 * declarado, no dinero que haya cambiado de sitio. Y una fila sin `shares`
 * o sin `price` se ignora en el flujo (pero su realizado, si lo tiene, sí
 * cuenta: son magnitudes independientes).
 */
export function journalCash(trades: TradeLike[]): JournalCash {
  let proceeds = 0;
  let outlays = 0;
  let realized: number | null = null;
  let realizedUnknownSales = 0;
  let buys = 0;
  let sells = 0;
  let since: string | null = null;

  for (const t of trades) {
    if (since === null || t.createdAt < since) since = t.createdAt;

    if (t.side === "sell") {
      sells++;
      if (t.realizedPnl !== null) realized = (realized ?? 0) + t.realizedPnl;
      else realizedUnknownSales++;
    } else if (t.side === "buy") {
      buys++;
    }

    if (t.side === "adjust") continue;
    if (t.shares === null || t.price === null) continue;
    const amount = t.shares * t.price;
    if (t.side === "sell") proceeds += amount;
    else outlays += amount;
  }

  return {
    realized,
    realizedUnknownSales,
    proceeds,
    outlays,
    net: proceeds - outlays,
    since,
    buys,
    sells,
  };
}

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
    const prev = q ? prevCloseOf(q) : null;
    const dayChangeAbs =
      price !== null && prev !== null ? p.shares * (price - prev) : null;
    return {
      ...p,
      price,
      dayChangePct: q?.changePercent ?? null,
      dayChangeAbs,
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

  // El total en dinero SÍ es suma directa: cada posición aporta sus euros y
  // el peso ya está dentro del propio importe. Ponderarlo otra vez sería
  // contar el peso dos veces.
  const withDay = priced.filter((p) => p.dayChangeAbs !== null);
  const dayChangeAbs = withDay.length
    ? withDay.reduce((acc, p) => acc + (p.dayChangeAbs ?? 0), 0)
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
    dayChangeAbs,
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

/**
 * QUIÉN ARRASTRA HOY, y cuánto. La aritmética que responde "¿por qué cae mi
 * cartera hoy?" — calculada AQUÍ, nunca por el modelo.
 *
 * Existe porque esa pregunta tiene una respuesta exacta y el LLM no puede
 * darla. Medido el 2026-08-12 contra `gemini-3.6-flash` con los pesos y los
 * movimientos ya en el prompt: con el razonamiento apagado (que es como sale
 * hoy TODA llamada del proyecto) devolvió adjetivos — «genera el mayor
 * impacto negativo»; con razonamiento en `low` sí hizo la cuenta… y la hizo
 * ÉL. Ese es justo el modo de fallo que este proyecto tiene prohibido desde
 * el 2026-07-25: el modelo estima a ojo, acierta por poco y nadie lo audita.
 *
 * Con esta función el razonamiento se gasta donde sí aporta —QUÉ hecho
 * explica cada caída— y los números llegan hechos.
 *
 * `contribPct` es puntos porcentuales de la CARTERA, no el movimiento del
 * valor: una posición que cae un 10% pesando el 20% resta 2,0 puntos. Es la
 * única de las dos cifras que se puede sumar, y por eso es la que ordena.
 */
export type DayContribution = {
  symbol: string;
  weightPct: number;
  /** Movimiento del VALOR hoy, en %. */
  dayChangePct: number;
  /** Dinero de hoy en esta posición. */
  dayChangeAbs: number | null;
  /** Puntos porcentuales que esta posición aporta al movimiento del total. */
  contribPct: number;
};

/**
 * Índices de REFERENCIA del día. Viajan dentro de la MISMA llamada de quotes
 * que las posiciones (`getQuotesMap` va por símbolo con concurrencia 5), así
 * que su coste es dos símbolos más en un lote que ya se pide — cero fetches
 * nuevos y cero riesgo de que un sitio los pida y otro no.
 *
 * Los dos, no uno: SPY es la referencia estándar y QQQ es la que de verdad
 * se parece a este libro. Con sólo el S&P, un día en que la tecnológica cae
 * el doble que el índice ancho se lee como "algo pasa en tus valores" cuando
 * lo que pasa es el sector.
 *
 * ⚠️ NO es el benchmark del Signal Lab. Aquél está CONGELADO (SPY,
 * cierre-a-cierre sobre ajustados, dos fechas exactas) porque de él dependen
 * comparaciones históricas. Esto es contexto de UN día para una respuesta, y
 * no debe alimentar ninguna serie.
 */
export const MARKET_REF_SYMBOLS = ["SPY", "QQQ"] as const;

export type MarketRef = {
  symbol: string;
  dayChangePct: number;
  /** Cartera menos referencia, en puntos. Lo que NO explica el mercado. */
  excessPct: number | null;
};

/**
 * ¿Se movió TODO junto, o se movió UNA cosa? La pregunta que decide si la
 * respuesta correcta es "esto es mercado" o "esto es tu posición en X".
 *
 * Es un número, así que se calcula aquí. La alternativa —que el modelo lo
 * dedujera mirando siete porcentajes— es justo la atribución plausible y no
 * medida que este proyecto prohíbe en todo lo demás: suena igual de
 * convincente acierte o falle, y nadie la audita.
 */
export type DayBreadth = {
  down: number;
  up: number;
  /** Recorrido entre el que más cae y el que más sube, en puntos. Estrecho
   *  con casi todo en la misma dirección = se movieron a la vez. */
  spreadPct: number | null;
  /** Qué fracción del arrastre negativo TOTAL aporta el mayor lastre. Cerca
   *  de 1 = la caída ES esa posición; repartido = es el conjunto. `null`
   *  cuando no hay arrastre negativo que repartir. */
  topDragShare: number | null;
  /** Vacío si no se pudo cotizar ninguna referencia. Nunca bloquea. */
  refs: MarketRef[];
};

export type DayAttribution = {
  contributions: DayContribution[];
  /** Posiciones vivas que hoy NO tienen movimiento medible. Se devuelven en
   *  vez de omitirse: una respuesta "stock por stock" que se salta un valor
   *  en silencio deja al lector creyendo que ese valor no se movió. */
  unmeasured: string[];
  breadth: DayBreadth;
};

export function dayAttribution(
  p: Portfolio,
  /** El MISMO mapa de quotes con el que se valoró la cartera. Si trae las
   *  referencias, salen; si no, `refs` va vacío y la respuesta se da igual
   *  sin ellas — un 429 de Finnhub no puede costar la respuesta entera. */
  quotes: Record<string, QuoteLike | null> = {},
): DayAttribution {
  const contributions: DayContribution[] = [];
  const unmeasured: string[] = [];
  for (const pos of p.positions) {
    if (pos.dayChangePct === null || pos.weightPct === null) {
      unmeasured.push(pos.symbol);
      continue;
    }
    contributions.push({
      symbol: pos.symbol,
      weightPct: pos.weightPct,
      dayChangePct: pos.dayChangePct,
      dayChangeAbs: pos.dayChangeAbs,
      contribPct: (pos.dayChangePct * pos.weightPct) / 100,
    });
  }
  // Del que más resta al que más suma. El orden ES la respuesta: quien abre
  // la lista es el que explica el día.
  contributions.sort((a, b) => a.contribPct - b.contribPct);

  const down = contributions.filter((c) => c.dayChangePct < 0).length;
  const up = contributions.filter((c) => c.dayChangePct > 0).length;
  const moves = contributions.map((c) => c.dayChangePct);
  const spreadPct = moves.length ? Math.max(...moves) - Math.min(...moves) : null;

  // El arrastre total NEGATIVO, y qué parte de él viene del primero de la
  // lista. Se suman sólo los negativos a propósito: mezclar los que suben
  // diluiría el denominador y una cartera con un ganador grande parecería
  // "repartida" cuando su caída la produce un solo nombre.
  const drag = contributions
    .filter((c) => c.contribPct < 0)
    .reduce((acc, c) => acc + c.contribPct, 0);
  const topDragShare =
    drag < 0 && contributions[0].contribPct < 0
      ? contributions[0].contribPct / drag
      : null;

  const refs: MarketRef[] = [];
  for (const sym of MARKET_REF_SYMBOLS) {
    const q = quotes[sym];
    if (!q || typeof q.changePercent !== "number") continue;
    refs.push({
      symbol: sym,
      dayChangePct: q.changePercent,
      excessPct:
        p.dayChangePct !== null ? p.dayChangePct - q.changePercent : null,
    });
  }

  return {
    contributions,
    unmeasured,
    breadth: { down, up, spreadPct, topDragShare, refs },
  };
}
