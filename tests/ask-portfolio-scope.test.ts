import { describe, expect, it } from "vitest";
import {
  DIAGNOSE_NOISE,
  PORTFOLIO_NOISE,
  classifyJob,
  classifyScope,
} from "@/lib/ask/intent";
import {
  ageLabel,
  answerShape,
  normalizeSections,
  shapeAcceptsOutline,
} from "@/lib/ai/ask";
import { interleaveBySymbol, keywords, type Retrieval } from "@/lib/ask/retrieve";
import { parseOutline } from "@/lib/ai/ask-outline";
import { buildPortfolio, dayAttribution, type QuoteLike } from "@/lib/portfolio";

// ─────────────────────────────────────────────────────────────────────────
// LA PREGUNTA QUE ABRIÓ ESTO (2026-08-12)
//
//   "porque esta cayendo mi cartera hoy, ve stock por stock"
//
// Medido con `probe-ask` antes del arreglo: INTENT archive · SÍMBOLOS
// (ninguno) · 20 citas, 20 AJENAS. La respuesta habló de Altria, Rollins,
// Alphabet, Life360, Aeva y Sandisk. La cartera real es PLTR, RKLB, ZETA,
// SOFI, MSFT, META y NU: ni una de las seis.
//
// Estos tests fijan las dos mitades del arreglo — que el alcance existe, y
// que ninguna posición se cae del reparto.
// ─────────────────────────────────────────────────────────────────────────

const LA_PREGUNTA = "porque esta cayendo mi cartera hoy, ve stock por stock";

describe("classifyScope", () => {
  it("la pregunta de la regresión tiene alcance de CARTERA", () => {
    expect(classifyScope(LA_PREGUNTA, false)).toBe("portfolio");
  });

  it("reconoce las formas de decir 'mi libro' en los dos idiomas", () => {
    for (const q of [
      "¿por qué cae mi cartera hoy?",
      "cómo van mis posiciones",
      "resumen de mis acciones esta semana",
      "qué pasa con toda mi cartera",
      "what's dragging my portfolio today",
      "any news across my holdings",
      "how are my positions doing",
    ]) {
      expect(classifyScope(q, false), q).toBe("portfolio");
    }
  });

  it("NOMBRAR UN VALOR GANA sobre el alcance de cartera", () => {
    // Señalar una posición concreta y abrir las siete sería contestar a otra
    // pregunta. El alcance de cartera es para cuando no se señala ninguna.
    expect(classifyScope("¿por qué cae MSFT en mi cartera?", true)).toBe("named");
    expect(classifyScope("cuánto pesa $META en mis posiciones", true)).toBe("named");
  });

  it("una cartera AJENA no es la del lector", () => {
    // El posesivo de primera persona es obligatorio: sin él, "la cartera de
    // Buffett" abriría las siete posiciones del usuario para responder por
    // las de otro.
    for (const q of [
      "qué hay en la cartera de Buffett",
      "cómo compone ARK su cartera",
      "the portfolio of Berkshire",
      "qué tal la cartera de bonos del BCE",
    ]) {
      expect(classifyScope(q, false), q).toBe("thematic");
    }
  });

  it("una pregunta temática sin cartera sigue siendo temática", () => {
    expect(classifyScope("qué se dijo de los chips de IA esta semana", false)).toBe(
      "thematic",
    );
  });
});

