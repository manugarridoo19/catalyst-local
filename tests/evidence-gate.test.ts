import { describe, expect, it } from "vitest";
import {
  applyEvidenceGate,
  reviewPressures,
  type PositionVerdict,
} from "@/lib/ai/portfolio-review";
import { buildPortfolio } from "@/lib/portfolio";
import type { PortfolioRetrieval } from "@/lib/ask/portfolio";

// El gate es la regla editorial convertida en código: una postura sobre una
// posición vale si —y sólo si— la sostiene una cita que hable de ESE valor o
// un hecho duro declarado ante el regulador. El prompt también lo pide, pero
// un modelo puede ignorar una instrucción y no puede ignorar un filtro.

function facts(symbol: string, over: Partial<Record<string, unknown>> = {}) {
  return {
    symbol,
    insiderNet7d: 0,
    insiderNet30d: 0,
    insiderBuyers30d: 0,
    insiderSellers30d: 0,
    stakes: [],
    nextEarnings: null,
    earningsHour: null,
    signals: [],
    beta: null,
    pe: null,
    news7d: 0,
    avgSentiment7d: null,
    newsPrior7d: 0,
    avgSentimentPrior7d: null,
    daysToCover: null,
    citationNums: [],
    ...over,
  };
}

function citation(n: number, symbols: string[]) {
  return {
    n,
    newsId: n,
    headline: `titular ${n}`,
    summary: null,
    url: `https://example.test/${n}`,
    source: "test",
    symbols,
    publishedAt: "2026-07-25T00:00:00Z",
    impact: 3,
    sentiment: 0,
    via: "forward" as const,
  };
}

function retrieval(over: Partial<PortfolioRetrieval> = {}): PortfolioRetrieval {
  const symbols = ["AAA", "BBB", "CCC"];
  const portfolio = buildPortfolio(
    symbols.map((s) => ({ symbol: s, name: null, sector: null, shares: 1, avgCost: null })),
    Object.fromEntries(symbols.map((s) => [s, { price: 10, changePercent: 0 }])),
  );
  return {
    portfolio,
    facts: symbols.map((s) => facts(s)),
    citations: [citation(1, ["AAA"]), citation(2, ["CCC"])],
    calendar: [],
    derived: { weightedBeta: null, betaCoveragePct: 0, earningsClusters: [] },
    forward: {
      candidates: [], earningsBars: [], sellers: [], deals: [],
      harvested: 0, attempted: 0, bodiesAvailable: 0,
    },
    concentration: [],
    blindSpots: [],
    ...over,
  } as PortfolioRetrieval;
}

function verdict(over: Partial<PositionVerdict> = {}): PositionVerdict {
  return { symbol: "AAA", stance: "watch", why: "porque sí", used: [], ...over };
}

describe("applyEvidenceGate — qué entra", () => {
  it("descarta símbolos que no están en la cartera", () => {
    const out = applyEvidenceGate([verdict({ symbol: "ZZZ", used: [1] })], retrieval());
    expect(out).toEqual([]);
  });

  it("una cita válida del propio símbolo sostiene la postura", () => {
    const out = applyEvidenceGate([verdict({ symbol: "AAA", used: [1] })], retrieval());
    expect(out[0].stance).toBe("watch");
    expect(out[0].used).toEqual([1]);
    expect(out[0].degraded).toBeUndefined();
  });

  it("limpia números de cita inexistentes", () => {
    const out = applyEvidenceGate([verdict({ symbol: "AAA", used: [1, 99] })], retrieval());
    expect(out[0].used).toEqual([1]);
  });

  // El caso real: el modelo colgó de META la cita del Iridium de RKLB. El
  // número existía, así que un filtro de "cita válida" lo dejaba pasar — y
  // una cita que no sostiene lo que acompaña es peor que ninguna, porque
  // parece verificación.
  it("rechaza la cita que no menciona ese símbolo (atribución cruzada)", () => {
    const out = applyEvidenceGate([verdict({ symbol: "AAA", used: [2] })], retrieval());
    expect(out[0].used).toEqual([]);
    expect(out[0].stance).toBe("none");
    expect(out[0].degraded).toBe(true);
  });
});

