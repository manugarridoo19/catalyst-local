import { describe, expect, it } from "vitest";
import { DECISION_NOISE, classifyIntent, normalizeQuestion } from "@/lib/ask/intent";
import {
  DECISION_THRESHOLDS,
  buildDecisionFacts,
  daysUntil,
  hasDecisionEvidence,
  positionContexts,
} from "@/lib/ask/decision";
import { answerShape, cleanBrackets, orderDecisionSections } from "@/lib/ai/ask";
import { keywords, looksLikeDeal } from "@/lib/ask/retrieve";
import type { Retrieval, StructuredFacts } from "@/lib/ask/retrieve";
import type { Portfolio } from "@/lib/portfolio";

// Lo que fijan estos tests es la frontera entre las DOS clases de pregunta.
// Equivocarla en un sentido devuelve el párrafo genérico que motivó todo
// esto; equivocarla en el otro despliega "a favor de recortar" sobre una
// consulta de archivo. Ninguno de los dos fallos hace ruido en producción:
// los dos se leen como una respuesta razonable.

describe("classifyIntent", () => {
  it("clasifica como decisión la pregunta que abrió la sesión", () => {
    expect(
      classifyIntent("¿es buena idea dejar correr $MSFT o mejor vendemos una parte hoy?"),
    ).toBe("decision");
  });

  it("NO clasifica como decisión una pregunta de archivo con un verbo de acción dentro", () => {
    // Es una de las tres preguntas de ejemplo de la propia UI y lleva
    // "buying". Sin el requisito de primera persona entraría en modo
    // decisión y contestaría con bloques de aguantar/recortar sobre unos
    // insiders que no son el usuario.
    expect(classifyIntent("What are insiders buying lately?")).toBe("archive");
    expect(classifyIntent("¿Hubo mucha venta de directivos en NVDA?")).toBe("archive");
    expect(classifyIntent("¿Qué se dijo de la compra de Iridium?")).toBe("archive");
  });

  it("acepta el juicio impersonal y la primera persona por separado", () => {
    expect(classifyIntent("¿conviene vender AAPL antes de resultados?")).toBe("decision");
    expect(classifyIntent("¿aguanto $RKLB hasta el cierre de la operación?")).toBe("decision");
    expect(classifyIntent("should i sell NVDA before earnings?")).toBe("decision");
    expect(classifyIntent("is it worth holding TSLA?")).toBe("decision");
  });

  it("no se despista con tildes ni mayúsculas", () => {
    expect(normalizeQuestion("¿Qué HAGO con mi posición?")).toBe(
      "¿que hago con mi posicion?",
    );
    expect(classifyIntent("¿QUÉ HAGO CON MI POSICIÓN EN $SOFI, la amplío?")).toBe(
      "decision",
    );
  });

  it("una pregunta sin verbo de acción nunca es decisión", () => {
    expect(classifyIntent("¿Qué se dijo de NVDA esta semana?")).toBe("archive");
    expect(classifyIntent("¿Hay algún 13D nuevo?")).toBe("archive");
  });
});

describe("keywords", () => {
  it("purga el vocabulario de decisión del canal léxico", () => {
    const q = "¿es buena idea dejar correr $MSFT o mejor vendemos una parte hoy?";
    // Con las 6 plazas ocupadas por el vocabulario de la duda, el ILIKE
    // buscaba "correr" y "parte" en los titulares: ruido puro.
    expect(keywords(q, "archive")).toContain("buena");
    expect(keywords(q, "decision")).not.toContain("buena");
    expect(keywords(q, "decision")).not.toContain("correr");
    expect(keywords(q, "decision")).not.toContain("vendemos");
  });

  it("conserva lo que sí nombra algo del mundo", () => {
    const terms = keywords("¿vendo $SOFI antes de los resultados?", "decision");
    expect(terms).toContain("resultados");
  });
});

describe("isCommonWord (vía DECISION_NOISE)", () => {
  it("'idea' está en la lista: es el alias real que coló IACO", () => {
    // Medido el 2026-07-30: "¿es buena IDEA dejar correr $MSFT…?" consultaba
    // IACO, cuyo alias en `ticker_aliases` es "Idea", y le colgaba
    // agregados SQL y presiones a una empresa ajena a la pregunta. El
    // filtro vive en retrieve.ts sobre esta lista; si alguien la vacía,
    // esto lo dice antes de que vuelva a pasar en producción.
    expect(DECISION_NOISE.has("idea")).toBe(true);
    expect(DECISION_NOISE.has("parte")).toBe(true);
    expect(DECISION_NOISE.has("mejor")).toBe(true);
  });
});

