import { describe, it, expect } from "vitest";
import { BATCH_SYSTEM_PROMPT } from "@/lib/scoring/prompt";
import { SUMMARY_MIN_IMPACT } from "@/lib/scoring";
import { hasDecisionEvidence, type DecisionFacts } from "@/lib/ask/decision";
import { EARNINGS_SYSTEM_PROMPT } from "@/lib/ai/earnings-report";
import { SIGNALS, SIGNAL_LABEL, type Signal } from "@/lib/coach/frames";

// DIVERGENCIAS PROMPT ↔ CÓDIGO.
//
// Estos dos fallos tienen la misma forma y ninguno de los dos da error: el
// prompt le pide una cosa al modelo y el código hace otra con la respuesta.
// No hay tipo que los pille ni excepción que salte — sólo cuota gastada en
// silencio y un gate que no muerde. El único sitio donde se pueden congelar
// es un test que lea las DOS mitades a la vez, igual que
// `tests/coach-frames.test.ts` congela que el detector no vuelva a ser un
// umbral.

describe("scoring: el umbral del summary vive en dos sitios y tienen que decir lo mismo", () => {
  it("el prompt pide summary para impact >= SUMMARY_MIN_IMPACT", () => {
    // La frase literal del prompt. Si alguien cambia el umbral ahí, esta
    // aserción falla y le obliga a mirar el código (y al revés).
    expect(BATCH_SYSTEM_PROMPT).toContain(
      `ONLY for items with impact >= ${SUMMARY_MIN_IMPACT}`,
    );
  });

  it("el prompt manda null POR DEBAJO del umbral, sin dejar hueco entre ambos", () => {
    // El agujero medido: el prompt decía ">= 3" y "<= 2", y el código
    // filtraba en 4. El item de impact 3 caía en tierra de nadie — el modelo
    // escribía y cobraba una frase de ≤180 chars que el mapeo tiraba, y la
    // tarjeta expandida se quedaba sin el resumen que v4.2 prometía.
    expect(BATCH_SYSTEM_PROMPT).toContain(
      `For items with impact <= ${SUMMARY_MIN_IMPACT - 1}, set "summary" to`,
    );
  });

  it("el umbral es 3, que es lo que documenta la nota de v4.2", () => {
    expect(SUMMARY_MIN_IMPACT).toBe(3);
  });
});

describe("coach: el vocabulario de señales vive en dos sitios y tienen que decir lo mismo", () => {
  // ESTE PROYECTO SE HA COMIDO EL MISMO AGUJERO TRES VECES:
  //   1. faltaban las señales POSITIVAS (el prompt pedía "worse OR better"
  //      pero el esquema sólo nombraba lo peor) → MSFT con resultados
  //      récord salía con dos "mortal" y nada más;
  //   2. faltaba el lado `add` en la mesa de decisión → el partner acababa
  //      siempre en aguantar;
  //   3. faltaba `guidance_reiterada` → reafirmar la guía era inexpresable.
  //
  // Las tres veces la conclusión escrita fue la misma: EL ESQUEMA ES EL
  // TECHO DE LO QUE EL MODELO PUEDE DECIR. Y las tres veces se descubrió
  // leyendo una salida rara, no con un error. Este test es el que convierte
  // el patrón en algo que salta solo: añadir una señal a `SIGNALS` sin
  // ofrecérsela al extractor la deja muerta al nacer, y al revés.
  const listed = SIGNALS.filter((s) => EARNINGS_SYSTEM_PROMPT.includes(s));

  it.each(SIGNALS)("el prompt del extractor ofrece '%s'", (signal) => {
    expect(EARNINGS_SYSTEM_PROMPT).toContain(signal);
  });

  it("no hay señales de más en el prompt que el código no sepa parsear", () => {
    // El espejo: una señal en el prompt que no esté en SIGNALS la descarta
    // `parseAttributions` en silencio — cuota gastada en algo que se tira.
    const enPrompt = [...EARNINGS_SYSTEM_PROMPT.matchAll(/\b[a-z]+_[a-z]+\b/g)]
      .map((m) => m[0])
      .filter((w) => w.startsWith("guidance_") || w.startsWith("nucleo_") || w.startsWith("margen_"));
    const desconocidas = [...new Set(enPrompt)].filter(
      (w) => !(SIGNALS as readonly string[]).includes(w),
    );
    expect(desconocidas).toEqual([]);
  });

  it("toda señal tiene rótulo: el panel no puede pintar una casilla sin nombre", () => {
    for (const s of SIGNALS) {
      expect(SIGNAL_LABEL[s as Signal], `falta SIGNAL_LABEL[${s}]`).toBeTruthy();
    }
  });

  it("las 12 señales están ofrecidas (guarda contra un prompt que se quede corto)", () => {
    expect(listed.length).toBe(SIGNALS.length);
  });
});

describe("hasDecisionEvidence: filtra por PROCEDENCIA, no por presencia", () => {
  const base: DecisionFacts = { contexts: [], pressures: [], dated: [] };

  it("un AI Pick propio NO abre el gate de la postura", () => {
    // El caso que lo motivó: un símbolo sin insiders, sin 13D y sin
    // resultados próximos, pero que salió en un pick hace tres días. Dejar
    // que eso cuente como evidencia convierte la opinión de ayer en el
    // respaldo de hoy — razonamiento circular con aplomo.
    const soloPick: DecisionFacts = {
      ...base,
      dated: [
        {
          symbol: "SOFI",
          date: "2026-07-29",
          text: "tesis del último AI Pick de Catalyst: momentum de miembros",
          provenance: "self",
        },
      ],
    };
    expect(hasDecisionEvidence(soloPick)).toBe(false);
  });

  it("un hecho declarado ante la SEC sí lo abre", () => {
    const declarado: DecisionFacts = {
      ...base,
      dated: [
        {
          symbol: "SOFI",
          date: "2026-08-12",
          text: "resultados, dentro de 11 días",
          provenance: "declared",
        },
      ],
    };
    expect(hasDecisionEvidence(declarado)).toBe(true);
  });

  it("una presión con lado y procedencia declarada lo abre", () => {
    const presion: DecisionFacts = {
      ...base,
      pressures: [
        {
          symbol: "SOFI",
          side: "add",
          text: "insiders neto 30d 2.1M$ en mercado abierto",
          provenance: "declared",
        },
      ],
    };
    expect(hasDecisionEvidence(presion)).toBe(true);
  });

  it("una presión NEUTRAL no basta, aunque esté declarada", () => {
    // Regla previa que se conserva: neutral significa "importa pero no
    // inclina", y una postura no puede apoyarse en algo que no empuja.
    const neutral: DecisionFacts = {
      ...base,
      pressures: [
        {
          symbol: "SOFI",
          side: "neutral",
          text: "days-to-cover 6.2: apuesta contraria acumulada",
          provenance: "declared",
        },
      ],
    };
    expect(hasDecisionEvidence(neutral)).toBe(false);
  });

  it("la aritmética de la cartera cuenta: es verdad comprobable, no opinión", () => {
    const computed: DecisionFacts = {
      ...base,
      pressures: [
        {
          symbol: "MSFT",
          side: "trim",
          text: "pesa 27.6% de tu cartera valorable",
          provenance: "computed",
        },
      ],
    };
    expect(hasDecisionEvidence(computed)).toBe(true);
  });
});
