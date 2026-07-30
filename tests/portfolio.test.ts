import { describe, expect, it } from "vitest";
import {
  addToPosition,
  CONCENTRATION,
  buildPortfolio,
  concentrationFlags,
  sectorWeights,
  sharesFromAmount,
  type Position,
  type QuoteLike,
} from "@/lib/portfolio";

// Matemática de cartera. Todo lo que se prueba aquí se PINTA en el rail y
// además viaja al prompt de la revisión, así que un error silencioso se
// convierte en un porcentaje falso que el modelo cita como hecho.

function pos(
  symbol: string,
  shares: number | null,
  avgCost: number | null,
  sector: string | null = "Tech",
): Position {
  return { symbol, name: null, sector, shares, avgCost };
}

function quote(price: number, changePercent = 0): QuoteLike {
  return { price, changePercent };
}

describe("buildPortfolio — los tres estados de shares", () => {
  const rows = [
    pos("A", 10, 100),
    pos("B", null, null),
    pos("C", 0, 50),
  ];
  const p = buildPortfolio(rows, { A: quote(150) });

  it("shares > 0 es posición viva", () => {
    expect(p.positions.map((x) => x.symbol)).toEqual(["A"]);
  });

  it("shares NULL es solo seguimiento, no posición cerrada", () => {
    expect(p.watchOnly.map((x) => x.symbol)).toEqual(["B"]);
    expect(p.closed.map((x) => x.symbol)).not.toContain("B");
  });

  it("shares 0 es posición cerrada, no seguimiento", () => {
    expect(p.closed.map((x) => x.symbol)).toEqual(["C"]);
    expect(p.watchOnly.map((x) => x.symbol)).not.toContain("C");
  });
});

describe("buildPortfolio — valoración y pesos", () => {
  it("valora y ordena por peso descendente", () => {
    const p = buildPortfolio(
      [pos("A", 10, 100), pos("B", 5, 200), pos("C", 2, null)],
      { A: quote(150), B: quote(100), C: quote(250) },
    );
    expect(p.totalValue).toBe(2500); // 1500 + 500 + 500
    expect(p.positions.map((x) => x.symbol)).toEqual(["A", "B", "C"]);
    expect(p.positions[0].weightPct).toBeCloseTo(60, 5);
  });

  it("los pesos suman 100", () => {
    const p = buildPortfolio(
      [pos("A", 3, 1), pos("B", 7, 1), pos("C", 11, 1)],
      { A: quote(13), B: quote(29), C: quote(7) },
    );
    const total = p.positions.reduce((acc, x) => acc + (x.weightPct ?? 0), 0);
    expect(total).toBeCloseTo(100, 6);
  });

  // ESTE es el test que importa. Si una posición no se puede valorar (429
  // de Finnhub Y de Yahoo, que pasa), contarla como 0 repartiría su peso
  // entre las demás e inflaría una concentración que no existe.
  it("una posición sin precio sale del DENOMINADOR, no cuenta como 0", () => {
    const p = buildPortfolio([pos("A", 10, 100), pos("B", 10, 100)], {
      A: quote(100),
      B: null,
    });
    expect(p.unpricedSymbols).toEqual(["B"]);
    expect(p.positions.find((x) => x.symbol === "B")?.weightPct).toBeNull();
    expect(p.positions.find((x) => x.symbol === "A")?.weightPct).toBeCloseTo(100, 5);
  });

  it("un precio 0 se trata como ausencia de precio", () => {
    const p = buildPortfolio([pos("A", 10, 100)], { A: quote(0) });
    expect(p.unpricedSymbols).toEqual(["A"]);
    expect(p.totalValue).toBe(0);
  });
});