describe("applyEvidenceGate — qué cuenta como hecho duro", () => {
  const duros = [
    ["venta neta de insiders a 30d", { insiderNet30d: -1_000_000 }],
    ["compra neta de insiders a 7d", { insiderNet7d: 500_000 }],
    ["un 13D/G declarado", { stakes: [{ filer: "F", pct: 6, filedAt: "2026-07-01" }] }],
    ["una señal del Lab", { signals: [{ kind: "ai_pick", label: "AI Pick", detectedAt: "2026-07-01", matured: false }] }],
    ["days-to-cover alto", { daysToCover: 7 }],
  ] as const;

  for (const [nombre, over] of duros) {
    it(`${nombre} sostiene una postura SIN cita`, () => {
      const r = retrieval({ facts: [facts("AAA", over as Record<string, unknown>)] });
      const out = applyEvidenceGate([verdict({ symbol: "AAA", used: [] })], r);
      expect(out[0].stance).toBe("watch");
      expect(out[0].degraded).toBeUndefined();
    });
  }

  // LA FECHA DE RESULTADOS NO ES UN HECHO DURO, y esta aserción está en
  // desacuerdo a propósito con la lista de arriba.
  //
  // El SYSTEM_PROMPT de la revisión lo dice en mayúsculas ("QUE UNA EMPRESA
  // PRESENTE RESULTADOS NO ES MOTIVO DE POSTURA… si lo único que tienes es su
  // fecha y su consenso, OMÍTELA"), pero el gate la aceptaba como respaldo
  // suficiente. En temporada de resultados TODAS las posiciones tienen fecha,
  // así que el filtro que debía degradar a "none" no se activaba nunca justo
  // cuando más ruido había: el gate le daba por bueno al modelo exactamente
  // lo que el prompt le prohibía. La fecha sigue viajando en watchNext y en
  // el calendario, que es donde el prompt la quiere.
  it("una fecha de resultados NO sostiene una postura por sí sola", () => {
    const r = retrieval({ facts: [facts("AAA", { nextEarnings: "2026-08-01" })] });
    const out = applyEvidenceGate([verdict({ symbol: "AAA", used: [] })], r);
    expect(out[0].stance).toBe("none");
    expect(out[0].degraded).toBe(true);
  });

  it("pero la fecha NO estorba cuando hay un hecho duro de verdad", () => {
    const r = retrieval({
      facts: [facts("AAA", { nextEarnings: "2026-08-01", insiderNet30d: -1_000_000 })],
    });
    const out = applyEvidenceGate([verdict({ symbol: "AAA", used: [] })], r);
    expect(out[0].stance).toBe("watch");
    expect(out[0].degraded).toBeUndefined();
  });

  // Los agregados blandos justifican cualquier cosa ("mucha atención
  // mediática", "sentimiento tibio"), así que deliberadamente NO cuentan.
  it("cobertura y sentimiento NO son evidencia suficiente", () => {
    const r = retrieval({
      facts: [facts("AAA", { news7d: 140, avgSentiment7d: 1.8, daysToCover: 1.2 })],
    });
    const out = applyEvidenceGate([verdict({ symbol: "AAA", used: [] })], r);
    expect(out[0].stance).toBe("none");
    expect(out[0].degraded).toBe(true);
  });

  it("una postura degradada se conserva y se marca, no se borra", () => {
    const out = applyEvidenceGate(
      [verdict({ symbol: "AAA", why: "buenas vibraciones", used: [] })],
      retrieval(),
    );
    expect(out).toHaveLength(1);
    expect(out[0].why).toContain("buenas vibraciones");
    expect(out[0].degraded).toBe(true);
  });
});