describe("cleanBrackets", () => {
  it("conserva los marcadores de cita", () => {
    expect(cleanBrackets("Azure creció un 43% [1] y el objetivo sube [5, 9].")).toBe(
      "Azure creció un 43% [1] y el objetivo sube [5, 9].",
    );
  });

  it("borra el volcado del prompt que el modelo devolvía como si fuera cita", () => {
    // Caso literal de la primera prueba real: tres de cinco secciones
    // cerraban pegando la línea de YOUR POSITION entre corchetes. Se lee
    // como una fuente verificable y es el propio prompt devuelto al lector.
    const raw =
      "Conviene recortar por encima del umbral del 25% [MSFT: peso 27.6% de la cartera · valor 1063$ · coste medio 376.92$].";
    expect(cleanBrackets(raw)).toBe(
      "Conviene recortar por encima del umbral del 25%.",
    );
  });

  it("borra también el corchete con fecha dentro", () => {
    expect(cleanBrackets("Reporta el 27 de octubre [2026-10-27 · MSFT: resultados].")).toBe(
      "Reporta el 27 de octubre.",
    );
  });
});

describe("answerShape", () => {
  it("la intención manda sobre el material", () => {
    // Una decisión con archivo pobre sigue queriendo forma de decisión: la
    // respuesta honesta es "no da para inclinarse, esto es lo que falta",
    // que RESPONDE. Caer a prosa aquí devolvía el párrafo genérico.
    const r: Retrieval = {
      symbols: ["MSFT"],
      intent: "decision",
      citations: [],
      facts: [],
      earnings: [],
      forward: { bars: [], sellers: [], deals: [], risk: [] },
      vectorUsed: true,
      harvested: 0,
      attempted: 0,
      bodiesAvailable: 0,
    };
    expect(answerShape(r)).toBe("decision");
  });
});

describe("orderDecisionSections", () => {
  it("recoloca la postura al frente venga como venga del modelo", () => {
    // La cadena de fallback llega hasta llama-3.1-8b y devuelve las claves
    // en cualquier orden. Abrir con "LO QUE NO SÉ" se lee como una evasiva.
    const out = orderDecisionSections([
      { key: "unknown", title: "LO QUE NO SÉ", text: "c" },
      { key: "trim", title: "RECORTAR", text: "b" },
      { key: "stance", title: "POSTURA", text: "a" },
    ]);
    expect(out.map((s) => s.key)).toEqual(["stance", "trim", "unknown"]);
  });

  it("conserva las claves desconocidas al final en vez de tirarlas", () => {
    const out = orderDecisionSections([
      { key: "other", title: null, text: "x" },
      { key: "stance", title: "POSTURA", text: "a" },
    ]);
    expect(out.map((s) => s.key)).toEqual(["stance", "other"]);
  });
});

function portfolio(over: Partial<Portfolio> = {}): Portfolio {
  return {
    positions: [],
    watchOnly: [],
    closed: [],
    totalValue: 0,
    totalCost: 0,
    totalUnrealizedAbs: null,
    totalUnrealizedPct: null,
    dayChangePct: null,
    dayChangeAbs: null,
    sectors: [],
    unpricedSymbols: [],
    noCostSymbols: [],
    ...over,
  };
}

function facts(over: Partial<StructuredFacts> = {}): StructuredFacts {
  return {
    symbol: "MSFT",
    name: "Microsoft",
    insiderNet7d: null,
    insiderNet30d: null,
    insiderBuyers30d: 0,
    insiderSellers30d: 0,
    stakes: [],
    nextEarnings: null,
    nextEarningsHour: null,
    nextEarningsEps: null,
    nextEarningsRevenue: null,
    lastPick: null,
    newsCount7d: 0,
    avgSentiment7d: null,
    ...over,
  };
}

const MSFT_POSITION = {
  symbol: "MSFT",
  name: "Microsoft",
  sector: "Technology",
  shares: 100,
  avgCost: 300,
  price: 500,
  dayChangePct: 1,
  dayChangeAbs: 500,
  marketValue: 50_000,
  costBasis: 30_000,
  unrealizedAbs: 20_000,
  unrealizedPct: 66.7,
  weightPct: 34,
};

describe("positionContexts", () => {
  it("distingue tener de seguir", () => {
    const p = portfolio({ positions: [MSFT_POSITION], totalValue: 147_000 });
    const [msft, rklb] = positionContexts(["MSFT", "RKLB"], p);
    expect(msft.held).toBe(true);
    expect(msft.weightPct).toBe(34);
    expect(rklb.held).toBe(false);
    expect(rklb.weightPct).toBeNull();
  });

  it("sin cartera devuelve vacío en vez de inventar contexto", () => {
    expect(positionContexts(["MSFT"], null)).toEqual([]);
  });
});