describe("buildPortfolio — P&L", () => {
  it("sólo agrega posiciones que tienen valor Y coste", () => {
    // A: 1500 sobre 1000 (+500). B: 500 sobre 1000 (-500). C sin coste.
    const p = buildPortfolio(
      [pos("A", 10, 100), pos("B", 5, 200), pos("C", 2, null)],
      { A: quote(150), B: quote(100), C: quote(250) },
    );
    expect(p.totalCost).toBe(2000);
    expect(p.totalUnrealizedAbs).toBe(0);
    expect(p.totalUnrealizedPct).toBeCloseTo(0, 6);
    expect(p.noCostSymbols).toEqual(["C"]);
  });

  it("una posición sin coste no reporta P&L propio", () => {
    const p = buildPortfolio([pos("A", 2, null)], { A: quote(250) });
    expect(p.positions[0].unrealizedPct).toBeNull();
    expect(p.positions[0].costBasis).toBeNull();
    expect(p.totalUnrealizedPct).toBeNull();
  });

  it("calcula el P&L porcentual por posición", () => {
    const p = buildPortfolio([pos("A", 10, 100)], { A: quote(125) });
    expect(p.positions[0].unrealizedPct).toBeCloseTo(25, 6);
    expect(p.positions[0].unrealizedAbs).toBeCloseTo(250, 6);
  });
});

describe("buildPortfolio — movimiento del día", () => {
  it("pondera por peso, no hace media simple", () => {
    // A pesa 60% y sube 2%; B pesa 20% y baja 1%; C pesa 20% y no se mueve.
    // Ponderado = 1.2 - 0.2 + 0 = 1.0. La media simple daría 0.33.
    const p = buildPortfolio(
      [pos("A", 10, 100), pos("B", 5, 200), pos("C", 2, 100)],
      { A: quote(150, 2), B: quote(100, -1), C: quote(250, 0) },
    );
    expect(p.dayChangePct).toBeCloseTo(1.0, 6);
  });

  it("es null cuando ningún quote trae variación", () => {
    const p = buildPortfolio([pos("A", 1, 1)], { A: null });
    expect(p.dayChangePct).toBeNull();
  });
});

describe("dinero ganado o perdido hoy", () => {
  it("usa el cierre anterior declarado por la fuente", () => {
    // 10 acciones de 100 a 110 = +100 hoy.
    const p = buildPortfolio([pos("A", 10, 50)], {
      A: { price: 110, changePercent: 10, prevClose: 100 },
    });
    expect(p.positions[0].dayChangeAbs).toBeCloseTo(100, 6);
    expect(p.dayChangeAbs).toBeCloseTo(100, 6);
  });

  // Sin prevClose el resultado tiene que seguir siendo correcto, sólo que
  // arrastrando el redondeo del porcentaje — de ahí que se prefiera el
  // valor declarado cuando existe.
  it("lo deriva del porcentaje cuando la fuente no lo trae", () => {
    const p = buildPortfolio([pos("A", 10, 50)], {
      A: { price: 110, changePercent: 10 },
    });
    expect(p.positions[0].dayChangeAbs).toBeCloseTo(100, 6);
  });

  it("el total en dinero es suma directa, no ponderada", () => {
    // A: 10×(110-100) = +100. B: 5×(90-100) = -50. Total +50.
    const p = buildPortfolio([pos("A", 10, 1), pos("B", 5, 1)], {
      A: { price: 110, changePercent: 10, prevClose: 100 },
      B: { price: 90, changePercent: -10, prevClose: 100 },
    });
    expect(p.dayChangeAbs).toBeCloseTo(50, 6);
  });

  it("una posición sin precio no aporta ni rompe el total", () => {
    const p = buildPortfolio([pos("A", 10, 1), pos("B", 5, 1)], {
      A: { price: 110, changePercent: 10, prevClose: 100 },
      B: null,
    });
    expect(p.positions.find((x) => x.symbol === "B")?.dayChangeAbs).toBeNull();
    expect(p.dayChangeAbs).toBeCloseTo(100, 6);
  });

  it("es null si ninguna posición se pudo valorar", () => {
    expect(buildPortfolio([pos("A", 10, 1)], { A: null }).dayChangeAbs).toBeNull();
  });

  it("un cierre anterior de 0 no genera un infinito", () => {
    const p = buildPortfolio([pos("A", 10, 1)], {
      A: { price: 110, changePercent: -100 },
    });
    expect(p.positions[0].dayChangeAbs).toBeNull();
  });
});