describe("applyEvidenceGate — marcadores [n] escritos dentro del texto", () => {
  it("los extrae, los fusiona con used y los limpia del texto", () => {
    const out = applyEvidenceGate(
      [verdict({ symbol: "AAA", why: "el consejero vendió 5 veces [1]", used: [] })],
      retrieval(),
    );
    expect(out[0].why).not.toContain("[1]");
    expect(out[0].used).toEqual([1]);
  });

  it("entiende varios números en un solo marcador", () => {
    const r = retrieval({ citations: [citation(1, ["AAA"]), citation(4, ["AAA"])] });
    const out = applyEvidenceGate(
      [verdict({ symbol: "AAA", why: "dos fuentes lo dicen [1, 4]", used: [] })],
      r,
    );
    expect(out[0].used.sort()).toEqual([1, 4]);
    expect(out[0].why).not.toMatch(/\[/);
  });

  it("no duplica un número que ya venía en used", () => {
    const out = applyEvidenceGate(
      [verdict({ symbol: "AAA", why: "lo dice la fuente [1]", used: [1] })],
      retrieval(),
    );
    expect(out[0].used).toEqual([1]);
  });

  it("deja la puntuación limpia tras quitar el marcador", () => {
    const out = applyEvidenceGate(
      [verdict({ symbol: "AAA", why: "vendió 5 veces [1], y le quedan 81.109 [1]", used: [] })],
      retrieval(),
    );
    expect(out[0].why).toBe("vendió 5 veces, y le quedan 81.109.");
  });

  // Un marcador cruzado dentro del texto tiene que caer igual que uno en
  // `used`: si no, bastaría escribirlo en la frase para saltarse el gate.
  it("un marcador en línea de otro símbolo tampoco sostiene", () => {
    const out = applyEvidenceGate(
      [verdict({ symbol: "AAA", why: "algo sobre otra empresa [2]", used: [] })],
      retrieval(),
    );
    expect(out[0].used).toEqual([]);
    expect(out[0].degraded).toBe(true);
  });
});

describe("reviewPressures — el suelo compartido con /ask", () => {
  // El caso que motivó la función: /ask decía AGUANTAR SOFI por la presión
  // de recorte de la beta y la revisión recomendaba "reforzar" el mismo
  // día — no por criterio, sino porque nunca recibió esa presión. Estas
  // aserciones fijan que las dos superficies ven los mismos lados.
  it("la beta alta de una posición viva empuja a recortar, igual que en /ask", () => {
    const r = retrieval({
      facts: [facts("AAA", { beta: 2.15 }), facts("BBB"), facts("CCC")],
    });
    const beta = reviewPressures(r).find((p) => p.text.includes("beta"));
    expect(beta?.side).toBe("trim");
    expect(beta?.symbol).toBe("AAA");
  });

  it("las compras netas de insiders empujan a AMPLIAR, no a aguantar", () => {
    const r = retrieval({
      facts: [
        facts("AAA", { insiderNet30d: 2_000_000, insiderBuyers30d: 2 }),
        facts("BBB"),
        facts("CCC"),
      ],
    });
    const ins = reviewPressures(r).find((p) => p.text.includes("insiders"));
    expect(ins?.side).toBe("add");
  });

  it("sin derivada del interés corto medida, no se afirma estabilidad", () => {
    // Este retrieval no trae shortChangePct: el adaptador pasa null y el
    // texto debe OMITIR la comparación, no fabricar un "estable".
    const r = retrieval({
      facts: [facts("AAA", { daysToCover: 7.2 }), facts("BBB"), facts("CCC")],
    });
    const dtc = reviewPressures(r).find((p) => p.text.includes("days-to-cover"));
    expect(dtc?.side).toBe("neutral");
    expect(dtc?.text).not.toContain("estable");
  });

  it("cartera vacía devuelve cero presiones en vez de inventar contexto", () => {
    const vacio = retrieval();
    vacio.portfolio.positions = [];
    expect(reviewPressures(vacio)).toEqual([]);
  });
});