describe("classifyJob — diagnóstico", () => {
  it("la pregunta de la regresión pide DIAGNÓSTICO, no archivo", () => {
    // Con `archive` responde el bibliotecario, que tiene PROHIBIDO opinar:
    // ante "por qué cae" lo máximo que puede hacer es enumerar noticias.
    expect(classifyJob(LA_PREGUNTA)).toBe("diagnose");
  });

  it("reconoce las formas de preguntar por qué se movió algo", () => {
    for (const q of [
      "¿por qué cae $RKLB hoy?",
      "por que esta bajando el mercado",
      "a qué se debe la subida de SOFI",
      "qué le pasa a ZETA",
      "qué está pasando con NU",
      "why is META falling today",
      "what happened to PLTR",
      "what's driving the selloff",
    ]) {
      expect(classifyJob(q), q).toBe("diagnose");
    }
  });

  it("LA DECISIÓN GANA al diagnóstico", () => {
    // "¿vendo porque está cayendo?" pregunta qué hacer con el dinero; el
    // porqué de la caída es sólo el contexto. Un veredicto degradado a
    // diagnóstico es la queja original con otra cara.
    expect(classifyJob("¿debería vender $NU porque está cayendo?")).toBe("decision");
    expect(classifyJob("should i sell MSFT, why is it dropping?")).toBe("decision");
  });

  it("LA PREVIA GANA al diagnóstico", () => {
    expect(classifyJob("¿qué se espera de los resultados de $NU?")).toBe("preview");
  });

  it("no se lleva por delante una consulta de archivo legítima", () => {
    for (const q of [
      "¿qué dijo el CEO de MSFT sobre el capex?",
      "noticias de RKLB esta semana",
    ]) {
      expect(classifyJob(q), q).toBe("archive");
    }
  });
});

describe("sujeto de tercera persona (falso positivo cazado por un test)", () => {
  it("'quién compró X' es ARCHIVO, no una decisión sobre tu dinero", () => {
    // Sin tildes —como escribe el usuario— "compró" y "compro" son la misma
    // cadena, y `SELF` lista "compro" como marca de dinero propio. Esta
    // pregunta recibía bloques de aguantar/recortar sobre el dinero de nadie.
    for (const q of [
      "quién compró acciones de SOFI",
      "quien vendio $MSFT el mes pasado",
      "qué fondos compraron NU",
      "who bought PLTR last quarter",
      "which insiders sold META",
    ]) {
      expect(classifyJob(q), q).toBe("archive");
    }
  });

  it("pero un JUICIO explícito sigue mandando aunque el sujeto sea otro", () => {
    // El sujeto ajeno anula la marca de primera persona, no la petición de
    // opinión: "¿quién debería vender?" sigue pidiendo que te mojes.
    expect(classifyJob("¿quién debería vender $NU ahora?")).toBe("decision");
  });

  it("y no toca la primera persona de verdad", () => {
    expect(classifyJob("¿vendo mis $SOFI?")).toBe("decision");
    expect(classifyJob("compré MSFT y no sé si aguantar, ¿qué hago?")).toBe(
      "decision",
    );
  });
});

describe("keywords — el ruido del ALCANCE se purga aparte del TRABAJO", () => {
  it("la pregunta de la regresión no deja términos que casen medio archivo", () => {
    // Sin purgar, las 6 plazas del canal léxico se las comían "cayendo",
    // "cartera", "stock" y "hoy". "stock" casa por subcadena con
    // literalmente medio archivo financiero.
    const ks = keywords(LA_PREGUNTA, "diagnose", "portfolio");
    for (const bad of ["cayendo", "cartera", "stock"]) {
      expect(ks, `"${bad}" no debería sobrevivir`).not.toContain(bad);
    }
  });

  it("los dos vocabularios son distintos y una pregunta puede traer los dos", () => {
    // Si fueran el mismo set, purgar uno bastaría — y no basta: por eso el
    // filtro de `keywords` los comprueba por separado.
    expect(PORTFOLIO_NOISE.has("cartera")).toBe(true);
    expect(DIAGNOSE_NOISE.has("cartera")).toBe(false);
    expect(DIAGNOSE_NOISE.has("cayendo")).toBe(true);
    expect(PORTFOLIO_NOISE.has("cayendo")).toBe(false);
  });

  it("lo que SÍ nombra algo del mundo sobrevive", () => {
    const ks = keywords(
      "por qué cae mi cartera con el antitrust y el guidance",
      "diagnose",
      "portfolio",
    );
    expect(ks).toContain("antitrust");
    expect(ks).toContain("guidance");
  });
});