describe("sharesFromAmount", () => {
  it("convierte importe invertido en acciones", () => {
    expect(sharesFromAmount(500, 125)).toBe(4);
  });

  it("admite fracciones", () => {
    expect(sharesFromAmount(500, 120)).toBeCloseTo(4.1667, 4);
  });

  it("rechaza precio 0 o negativo en vez de devolver infinito", () => {
    expect(sharesFromAmount(500, 0)).toBeNull();
    expect(sharesFromAmount(500, -10)).toBeNull();
  });

  it("rechaza importes negativos y valores no numéricos", () => {
    expect(sharesFromAmount(-500, 120)).toBeNull();
    expect(sharesFromAmount(Number.NaN, 120)).toBeNull();
  });

  // La conversión tiene que cerrar el círculo: si se guarda lo derivado, el
  // coste que la tabla vuelve a mostrar debe ser el importe original.
  it("va y vuelve: importe → acciones → costBasis", () => {
    const shares = sharesFromAmount(750, 37.5)!;
    const p = buildPortfolio([pos("A", shares, 37.5)], { A: quote(40) });
    expect(p.positions[0].costBasis).toBeCloseTo(750, 6);
  });
});

describe("sectorWeights", () => {
  it("agrupa lo no clasificado en Unknown en vez de descartarlo", () => {
    const p = buildPortfolio(
      [pos("A", 1, null, "Tech"), pos("B", 1, null, null), pos("C", 1, null, "  ")],
      { A: quote(100), B: quote(100), C: quote(100) },
    );
    const s = sectorWeights(p.positions);
    const unknown = s.find((x) => x.sector === "Unknown");
    expect(unknown?.symbols.sort()).toEqual(["B", "C"]);
    expect(s.reduce((acc, x) => acc + x.weightPct, 0)).toBeCloseTo(100, 6);
  });

  it("ordena por peso descendente", () => {
    const p = buildPortfolio(
      [pos("A", 1, null, "Tech"), pos("B", 3, null, "Energy")],
      { A: quote(100), B: quote(100) },
    );
    expect(sectorWeights(p.positions)[0].sector).toBe("Energy");
  });
});