describe("buildDecisionFacts", () => {
  it("una posición sobre el umbral genera presión de recorte con su cifra", () => {
    const d = buildDecisionFacts({
      symbols: ["MSFT"],
      portfolio: portfolio({ positions: [MSFT_POSITION], totalValue: 147_000 }),
      facts: [facts()],
    });
    const trim = d.pressures.filter((p) => p.side === "trim");
    expect(trim).toHaveLength(1);
    expect(trim[0].text).toContain("34.0%");
    expect(trim[0].text).toContain(String(DECISION_THRESHOLDS.weightTrimPct));
  });

  it("una posición pequeña empuja al OTRO lado: recortar ahí no cambia nada", () => {
    const d = buildDecisionFacts({
      symbols: ["MSFT"],
      portfolio: portfolio({
        positions: [{ ...MSFT_POSITION, weightPct: 2 }],
        totalValue: 500_000,
      }),
      facts: [facts()],
    });
    expect(d.pressures.some((p) => p.side === "hold")).toBe(true);
    expect(d.pressures.some((p) => p.side === "trim")).toBe(false);
  });

  it("la plusvalía grande NO toma partido", () => {
    // Es argumento de los dos bandos según a quién se le pregunte, y
    // asignarle lado sería la opinión colándose disfrazada de dato.
    const d = buildDecisionFacts({
      symbols: ["MSFT"],
      portfolio: portfolio({ positions: [MSFT_POSITION], totalValue: 147_000 }),
      facts: [facts()],
    });
    const gain = d.pressures.find((p) => p.text.includes("Plusvalía") || p.text.includes("plusvalía"));
    expect(gain?.side).toBe("neutral");
  });

  it("el flujo insider bajo el umbral no entra: sería ruido con aplomo", () => {
    const bajo = buildDecisionFacts({
      symbols: ["MSFT"],
      portfolio: null,
      facts: [facts({ insiderNet30d: -50_000, insiderSellers30d: 1 })],
    });
    expect(bajo.pressures.some((p) => p.text.includes("insiders"))).toBe(false);

    const alto = buildDecisionFacts({
      symbols: ["MSFT"],
      portfolio: null,
      facts: [facts({ insiderNet30d: -4_000_000, insiderSellers30d: 3 })],
    });
    const ins = alto.pressures.find((p) => p.text.includes("insiders"));
    expect(ins?.side).toBe("trim");
  });

  it("unos resultados inminentes van a 'lo que lo decide' Y presionan", () => {
    const today = new Date("2026-07-30T12:00:00Z");
    const d = buildDecisionFacts({
      symbols: ["MSFT"],
      portfolio: portfolio({ positions: [MSFT_POSITION], totalValue: 147_000 }),
      facts: [facts({ nextEarnings: "2026-08-04", nextEarningsEps: 3.41 })],
      today,
    });
    expect(d.dated[0].text).toContain("dentro de 5 días");
    expect(d.dated[0].text).toContain("3.41");
    expect(d.pressures.some((p) => p.side === "trim" && p.text.includes("5 días"))).toBe(true);
  });

  it("unos resultados lejanos se anuncian pero NO presionan", () => {
    const d = buildDecisionFacts({
      symbols: ["MSFT"],
      portfolio: portfolio({ positions: [MSFT_POSITION], totalValue: 147_000 }),
      facts: [facts({ nextEarnings: "2026-10-28" })],
      today: new Date("2026-07-30T12:00:00Z"),
    });
    expect(d.dated).toHaveLength(1);
    expect(d.pressures.some((p) => p.text.includes("reporta en"))).toBe(false);
  });

  it("sin nada duro, hasDecisionEvidence es false y la postura caerá", () => {
    const vacio = buildDecisionFacts({ symbols: ["MSFT"], portfolio: null, facts: [] });
    // La única presión es la neutral de "no tienes posición": no basta.
    expect(hasDecisionEvidence(vacio)).toBe(false);

    const conHecho = buildDecisionFacts({
      symbols: ["MSFT"],
      portfolio: null,
      facts: [facts({ nextEarnings: "2026-10-28" })],
    });
    expect(hasDecisionEvidence(conHecho)).toBe(true);
  });
});

