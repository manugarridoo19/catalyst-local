import { describe, expect, it } from "vitest";
import { answerShape, inlineMarkers, normalizeSections } from "@/lib/ai/ask";
import { normalizeHeadline, surprisePct } from "@/lib/ask/retrieve";
import type { Citation, Retrieval } from "@/lib/ask/retrieve";

// La forma de la respuesta la decide el MATERIAL, no el modelo. Estos tests
// fijan esa decisión: sin sustancia no se despliegan epígrafes, porque un
// titular de sección vacío miente sobre lo que el archivo sabe.

function citation(n: number, over: Partial<Citation> = {}): Citation {
  return {
    n,
    newsId: n,
    headline: `titular ${n}`,
    summary: null,
    url: `https://example.com/${n}`,
    source: "rss:test",
    symbols: ["TEST"],
    publishedAt: "2026-07-29T10:00:00Z",
    impact: 3,
    sentiment: 0,
    via: "vector",
    ...over,
  };
}

function retrieval(over: Partial<Retrieval> = {}): Retrieval {
  return {
    symbols: [],
    intent: "archive",
    citations: [],
    facts: [],
    earnings: [],
    forward: { bars: [], sellers: [], deals: [], risk: [] },
    vectorUsed: true,
    harvested: 0,
    attempted: 0,
    bodiesAvailable: 0,
    ...over,
  };
}

describe("answerShape", () => {
  it("despliega epígrafes en cuanto hay un comunicado leído, aunque haya pocas citas", () => {
    // El comunicado ES el material: trae cifras, guía y la lectura entre
    // líneas. Con eso las cuatro secciones tienen de qué vivir.
    const r = retrieval({
      citations: [citation(1)],
      earnings: [
        {
          symbol: "TEST",
          filingDate: "2026-07-29",
          reportDate: "2026-07-29",
          headline: "Record quarter",
          summary: ["revenue $1.2B"],
          readBetweenLines: "un segmento encoge",
          exhibitUrl: "https://sec.gov/x",
          epsEstimate: 0.11,
          revenueEstimate: 1_143_134_910,
          surprises: [],
          attributions: [],
        },
      ],
    });
    expect(answerShape(r)).toBe("sections");
  });

  it("se queda en prosa con muchas citas pero sin cuerpos: son titulares", () => {
    // Éste es el caso que hay que proteger. 8 titulares sin cuerpo dan para
    // un párrafo honesto, no para "LO QUE NADIE MIRA" — que sin cuerpo del
    // artículo sólo puede salir inventado.
    const r = retrieval({
      citations: Array.from({ length: 8 }, (_, i) => citation(i + 1)),
      bodiesAvailable: 1,
    });
    expect(answerShape(r)).toBe("prose");
  });

  it("despliega epígrafes con bastantes citas y al menos dos cuerpos", () => {
    const r = retrieval({
      citations: Array.from({ length: 6 }, (_, i) => citation(i + 1)),
      bodiesAvailable: 2,
    });
    expect(answerShape(r)).toBe("sections");
  });

  it("se queda en prosa con cuerpos pero pocas citas", () => {
    const r = retrieval({
      citations: [citation(1), citation(2), citation(3)],
      bodiesAvailable: 3,
    });
    expect(answerShape(r)).toBe("prose");
  });
});

describe("normalizeSections", () => {
  it("descarta las secciones vacías en vez de pintar un epígrafe hueco", () => {
    const out = normalizeSections({
      sections: [
        { key: "numbers", title: "LOS NÚMEROS", text: "ingresos $1,2B" },
        { key: "watch", title: "QUÉ VIGILAR", text: "   " },
      ],
    });
    expect(out).toHaveLength(1);
    expect(out[0].key).toBe("numbers");
  });

  it("acepta la forma en prosa: un answer suelto es una sección sin título", () => {
    // La cadena de fallback llega hasta llama-3.1-8b y ese eslabón ignora
    // esquemas. Tolerarlo es la diferencia entre responder peor y devolver 500.
    const out = normalizeSections({ answer: "respuesta plana" });
    expect(out).toEqual([{ key: "answer", title: null, text: "respuesta plana" }]);
  });

  it("prefiere las secciones cuando llegan las dos formas a la vez", () => {
    const out = normalizeSections({
      answer: "plana",
      sections: [{ key: "reading", title: "LA LECTURA", text: "el mercado leyó X" }],
    });
    expect(out).toHaveLength(1);
    expect(out[0].text).toBe("el mercado leyó X");
  });

  it("marca como 'other' una clave que el modelo se invente", () => {
    const out = normalizeSections({
      sections: [{ key: "conclusiones", title: "T", text: "x" }],
    });
    expect(out[0].key).toBe("other");
  });

  it("devuelve vacío cuando no hay nada aprovechable", () => {
    expect(normalizeSections({ sections: [] })).toEqual([]);
    expect(normalizeSections({ answer: "  " })).toEqual([]);
  });
});