describe("concentrationFlags", () => {
  // Sectores DISTINTOS por defecto: si todas cayeran en el mismo, saltaría
  // además el warn sectorial y estos casos dejarían de aislar la regla de
  // recuento que quieren comprobar.
  function equalWeight(n: number, sector: (i: number) => string | null = (i) => `Sec${i}`) {
    const rows = Array.from({ length: n }, (_, i) => pos(`S${i}`, 1, null, sector(i)));
    const quotes = Object.fromEntries(rows.map((r) => [r.symbol, quote(100)]));
    return buildPortfolio(rows, quotes);
  }

  it("una cartera vacía no declara concentración", () => {
    expect(concentrationFlags(buildPortfolio([], {}))).toEqual([]);
  });

  // La regla de fondo: no gritar por lo inevitable. Con 3 nombres
  // equiponderados cada uno pesa 33% — avisar de los tres no informa.
  it("en carteras pequeñas avisa del RECUENTO, no de cada posición", () => {
    const flags = concentrationFlags(equalWeight(3));
    expect(flags).toHaveLength(1);
    expect(flags[0].label).toBe("3 posiciones");
    expect(flags.some((f) => f.label === "S0")).toBe(false);
  });

  it("dos posiciones es warn; cuatro sigue siendo info", () => {
    const dos = concentrationFlags(equalWeight(2)).find((f) => f.kind === "position");
    const cuatro = concentrationFlags(equalWeight(4)).find((f) => f.kind === "position");
    expect(dos?.level).toBe("warn");
    expect(cuatro?.level).toBe("info");
  });

  it("una cartera pequeña Y toda en un sector declara las dos cosas", () => {
    const flags = concentrationFlags(equalWeight(3, () => "Technology"));
    expect(flags.find((f) => f.kind === "position")?.label).toBe("3 posiciones");
    expect(flags.find((f) => f.kind === "sector")?.level).toBe("warn");
  });

  it("con 5+ posiciones equiponderadas no hay bandera de posición", () => {
    const flags = concentrationFlags(equalWeight(8, () => null));
    expect(flags.filter((f) => f.kind === "position")).toEqual([]);
  });

  it("marca warn la posición por encima del umbral", () => {
    // A = 40%, resto 15% cada una (5 posiciones).
    const rows = [pos("A", 40, null), ...Array.from({ length: 4 }, (_, i) => pos(`S${i}`, 15, null))];
    const quotes = Object.fromEntries(rows.map((r) => [r.symbol, quote(1)]));
    const flags = concentrationFlags(buildPortfolio(rows, quotes));
    const a = flags.find((f) => f.label === "A");
    expect(a?.level).toBe("warn");
    expect(a?.weightPct).toBeCloseTo(40, 5);
  });

  it("no cuenta dos veces la misma noticia: sin warn de 'las 3 mayores' si ya lo hay de una posición", () => {
    const rows = [pos("A", 40, null), pos("B", 25, null), pos("C", 20, null), pos("D", 8, null), pos("E", 7, null)];
    const quotes = Object.fromEntries(rows.map((r) => [r.symbol, quote(1)]));
    const flags = concentrationFlags(buildPortfolio(rows, quotes));
    expect(flags.some((f) => f.label === "A" && f.level === "warn")).toBe(true);
    expect(flags.some((f) => f.label === "las 3 mayores")).toBe(false);
  });

  it("detecta concentración repartida que ninguna posición dispara sola", () => {
    // 25+25+24 = 74% en las tres mayores, ninguna llega al umbral de warn.
    const rows = [pos("A", 25, null), pos("B", 25, null), pos("C", 24, null), pos("D", 13, null), pos("E", 13, null)];
    const quotes = Object.fromEntries(rows.map((r) => [r.symbol, quote(1)]));
    const flags = concentrationFlags(buildPortfolio(rows, quotes));
    const top3 = flags.find((f) => f.label === "las 3 mayores");
    expect(top3?.level).toBe("warn");
    expect(top3?.weightPct).toBeCloseTo(74, 5);
  });

  it("marca el sector dominante", () => {
    const rows = [
      pos("A", 60, null, "Technology"),
      pos("B", 10, null, "Energy"),
      pos("C", 10, null, "Banking"),
      pos("D", 10, null, "Health"),
      pos("E", 10, null, "Media"),
    ];
    const quotes = Object.fromEntries(rows.map((r) => [r.symbol, quote(1)]));
    const flags = concentrationFlags(buildPortfolio(rows, quotes));
    const tech = flags.find((f) => f.kind === "sector" && f.label === "Technology");
    expect(tech?.level).toBe("warn");
    expect(tech?.weightPct).toBeGreaterThanOrEqual(CONCENTRATION.sectorWarn);
  });

  it("'Unknown' no cuenta como sector concentrado; sale como calidad de dato", () => {
    const flags = concentrationFlags(equalWeight(8, () => null));
    expect(flags.some((f) => f.kind === "sector")).toBe(false);
    const unclassified = flags.find((f) => f.kind === "unclassified");
    expect(unclassified?.weightPct).toBeCloseTo(100, 5);
    expect(unclassified?.level).toBe("info");
  });

  it("pone los warn primero y dentro de cada nivel lo más pesado antes", () => {
    const rows = [
      pos("A", 45, null, "Technology"),
      pos("B", 22, null, "Energy"),
      pos("C", 15, null, "Energy"),
      pos("D", 10, null, "Health"),
      pos("E", 8, null, "Media"),
    ];
    const quotes = Object.fromEntries(rows.map((r) => [r.symbol, quote(1)]));
    const flags = concentrationFlags(buildPortfolio(rows, quotes));
    const levels = flags.map((f) => f.level);
    expect(levels.indexOf("info") === -1 || levels.lastIndexOf("warn") < levels.indexOf("info")).toBe(true);
    const warns = flags.filter((f) => f.level === "warn");
    for (let i = 1; i < warns.length; i++) {
      expect(warns[i - 1].weightPct).toBeGreaterThanOrEqual(warns[i].weightPct);
    }
  });
});