describe("riesgo estructural y concentración sectorial", () => {
  it("la beta alta cualifica el peso, pero sólo si la posición se tiene", () => {
    const con = buildDecisionFacts({
      symbols: ["MSFT"],
      portfolio: portfolio({ positions: [MSFT_POSITION], totalValue: 147_000 }),
      facts: [facts()],
      risk: [{ symbol: "MSFT", beta: 1.9, pe: 38, daysToCover: null, shortChangePct: null }],
    });
    const beta = con.pressures.find((p) => p.text.includes("beta"));
    expect(beta?.side).toBe("trim");
    expect(beta?.text).toContain("1.90");

    // Sin posición no hay nada que amplificar: la beta es un dato del valor,
    // no una presión sobre una exposición que no existe.
    const sin = buildDecisionFacts({
      symbols: ["MSFT"],
      portfolio: portfolio(),
      facts: [facts()],
      risk: [{ symbol: "MSFT", beta: 1.9, pe: null, daysToCover: null, shortChangePct: null }],
    });
    expect(sin.pressures.some((p) => p.text.includes("beta"))).toBe(false);
  });

  it("el days-to-cover alto es NEUTRAL: corta por los dos lados", () => {
    // Apuesta contraria acumulada y combustible de squeeze son la misma
    // cifra. Darle lado sería elegir narrativa, que es justo lo que este
    // bloque existe para no hacer.
    const d = buildDecisionFacts({
      symbols: ["GME"],
      portfolio: null,
      facts: [facts({ symbol: "GME" })],
      risk: [{ symbol: "GME", beta: null, pe: null, daysToCover: 7.2, shortChangePct: 31 }],
    });
    const dtc = d.pressures.find((p) => p.text.includes("days-to-cover"));
    expect(dtc?.side).toBe("neutral");
    expect(dtc?.text).toContain("subió 31%");
  });

  it("un days-to-cover bajo no entra", () => {
    const d = buildDecisionFacts({
      symbols: ["MSFT"],
      portfolio: null,
      facts: [facts()],
      risk: [{ symbol: "MSFT", beta: null, pe: null, daysToCover: 1.2, shortChangePct: null }],
    });
    expect(d.pressures.some((p) => p.text.includes("days-to-cover"))).toBe(false);
  });

  it("la concentración SECTORIAL matiza el recorte del nombre", () => {
    // El caso que puede dar la vuelta a la respuesta: recortar el 27% de
    // MSFT suena a reducir riesgo, pero si Technology pesa el 70% vender
    // para comprar otra tecnológica deja la exposición donde estaba.
    const p = portfolio({
      positions: [MSFT_POSITION],
      totalValue: 147_000,
      sectors: [{ sector: "Technology", weightPct: 70, symbols: ["MSFT"] }],
    });
    const d = buildDecisionFacts({ symbols: ["MSFT"], portfolio: p, facts: [facts()] });
    const sec = d.pressures.find((x) => x.text.includes("sector"));
    expect(sec?.side).toBe("trim");
    expect(sec?.text).toContain("70%");
  });

  it("un sector sin clasificar no genera presión: es dato que falta, no riesgo", () => {
    const p = portfolio({
      positions: [{ ...MSFT_POSITION, sector: null }],
      totalValue: 147_000,
      sectors: [{ sector: "Unknown", weightPct: 100, symbols: ["MSFT"] }],
    });
    const d = buildDecisionFacts({ symbols: ["MSFT"], portfolio: p, facts: [facts()] });
    expect(d.pressures.some((x) => x.text.includes("su sector"))).toBe(false);
  });
});

describe("looksLikeDeal", () => {
  it("acepta la operación y rechaza la historia de precio", () => {
    // Los cuatro son titulares REALES de RKLB que `pendingDeals` devolvió
    // como "operaciones pendientes" el 2026-07-30. Dos no lo eran, y colarlos
    // metía por la puerta de atrás el movimiento de precio que el prompt de
    // decisión prohíbe expresamente.
    expect(looksLikeDeal("Rocket Lab to acquire Iridium Communications for $8B")).toBe(true);
    expect(looksLikeDeal("Rocket Lab's Latest Deal Puts It on a Collision Course With SpaceX")).toBe(true);
    expect(looksLikeDeal("Why Rocket Lab (RKLB) Shares Are Plunging Today")).toBe(false);
    expect(looksLikeDeal("Rocket Lab Stock Slides 12% as Iridium Deal Risks Hit Momentum")).toBe(false);
    expect(looksLikeDeal("Huge News for Rocket Lab Investors")).toBe(false);
  });

  it("entiende el vocabulario en español", () => {
    expect(looksLikeDeal("Iberdrola anuncia la adquisición de Avangrid")).toBe(true);
    expect(looksLikeDeal("Las acciones de Iberdrola caen un 3%")).toBe(false);
  });
});

describe("daysUntil", () => {
  it("cuenta días de calendario sin que el huso mueva el redondeo", () => {
    const today = new Date("2026-07-30T23:30:00Z");
    expect(daysUntil("2026-07-30", today)).toBe(0);
    expect(daysUntil("2026-08-04", today)).toBe(5);
    expect(daysUntil("2026-07-29", today)).toBe(-1);
  });

  it("una fecha basura no revienta la respuesta", () => {
    expect(daysUntil("no es una fecha")).toBeNull();
  });
});