describe("inlineMarkers", () => {
  it("recoge marcadores sueltos y agrupados", () => {
    // Sin esto, una fuente citada en el texto pero ausente de `used`
    // desaparecía de Sources y el [n] del párrafo no llevaba a ninguna parte.
    expect(inlineMarkers("cayó un 8% [3] tras el filing [1, 7]")).toEqual([3, 1, 7]);
  });

  it("ignora corchetes que no son citas", () => {
    expect(inlineMarkers("el rango [alto] no es una cita")).toEqual([]);
  });
});

describe("surprisePct", () => {
  it("calcula el beat real de SOFI Q2-26", () => {
    // 1,22B GAAP contra 1,143B de consenso.
    const pct = surprisePct(1_220_000_000, 1_143_134_910, "GAAP");
    expect(pct).not.toBeNull();
    expect(pct!).toBeCloseTo(6.72, 1);
  });

  it("calcula el miss con signo negativo", () => {
    expect(surprisePct(0.1, 0.12, "GAAP")!).toBeCloseTo(-16.67, 1);
  });

  it("NO calcula nada sin base contable declarada", () => {
    // Una empresa publica ingresos GAAP Y ajustados con puntos de diferencia
    // (SoFi: 1,22B vs 1,2B). Sin saber cuál es, el porcentaje sería un número
    // con pinta de exacto y base desconocida — peor que no darlo.
    expect(surprisePct(1_220_000_000, 1_143_134_910, null)).toBeNull();
    expect(surprisePct(1_220_000_000, 1_143_134_910, "")).toBeNull();
  });

  it("caza el desajuste de ESCALA que el saneado no puede ver", () => {
    // El extractor devolvió 1.22 en vez de 1.220.000.000 — un número
    // perfectamente válido en sí mismo. Sólo se detecta comparando órdenes
    // de magnitud contra el consenso.
    expect(surprisePct(1.22, 1_143_134_910, "GAAP")).toBeNull();
    // Y al revés: consenso en millones contra real en unidades.
    expect(surprisePct(1_220_000_000, 1143, "GAAP")).toBeNull();
  });

  it("deja pasar cualquier sorpresa plausible, por grande que sea", () => {
    // El guard de escala es un factor 10: nadie bate el consenso por 10×,
    // pero un +180% tiene que poder contarse.
    expect(surprisePct(0.28, 0.1, "adjusted")!).toBeCloseTo(180, 0);
  });

  it("no divide por un consenso cero ni ausente", () => {
    expect(surprisePct(1.5, 0, "GAAP")).toBeNull();
    expect(surprisePct(1.5, null, "GAAP")).toBeNull();
    expect(surprisePct(null, 1.5, "GAAP")).toBeNull();
  });

  it("maneja un consenso NEGATIVO sin invertir el signo del beat", () => {
    // Empresa en pérdidas: consenso -0,20$, reporta -0,10$. Eso es MEJOR de
    // lo esperado y tiene que salir positivo. Dividir por el estimado con su
    // signo daría -50% y contaría una pérdida como si fuera un desplome.
    expect(surprisePct(-0.1, -0.2, "GAAP")!).toBeCloseTo(50, 1);
  });
});

describe("normalizeHeadline", () => {
  it("colapsa el mismo teletipo redistribuido por otra fuente", () => {
    // Caso real medido el 2026-07-29: estas dos ocupaban DOS de las 8 citas
    // de la respuesta sobre SOFI.
    const a = normalizeHeadline("Sofi Technologies stock hits 52-week low at $14.92");
    const b = normalizeHeadline(
      "Sofi Technologies stock hits 52-week low at $14.92 By Investing.com",
    );
    expect(a).toBe(b);
  });

  it("no colapsa titulares que dicen cosas distintas", () => {
    expect(normalizeHeadline("SoFi lifts 2026 revenue forecast")).not.toBe(
      normalizeHeadline("SoFi Earnings Growth Soars, Stock Drops"),
    );
  });
});