describe("addToPosition — reforzar una posición", () => {
  it("promedia ponderando por ACCIONES, no por operaciones", () => {
    // 100 a 300 más 10 a 500 no da 400: da 318,18. Promediar las dos
    // operaciones a partes iguales es el error clásico de hacerlo a mano, y
    // es justo la cuenta que este formulario existe para no pedirte.
    const r = addToPosition({ shares: 100, avgCost: 300 }, { shares: 10, price: 500 });
    expect(r.shares).toBe(110);
    expect(r.avgCost!).toBeCloseTo(318.18, 2);
    expect(r.avgCostUnknown).toBe(false);
  });

  it("abre posición desde solo-seguimiento: el coste ES el de esta compra", () => {
    // shares null = se sigue pero no se tiene. No hay historia anterior
    // cuyo coste se desconozca, así que aquí sí se puede afirmar.
    const r = addToPosition({ shares: null, avgCost: null }, { shares: 8, price: 712.4 });
    expect(r.shares).toBe(8);
    expect(r.avgCost).toBe(712.4);
    expect(r.avgCostUnknown).toBe(false);
  });

  it("reabre una posición cerrada (shares 0) igual que una nueva", () => {
    const r = addToPosition({ shares: 0, avgCost: 250 }, { shares: 5, price: 100 });
    expect(r.shares).toBe(5);
    // El coste medio viejo NO arrastra: no queda ninguna acción de aquéllas.
    expect(r.avgCost).toBe(100);
  });

  it("NO inventa el coste medio cuando la posición no tenía coste registrado", () => {
    // El caso peligroso. Poner 500 afirmaría que pagaste 500 por las 100
    // acciones viejas también, y ese número alimenta P&L, pesos y las
    // presiones que deciden si /ask te dice que recortes. Fabricado y
    // plausible es la peor combinación: nadie lo audita.
    const r = addToPosition({ shares: 100, avgCost: null }, { shares: 10, price: 500 });
    expect(r.shares).toBe(110);
    expect(r.avgCost).toBeNull();
    expect(r.avgCostUnknown).toBe(true);
  });

  it("dos refuerzos seguidos dan lo mismo que la media global", () => {
    // Propiedad que tiene que cumplirse para que el registro incremental
    // sea equivalente a haberlo apuntado todo de golpe.
    const a = addToPosition({ shares: 10, avgCost: 100 }, { shares: 10, price: 200 });
    const b = addToPosition(a, { shares: 20, price: 300 });
    expect(b.shares).toBe(40);
    // (10*100 + 10*200 + 20*300) / 40 = 225
    expect(b.avgCost!).toBeCloseTo(225, 6);
  });

  it("admite fracciones de acción, que es como compra un bróker moderno", () => {
    const r = addToPosition(
      { shares: 2.387774594078319, avgCost: 376.92 },
      { shares: 0.5, price: 445 },
    );
    expect(r.shares).toBeCloseTo(2.887774594078319, 9);
    expect(r.avgCost!).toBeGreaterThan(376.92);
    expect(r.avgCost!).toBeLessThan(445);
  });
});