describe("interleaveBySymbol", () => {
  const rows = [
    // Como los devuelve `selectForwardCandidates`: ORDER BY symbol, rn.
    { symbol: "AAA", id: 1 }, { symbol: "AAA", id: 2 }, { symbol: "AAA", id: 3 },
    { symbol: "BBB", id: 4 }, { symbol: "BBB", id: 5 }, { symbol: "BBB", id: 6 },
    { symbol: "CCC", id: 7 }, { symbol: "CCC", id: 8 }, { symbol: "CCC", id: 9 },
  ];

  it("EL RECORTE NO BORRA POSICIONES ENTERAS — la propiedad que importa", () => {
    // Ésta es la razón de existir de la función. Con la lista agrupada, un
    // techo de 4 se lleva AAA×3 + BBB×1 y CCC no aparece: una respuesta
    // "stock por stock" que se queda sin un valor y no dice que falta.
    const cortado = interleaveBySymbol(rows).slice(0, 4);
    expect(new Set(cortado.map((r) => r.symbol))).toEqual(
      new Set(["AAA", "BBB", "CCC"]),
    );
    // Y el contraejemplo, para que el test falle si alguien quita el
    // intercalado creyendo que era cosmética:
    expect(new Set(rows.slice(0, 4).map((r) => r.symbol))).not.toContain("CCC");
  });

  it("conserva el orden dentro de cada símbolo", () => {
    const out = interleaveBySymbol(rows);
    expect(out.filter((r) => r.symbol === "AAA").map((r) => r.id)).toEqual([1, 2, 3]);
  });

  it("no pierde ni duplica nada, con lotes desiguales", () => {
    const desigual = [
      { symbol: "AAA", id: 1 },
      { symbol: "BBB", id: 2 }, { symbol: "BBB", id: 3 }, { symbol: "BBB", id: 4 },
      { symbol: "CCC", id: 5 }, { symbol: "CCC", id: 6 },
    ];
    const out = interleaveBySymbol(desigual);
    expect(out).toHaveLength(desigual.length);
    expect(new Set(out.map((r) => r.id)).size).toBe(desigual.length);
    expect(out.slice(0, 3).map((r) => r.symbol)).toEqual(["AAA", "BBB", "CCC"]);
  });

  it("lista vacía no cuelga", () => {
    expect(interleaveBySymbol([])).toEqual([]);
  });
});

describe("dayAttribution — la aritmética que el modelo tiene prohibida", () => {
  const quotes = (m: Record<string, [number, number]>): Record<string, QuoteLike> =>
    Object.fromEntries(
      Object.entries(m).map(([s, [price, changePercent]]) => [
        s,
        { price, changePercent, prevClose: price / (1 + changePercent / 100) },
      ]),
    );

  const p = buildPortfolio(
    [
      { symbol: "BIG", name: null, sector: "Tech", shares: 100, avgCost: 10 },
      { symbol: "SMALL", name: null, sector: "Tech", shares: 1, avgCost: 10 },
      { symbol: "FLAT", name: null, sector: "Tech", shares: 50, avgCost: 10 },
    ],
    quotes({ BIG: [10, -2], SMALL: [10, -20], FLAT: [10, 0] }),
  );

  it("ORDENA POR ARRASTRE, no por el movimiento del valor", () => {
    // El caso que define la función: SMALL cae un 20% y BIG sólo un 2%,
    // pero BIG pesa 100 veces más. Quien explica el día es BIG. Un modelo
    // mirando la columna de porcentajes contesta al revés.
    const { contributions } = dayAttribution(p);
    expect(contributions[0].symbol).toBe("BIG");
    expect(contributions[0].contribPct).toBeCloseTo(-1.32, 2);
    expect(contributions.find((c) => c.symbol === "SMALL")!.contribPct).toBeCloseTo(
      -0.13,
      2,
    );
  });

  it("la suma de arrastres ES el movimiento de la cartera", () => {
    const { contributions } = dayAttribution(p);
    const suma = contributions.reduce((a, c) => a + c.contribPct, 0);
    expect(suma).toBeCloseTo(p.dayChangePct!, 6);
  });

  it("una posición SIN precio se DEVUELVE, no se omite", () => {
    // Omitirla dejaría al lector creyendo que ese valor no se movió, que es
    // una afirmación que nadie ha hecho.
    const sinPrecio = buildPortfolio(
      [
        { symbol: "OK", name: null, sector: null, shares: 10, avgCost: 1 },
        { symbol: "MUDA", name: null, sector: null, shares: 10, avgCost: 1 },
      ],
      quotes({ OK: [10, -1] }),
    );
    const { contributions, unmeasured } = dayAttribution(sinPrecio);
    expect(contributions.map((c) => c.symbol)).toEqual(["OK"]);
    expect(unmeasured).toEqual(["MUDA"]);
  });
});

