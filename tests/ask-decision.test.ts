import { describe, expect, it } from "vitest";
import {
  DECISION_NOISE,
  classifyFocus,
  classifyIntent,
  normalizeQuestion,
} from "@/lib/ask/intent";
import { PRESETS, type Attribution, type Axes } from "@/lib/coach/frames";
import type { EarningsRead } from "@/lib/ask/retrieve";
import {
  DECISION_THRESHOLDS,
  buildDecisionFacts,
  daysUntil,
  hasDecisionEvidence,
  positionContexts,
} from "@/lib/ask/decision";
import { answerShape, cleanBrackets, orderDecisionSections } from "@/lib/ai/ask";
import { keywords, ledgerCandidates, looksLikeDeal } from "@/lib/ask/retrieve";
import type { Citation, Retrieval, StructuredFacts } from "@/lib/ask/retrieve";
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

  it("«¿debería comprar más $NU?» es una DECISIÓN, no una consulta de archivo", () => {
    // Medido el 2026-08-07: las cuatro caían en `archive`, o sea que las
    // contestaba el bibliotecario, que tiene prohibido opinar. Llevan verbo
    // de acción pero ninguna marca de primera persona ESCRITA, y las
    // peticiones de juicio que había no cubrían estas formas — que son de
    // las más naturales que hay para preguntar exactamente esto.
    expect(classifyIntent("¿debería comprar más $NU?")).toBe("decision");
    expect(classifyIntent("¿tiene sentido ampliar en $SOFI?")).toBe("decision");
    expect(classifyIntent("¿es buen momento para entrar en $RKLB?")).toBe("decision");
    expect(classifyIntent("is it a good time to add $PLTR?")).toBe("decision");
  });

  it("la tercera persona de «deber» NO convierte una consulta de archivo en decisión", () => {
    // La contrapartida del test anterior, y la razón de que sólo entren las
    // formas de primera persona: "debe"/"deben" hablan de la empresa, no del
    // lector, y con un verbo de acción dentro entrarían en modo decisión
    // desplegando bloques sobre el dinero de nadie.
    expect(classifyIntent("¿la empresa debe vender su división de nube?")).toBe("archive");
    expect(classifyIntent("¿por qué deben comprar más terrenos?")).toBe("archive");
    // Y "add" suelto, que se añadió a ACTION para el caso inglés de arriba,
    // no puede arrastrar la pregunta de ejemplo de la propia UI.
    expect(classifyIntent("What are insiders adding lately?")).toBe("archive");
  });

  it("no se despista con tildes ni mayúsculas", () => {
    expect(normalizeQuestion("¿Qué HAGO con mi posición?")).toBe(
      "¿que hago con mi posicion?",
    );
    expect(classifyIntent("¿QUÉ HAGO CON MI POSICIÓN EN $SOFI, la amplío?")).toBe(
      "decision",
    );
  });

  it("una PREVIA de resultados es su propia clase de pregunta", () => {
    // La queja del 2026-08-07. Sin este intent caía en `archive`, cuya única
    // sección de futuro prohíbe pronosticar, y encima apagaba el canal
    // prospectivo entero: lo máximo que podía contestar era la fecha.
    expect(classifyIntent("¿cómo se espera que sea la earnings report de $NU?")).toBe(
      "preview",
    );
    expect(classifyIntent("what to expect from $RKLB earnings?")).toBe("preview");
    expect(classifyIntent("previa de resultados de $ZETA")).toBe("preview");
    expect(classifyIntent("¿va a batir el consenso $PLTR?")).toBe("preview");
  });

  it("la DECISIÓN gana a la previa cuando se pregunta por el dinero", () => {
    // "antes de resultados" es disparador de previa Y aparece en preguntas
    // de decisión. Quien pregunta qué hacer con su posición quiere un
    // veredicto, no una previa — de ahí el orden en `classifyIntent`.
    expect(classifyIntent("¿compro $NU antes de resultados?")).toBe("decision");
    expect(classifyIntent("¿conviene vender AAPL antes de resultados?")).toBe("decision");
  });

  it("una consulta de archivo sin verbo de acción ni petición de opinión es archivo", () => {
    expect(classifyIntent("¿Qué se dijo de NVDA esta semana?")).toBe("archive");
    expect(classifyIntent("¿Hay algún 13D nuevo?")).toBe("archive");
    // "a largo plazo" a secas NO basta: es vocabulario normal de una
    // consulta de archivo sobre guía o estrategia de la empresa.
    expect(classifyIntent("¿Cuál es la guía a largo plazo de MSFT?")).toBe("archive");
  });

  it("una petición de opinión clasifica como decisión SIN verbo de acción", () => {
    // El caso que abrió la sesión del 2026-07-31: caía a archivo y el
    // bibliotecario (prohibido opinar) respondía con la ficha del valor.
    expect(classifyIntent("que te parece SOFI a largo plazo?")).toBe("decision");
    expect(classifyIntent("¿Cómo ves a PLTR después de resultados?")).toBe("decision");
    expect(classifyIntent("¿Te mojas con NVDA?")).toBe("decision");
    expect(classifyIntent("¿Merece la pena SOFI a estos precios?")).toBe("decision");
    expect(classifyIntent("what do you think of NVDA long term?")).toBe("decision");
    expect(classifyIntent("your take on TSLA?")).toBe("decision");
  });

  it("la opinión pedida DE USTED también es decisión — la segunda regresión real", () => {
    // 2026-07-31, segunda vez: el usuario le habla de usted al Ask. "¿Qué
    // LE parece comprar SOFI a largo plazo?" llevaba además el verbo de
    // acción "comprar", así que entró por la conjunción vieja (acción sin
    // primera persona ni juicio reconocido) y cayó a archivo otra vez.
    expect(classifyIntent("qué le parece comprar SOFI a largo plazo?")).toBe("decision");
    expect(classifyIntent("¿Qué opina usted de NVDA?")).toBe("decision");
    expect(classifyIntent("¿Cómo lo ve usted?")).toBe("decision");
    expect(classifyIntent("¿Se moja con PLTR?")).toBe("decision");
    expect(classifyIntent("¿Comprarías RKLB aquí?")).toBe("decision");
    expect(classifyIntent("¿Compraría usted ZETA a estos precios?")).toBe("decision");
    expect(classifyIntent("would you buy NVDA at these levels?")).toBe("decision");
  });

  it("la tercera persona NO es opinión: es una pregunta al archivo", () => {
    // "¿Por qué compraría Buffett esta acción?" pregunta por un tercero.
    expect(classifyIntent("¿Por qué compraría Berkshire esta acción?")).toBe("archive");
    expect(classifyIntent("¿Qué opina el mercado de NVDA?")).toBe("archive");
  });
});