describe("answerShape con alcance de cartera", () => {
  const base = (over: Partial<Retrieval>): Retrieval => ({
    symbols: [],
    job: "diagnose",
    scope: "portfolio",
    citations: [],
    facts: [],
    earnings: [],
    forward: { bars: [], sellers: [], deals: [], risk: [], fundChanges: [] },
    vectorUsed: false,
    harvested: 0,
    attempted: 0,
    bodiesAvailable: 0,
    ...over,
  });

  it("NUNCA cae a prosa aunque el archivo venga vacío", () => {
    // Con siete posiciones, un párrafo no puede contestar "stock por
    // stock". La respuesta correcta con poco material sigue siendo por
    // epígrafes: "estas tres se mueven, de estas dos no hay nada".
    expect(answerShape(base({}))).toBe("sections");
  });

  it("una decisión sigue mandando sobre el alcance", () => {
    expect(answerShape(base({ job: "decision" }))).toBe("decision");
  });

  it("las formas con claves portantes NO admiten guion", () => {
    // `stance` tiene un gate que la borra sin respaldo y `add` existe porque
    // sin ella el modelo no podía recomendar ampliar. Un guion libre las
    // tiraría y con ellas tres arreglos medidos.
    expect(shapeAcceptsOutline("decision")).toBe(false);
    expect(shapeAcceptsOutline("preview")).toBe(false);
    expect(shapeAcceptsOutline("sections")).toBe(true);
    expect(shapeAcceptsOutline("prose")).toBe(true);
  });
});

describe("parseOutline — el guion es un GATE, no una conversión amable", () => {
  it("acepta un guion por posiciones y normaliza las claves", () => {
    const out = parseOutline({
      sections: [
        { key: "MSFT", title: "MSFT", brief: "por qué cae" },
        { key: "meta ", title: "META", brief: "por qué cae" },
      ],
    });
    expect(out?.map((s) => s.key)).toEqual(["msft", "meta"]);
  });

  it("una sección sin brief o sin título NO entra", () => {
    // Media sección produce exactamente el relleno que el guion existe para
    // evitar: un epígrafe cuyo contenido el redactor tiene que inventar.
    const out = parseOutline({
      sections: [
        { key: "a", title: "UNO", brief: "algo" },
        { key: "b", title: "DOS" },
        { key: "c", brief: "algo" },
      ],
    });
    expect(out).toHaveLength(1);
  });

  it("desambigua claves repetidas en vez de fundir dos secciones", () => {
    const out = parseOutline({
      sections: [
        { key: "x", title: "UNO", brief: "a" },
        { key: "x", title: "DOS", brief: "b" },
      ],
    });
    expect(out).toHaveLength(2);
    expect(new Set(out!.map((s) => s.key)).size).toBe(2);
  });

  it("acota a seis secciones por defecto", () => {
    const many = Array.from({ length: 15 }, (_, i) => ({
      key: `k${i}`,
      title: `T${i}`,
      brief: "x",
    }));
    expect(parseOutline({ sections: many })).toHaveLength(6);
  });

  it("EL TECHO SUBE cuando la pregunta tiene más entidades que el tope base", () => {
    // El fallo medido: con 7 posiciones y tope 6, el guion se dejó RKLB
    // fuera — y era la única que subía, o sea la mitad interesante de la
    // respuesta a "por qué cae mi cartera".
    const siete = Array.from({ length: 7 }, (_, i) => ({
      key: `k${i}`,
      title: `T${i}`,
      brief: "x",
    }));
    expect(parseOutline({ sections: siete })).toHaveLength(6);
    expect(parseOutline({ sections: siete }, 7)).toHaveLength(7);
  });

  it("basura devuelve null y NO una lista vacía", () => {
    // La diferencia importa: `null` significa "usa la plantilla fija" y una
    // lista vacía significaría "responde sin secciones".
    expect(parseOutline({})).toBeNull();
    expect(parseOutline({ sections: "no" })).toBeNull();
    expect(parseOutline({ sections: [] })).toBeNull();
    expect(parseOutline(null)).toBeNull();
  });
});

describe("ageLabel — la edad se ESCRIBE, no se deduce", () => {
  // El prompt pide desde siempre "si es viejo, di cuándo pasó", y el modelo
  // no tenía con qué cumplirlo: las citas traen fecha, pero en ningún sitio
  // se decía qué día es hoy, y restar dos fechas es aritmética prohibida.
  const now = new Date("2026-08-12T16:00:00Z");

  it("marca hoy, ayer y la antigüedad en días", () => {
    expect(ageLabel("2026-08-12T09:00:00Z", now)).toBe(" (HOY)");
    expect(ageLabel("2026-08-11T09:00:00Z", now)).toBe(" (ayer)");
    expect(ageLabel("2026-07-29T20:00:00Z", now)).toBe(" (hace 14 días)");
  });

  it("un comunicado de hace dos semanas NO se puede leer como de hoy", () => {
    // El caso medido: la primera respuesta buena atribuyó la caída de hoy a
    // los resultados del 29 de julio sin decir que eran de hace dos semanas.
    expect(ageLabel("2026-07-29T20:00:00Z", now)).not.toBe(" (HOY)");
  });

  it("una fecha futura o ilegible no inventa una edad negativa", () => {
    expect(ageLabel("2026-08-13T09:00:00Z", now)).toBe(" (HOY)");
    expect(ageLabel("no-es-una-fecha", now)).toBe("");
  });

  it("SE CUENTA POR DÍA DE CALENDARIO, no por horas transcurridas", () => {
    // El caso normal, no un borde: el archivo se llena con el cierre
    // americano, que en hora del usuario cae de madrugada. Restando
    // milisegundos, una noticia de anoche a las 20:00 leída hoy a mediodía
    // da "hace 0 días" y se rotularía (HOY) — la afirmación falsa que esta
    // etiqueta existe para impedir.
    const mediodia = new Date("2026-08-12T12:00:00Z");
    expect(ageLabel("2026-08-11T20:00:00Z", mediodia)).toBe(" (ayer)");
  });
});

describe("normalizeSections con las claves del guion", () => {
  it("conserva las claves que el editor inventó para esta pregunta", () => {
    const secs = normalizeSections(
      {
        sections: [
          { key: "msft", title: "MSFT", text: "cae por X [1]" },
          { key: "nu", title: "NU", text: "sin nada en el archivo" },
        ],
      },
      ["msft", "nu"],
    );
    expect(secs.map((s) => s.key)).toEqual(["msft", "nu"]);
  });

  it("sin la lista del guion, esas mismas claves caerían a 'other'", () => {
    // El contraejemplo que justifica el parámetro: con el enum histórico, un
    // guion por posiciones perdía el orden entero.
    const secs = normalizeSections({
      sections: [{ key: "msft", title: "MSFT", text: "cae por X [1]" }],
    });
    expect(secs[0].key).toBe("other");
  });
});