describe("classifyFocus — qué decisión se pregunta", () => {
  it("comprar/invertir/ampliar es ENTRY", () => {
    expect(classifyFocus("qué le parece comprar SOFI a largo plazo?")).toBe("entry");
    expect(classifyFocus("¿qué te parece una inversión en $SOFI?")).toBe("entry");
    expect(classifyFocus("¿amplío mi posición en META?")).toBe("entry");
    expect(classifyFocus("should I buy NVDA?")).toBe("entry");
  });

  it("vender/recortar/salir es EXIT", () => {
    expect(classifyFocus("¿vendo una parte de MSFT?")).toBe("exit");
    expect(classifyFocus("¿recorto PLTR antes de resultados?")).toBe("exit");
    expect(classifyFocus("should I take profits on TSLA?")).toBe("exit");
  });

  it("las dos direcciones a la vez, o ninguna, es GENERAL", () => {
    expect(classifyFocus("¿vendo o amplío SOFI?")).toBe("general");
    expect(classifyFocus("¿qué te parece SOFI a largo plazo?")).toBe("general");
    expect(classifyFocus("¿dejo correr $MSFT o vendo una parte?")).toBe("exit");
  });
});

describe("el comunicado oficial entra como presión con lado (Fase 1)", () => {
  function read(attributions: Attribution[]): EarningsRead {
    return {
      symbol: "SOFI",
      filingDate: "2026-07-29",
      reportDate: "2026-07-29",
      headline: "Record quarter",
      summary: ["revenue $1.22B"],
      readBetweenLines: null,
      exhibitUrl: "https://sec.gov/x",
      epsEstimate: null,
      revenueEstimate: null,
      surprises: [],
      attributions,
    };
  }
  const frames = (axes: Axes | null) => new Map([["SOFI", axes]]);

  it("la tesis cumpliéndose (confirma) empuja a AMPLIAR — el caso SOFI", () => {
    // El agujero medido 2026-07-31: ingresos récord y guía elevada sólo
    // entraban como citas blandas; la única presión dura de SOFI era la
    // beta (recortar) y el partner acababa siempre en aguantar.
    const d = buildDecisionFacts({
      symbols: ["SOFI"],
      portfolio: null,
      facts: [],
      earnings: [
        read([
          { signal: "nucleo_acelera", layer: "nucleo", magnitude: "net revenue +43% to $1.22B", quote: null },
          { signal: "guidance_elevada", layer: "nucleo", magnitude: "FY26 guidance raised to $4.75-4.85B", quote: "we are raising our full-year guidance" },
        ]),
      ],
      frames: frames(PRESETS.compounder),
    });
    const add = d.pressures.filter((p) => p.side === "add");
    expect(add).toHaveLength(2);
    expect(add[0].text).toContain("comunicado oficial");
    expect(add[0].text).toContain("+43%");
  });

  it("un mortal CON cita empuja a recortar; SIN cita queda neutral (vigilar)", () => {
    const conCita = buildDecisionFacts({
      symbols: ["SOFI"],
      portfolio: null,
      facts: [],
      earnings: [
        read([
          { signal: "cuota_perdida", layer: "nucleo", magnitude: "market share fell to 12%", quote: "we lost share to competitors" },
        ]),
      ],
      frames: frames(PRESETS.compounder),
    });
    expect(conCita.pressures[0].side).toBe("trim");

    const sinCita = buildDecisionFacts({
      symbols: ["SOFI"],
      portfolio: null,
      facts: [],
      earnings: [
        read([
          { signal: "cuota_perdida", layer: "nucleo", magnitude: "market share fell to 12%", quote: null },
        ]),
      ],
      frames: frames(PRESETS.compounder),
    });
    expect(sinCita.pressures[0].side).toBe("neutral");
  });

  it("un esperado negativo DEFIENDE la posición (hold): es lo que compraste", () => {
    const d = buildDecisionFacts({
      symbols: ["SOFI"],
      portfolio: null,
      facts: [],
      earnings: [
        read([
          { signal: "capex_disparado", layer: "inversion", magnitude: "capex $2B vs $1B", quote: null },
        ]),
      ],
      frames: frames(PRESETS.power_play),
    });
    expect(d.pressures[0].side).toBe("hold");
    expect(d.pressures[0].text).toContain("es lo esperado");
  });

  it("sin marco declarado no se asigna lado, y el texto lo dice", () => {
    const d = buildDecisionFacts({
      symbols: ["SOFI"],
      portfolio: null,
      facts: [],
      earnings: [
        read([
          { signal: "nucleo_acelera", layer: "nucleo", magnitude: "revenue +43%", quote: null },
        ]),
      ],
      frames: frames(null),
    });
    expect(d.pressures[0].side).toBe("neutral");
    expect(d.pressures[0].text).toContain("sin clasificar");
  });

  it("un comunicado de un símbolo NO preguntado no entra", () => {
    const d = buildDecisionFacts({
      symbols: ["MSFT"],
      portfolio: null,
      facts: [],
      earnings: [
        read([
          { signal: "nucleo_acelera", layer: "nucleo", magnitude: "revenue +43%", quote: null },
        ]),
      ],
      frames: frames(PRESETS.compounder),
    });
    expect(d.pressures.filter((p) => p.text.includes("comunicado"))).toHaveLength(0);
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
      forward: { bars: [], sellers: [], deals: [], risk: [], fundChanges: [] },
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
      { key: "add", title: "AMPLIAR", text: "d" },
      { key: "stance", title: "POSTURA", text: "a" },
    ]);
    expect(out.map((s) => s.key)).toEqual(["stance", "add", "trim", "unknown"]);
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
    consensusTrend: null,
    surpriseHistory: [],
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

describe("buildDecisionFacts — los 13F", () => {
  const cambio = (over: Record<string, unknown> = {}) => ({
    symbol: "MSFT",
    issuerName: "Microsoft",
    fundName: "Tiger Global",
    action: "trimmed" as const,
    sharesPct: -54.4,
    value: 1_000_000,
    period: "2026-03-31",
    prevPeriod: "2025-12-31",
    ...over,
  });

  // `fund_holdings` tenía 1.782 filas y su único lector era /insider. Lo que
  // se perdía: nueve movimientos de gestoras discrecionales sobre MSFT y
  // META, TODOS reduciendo, cuando esas dos son el 44% de la cartera.
  it("un recorte de un fondo empuja a RECORTAR y una ampliación a AMPLIAR", () => {
    const trim = buildDecisionFacts({
      symbols: ["MSFT"],
      portfolio: null,
      facts: [facts()],
      fundChanges: [cambio()],
    }).pressures.filter((p) => p.text.startsWith("13F:"));
    expect(trim).toHaveLength(1);
    expect(trim[0].side).toBe("trim");
    expect(trim[0].provenance).toBe("declared");

    const add = buildDecisionFacts({
      symbols: ["MSFT"],
      portfolio: null,
      facts: [facts()],
      fundChanges: [cambio({ action: "added", sharesPct: 60 })],
    }).pressures.filter((p) => p.text.startsWith("13F:"));
    expect(add[0].side).toBe("add");
  });

  // LA FECHA ES OBLIGATORIA Y VA DENTRO DEL TEXTO. Un 13F declara la foto del
  // cierre de trimestre y se presenta hasta 45 días después: en agosto, "el
  // último trimestre" cerró el 31 de marzo. Sin la fecha delante, el modelo
  // lo escribe en presente ("los fondos están saliendo"), que sería falso.
  it("la presión SIEMPRE dice de qué trimestre es y que llega con retraso", () => {
    const [p] = buildDecisionFacts({
      symbols: ["MSFT"],
      portfolio: null,
      facts: [facts()],
      fundChanges: [cambio()],
    }).pressures.filter((x) => x.text.startsWith("13F:"));
    expect(p.text).toContain("2026-03-31");
    expect(p.text).toContain("45 días");
    expect(p.text).toContain("NO es un movimiento de esta semana");
  });

  it("una salida completa se nombra como tal, sin porcentaje inventado", () => {
    const [p] = buildDecisionFacts({
      symbols: ["MSFT"],
      portfolio: null,
      facts: [facts()],
      fundChanges: [cambio({ action: "exited", sharesPct: null })],
    }).pressures.filter((x) => x.text.startsWith("13F:"));
    expect(p.text).toContain("cerró la posición entera");
    expect(p.text).not.toContain("%");
  });

  it("acota por símbolo: seis movimientos del mismo valor no ahogan la mesa", () => {
    const seis = Array.from({ length: 6 }, (_, i) =>
      cambio({ fundName: `Fondo ${i}` }),
    );
    const p = buildDecisionFacts({
      symbols: ["MSFT"],
      portfolio: null,
      facts: [facts()],
      fundChanges: seis,
    }).pressures.filter((x) => x.text.startsWith("13F:"));
    expect(p.length).toBeLessThanOrEqual(3);
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

  it("dinero nuevo declarado ante la SEC empuja a AMPLIAR, no a aguantar", () => {
    // Compras netas de insiders y un 13D son capital ENTRANDO. En "hold"
    // (como hasta el 2026-07-31) el lado ampliar se quedaba siempre vacío y
    // la respuesta nunca podía recomendar invertir más — el fallo de la
    // pregunta "¿qué te parece una inversión en $SOFI a largo plazo?".
    const compras = buildDecisionFacts({
      symbols: ["SOFI"],
      portfolio: null,
      facts: [facts({ symbol: "SOFI", insiderNet30d: 2_500_000, insiderBuyers30d: 2 })],
    });
    expect(compras.pressures.find((p) => p.text.includes("insiders"))?.side).toBe("add");

    const stake = buildDecisionFacts({
      symbols: ["SOFI"],
      portfolio: null,
      facts: [
        facts({
          symbol: "SOFI",
          stakes: [{ filer: "Fondo X", pct: 6.1, filedAt: "2026-07-20" }],
        }),
      ],
    });
    expect(stake.pressures.find((p) => p.text.includes("13D/G"))?.side).toBe("add");
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

describe("ledgerCandidates", () => {
  function cita(over: Partial<Citation>): Citation {
    return {
      n: 1,
      newsId: 100,
      headline: "titular",
      summary: null,
      url: "https://example.com/1",
      source: "rss:test",
      symbols: ["MSFT"],
      publishedAt: "2026-07-29T10:00:00Z",
      impact: 3,
      sentiment: 0,
      via: "vector",
      body: "x".repeat(300),
      ...over,
    };
  }

  const base: Retrieval = {
    symbols: ["MSFT"],
    intent: "decision",
    citations: [],
    facts: [],
    earnings: [],
    forward: { bars: [], sellers: [], deals: [], risk: [], fundChanges: [] },
    vectorUsed: true,
    harvested: 0,
    attempted: 0,
    bodiesAvailable: 0,
  };

  it("toma cualquier cita con cuerpo, no sólo las del canal prospectivo", () => {
    // Un compromiso pendiente no deja de serlo por haber entrado al prompt
    // por semejanza en vez de por peso de categoría.
    const { candidates } = ledgerCandidates({
      ...base,
      citations: [cita({ n: 1, newsId: 1, via: "vector" }), cita({ n: 2, newsId: 2, via: "forward" })],
    });
    expect(candidates.map((c) => c.newsId)).toEqual([1, 2]);
  });

  it("descarta el titular sin cuerpo: no hay plazo ni condición que extraer", () => {
    const { candidates } = ledgerCandidates({
      ...base,
      citations: [cita({ body: null }), cita({ n: 2, newsId: 2, body: "corto" })],
    });
    expect(candidates).toHaveLength(0);
  });

  it("descarta el comunicado de resultados: ya viaja entero por otro sitio", () => {
    const { candidates } = ledgerCandidates({
      ...base,
      citations: [cita({ newsId: null, via: "filing" })],
    });
    expect(candidates).toHaveLength(0);
  });

  it("descarta la cita de una empresa que no es la preguntada", () => {
    // Un compromiso de otra empresa que salía de refilón en el artículo no
    // es material para esta decisión, y el gate del extractor lo tiraría
    // igual: mejor no pagar tokens por él.
    const { candidates } = ledgerCandidates({
      ...base,
      citations: [cita({ symbols: ["TSLA"] })],
    });
    expect(candidates).toHaveLength(0);
  });

  it("numberOf devuelve el mismo [n] que verá el lector", () => {
    const { numberOf } = ledgerCandidates({
      ...base,
      citations: [cita({ n: 7, newsId: 42 })],
    });
    expect(numberOf(42)).toBe(7);
    expect(numberOf(999)).toBeUndefined();
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
