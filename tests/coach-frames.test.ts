import { describe, expect, it } from "vitest";
import {
  PRESETS,
  PRESET_NAMES,
  SIGNALS,
  describeAxes,
  parseAxes,
  presetOf,
  readingOf,
  severityOf,
  type Axes,
} from "@/lib/coach/frames";
import { judgeTrade, verdictLabel } from "@/lib/coach/measure";
import { verdictHorizonsFor } from "@/lib/coach/horizon";

// Lo que se prueba aquí es el CRITERIO del coach, no aritmética. Un fallo
// silencioso no da un número torcido: da un consejo equivocado sobre dinero
// real, que es la clase de error que hace que dejes de usar la herramienta.

const META: Axes = {
  madurez: "cosechando",
  capital: "alto",
  ciclo: "exogeno",
};

describe("los ejes invierten la lectura de la MISMA señal", () => {
  // EL TEST QUE DEFINE EL MÓDULO. Si estos dos dejan de estar en desacuerdo,
  // el detector ha vuelto a ser un umbral.
  it("capex disparado: esperado con capital alto, mortal en quien ya cosecha sin capex", () => {
    expect(severityOf(PRESETS.power_play, "capex_disparado")).toBe("esperado");
    expect(severityOf(PRESETS.compounder, "capex_disparado")).toBe("mortal");
  });

  it("margen comprimido: esperado construyendo, mortal cosechando sin ciclo", () => {
    expect(severityOf(PRESETS.power_play, "margen_comprimido")).toBe("esperado");
    expect(severityOf(PRESETS.compounder, "margen_comprimido")).toBe("mortal");
  });

  it("guidance recortada: esperado con ciclo exógeno, mortal recuperándose", () => {
    expect(severityOf(PRESETS.ciclica, "guidance_recortada")).toBe("esperado");
    expect(severityOf(PRESETS.turnaround, "guidance_recortada")).toBe("mortal");
  });
});

describe("META — el caso que obligó a pasar de etiquetas a ejes", () => {
  // "Compounder defensivo de capital intensivo, sujeto a ciclicidad
  // macroeconómica exógena". Ninguna de las cuatro etiquetas lo nombra.
  it("no coincide con ningún atajo, y aun así se puede describir", () => {
    expect(presetOf(META)).toBeNull();
    expect(describeAxes(META)).toContain("capital intensivo");
    expect(describeAxes(META)).toContain("exógeno");
  });

  it("el capex y el margen siguen siendo ESPERADOS: es capital intensivo", () => {
    expect(severityOf(META, "capex_disparado")).toBe("esperado");
    expect(severityOf(META, "margen_comprimido")).toBe("esperado");
  });

  // LA REGRESIÓN QUE MOTIVÓ EL REFACTOR. Forzada a `power_play`, META
  // marcaba el núcleo como MORTAL: la próxima recesión publicitaria habría
  // disparado "tesis rota" por el ciclo, no por la empresa.
  it("el núcleo frenándose es VIGILAR, no mortal, porque el ciclo es exógeno", () => {
    expect(severityOf(PRESETS.power_play, "nucleo_desacelera")).toBe("mortal");
    expect(severityOf(META, "nucleo_desacelera")).toBe("vigilar");
    expect(readingOf(META, "nucleo_desacelera", "nucleo").note).toContain(
      "no controla",
    );
  });

  it("perder cuota SÍ sigue siendo mortal: eso no lo explica la macro", () => {
    expect(severityOf(META, "cuota_perdida")).toBe("mortal");
  });

  it("y a plazo largo el precio no emite veredicto en absoluto", () => {
    const v = judgeTrade({
      side: "buy",
      horizon: "largo",
      atHorizon: 30,
      returnPct: -12,
      benchmarkReturnPct: 1,
    });
    expect(v.edgePct).toBeNull();
    expect(v.noVerdict).toBe("plazo_largo_no_se_juzga_por_precio");
    expect(verdictLabel(v)).toBeNull();
    // El movimiento del mercado SÍ se conserva: es contexto legítimo.
    expect(v.marketPct).toBeCloseTo(-13, 6);
  });
});

describe("los cuatro atajos siguen siendo puntos del espacio de ejes", () => {
  it("cada atajo se reconoce a sí mismo", () => {
    for (const name of PRESET_NAMES) {
      expect(presetOf(PRESETS[name])).toBe(name);
    }
  });

  it("no hay dos atajos con los mismos ejes", () => {
    const seen = new Set(
      PRESET_NAMES.map((n) => Object.values(PRESETS[n]).join("|")),
    );
    expect(seen.size).toBe(PRESET_NAMES.length);
  });
});

describe("severityOf — huecos y ausencias", () => {
  it("sin clasificar devuelve null, nunca un default", () => {
    for (const s of SIGNALS) expect(severityOf(null, s)).toBeNull();
  });

  it("toda combinación de ejes da severidad para TODA señal", () => {
    // Sin esto, un hueco en el switch devolvería undefined y la UI lo
    // pintaría como "sin lectura" sobre una posición que SÍ está clasificada.
    for (const madurez of ["cosechando", "construyendo", "recuperandose"] as const) {
      for (const capital of ["alto", "bajo"] as const) {
        for (const ciclo of ["exogeno", "secular"] as const) {
          for (const s of SIGNALS) {
            expect(severityOf({ madurez, capital, ciclo }, s)).toBeDefined();
            expect(severityOf({ madurez, capital, ciclo }, s)).not.toBeNull();
          }
        }
      }
    }
  });

  it("NINGUNA combinación deja 'nucleo_desacelera' en esperado", () => {
    // Que el negocio principal se frene nunca es "tranquilo". Con ciclo
    // exógeno es `vigilar` (podría ser la macro), nunca `esperado`.
    for (const madurez of ["cosechando", "construyendo", "recuperandose"] as const) {
      for (const capital of ["alto", "bajo"] as const) {
        for (const ciclo of ["exogeno", "secular"] as const) {
          expect(
            severityOf({ madurez, capital, ciclo }, "nucleo_desacelera"),
          ).not.toBe("esperado");
        }
      }
    }
  });

  it("insider vendiendo nunca es mortal ni esperado: es ambiguo por naturaleza", () => {
    for (const name of PRESET_NAMES) {
      expect(severityOf(PRESETS[name], "insider_vendiendo")).toBe("vigilar");
    }
    expect(severityOf(META, "insider_vendiendo")).toBe("vigilar");
  });
});

describe("parseAxes — media clasificación no es clasificación", () => {
  it("acepta los tres ejes válidos", () => {
    expect(parseAxes({ madurez: "cosechando", capital: "alto", ciclo: "exogeno" })).toEqual(META);
  });

  it("rechaza si falta cualquiera de los tres", () => {
    // Media clasificación daría media lectura, que es peor que ninguna.
    expect(parseAxes({ madurez: "cosechando", capital: "alto" })).toBeNull();
    expect(parseAxes({ madurez: "cosechando", ciclo: "exogeno" })).toBeNull();
    expect(parseAxes({})).toBeNull();
  });

  it("rechaza valores inventados en vez de mapearlos", () => {
    expect(
      parseAxes({ madurez: "madura", capital: "alto", ciclo: "exogeno" }),
    ).toBeNull();
  });
});

describe("readingOf — la capa desempata lo intermedio", () => {
  it("una señal a vigilar pesa más si golpeó el núcleo", () => {
    const nucleo = readingOf(PRESETS.power_play, "guidance_recortada", "nucleo");
    const oneOff = readingOf(PRESETS.power_play, "guidance_recortada", "no_recurrente");
    expect(nucleo.severity).toBe("vigilar");
    expect(oneOff.severity).toBe("vigilar");
    expect(nucleo.note).not.toBe(oneOff.note);
    expect(oneOff.note).toContain("no se repite");
  });

  it("sin clasificar lo DICE en vez de callar", () => {
    const r = readingOf(null, "margen_comprimido", "nucleo");
    expect(r.severity).toBeNull();
    expect(r.note).toContain("sin clasificar");
  });

  it("la nota nombra el EJE que manda, para poder discutírselo", () => {
    expect(readingOf(META, "capex_disparado", "inversion").note).toContain(
      "capital intensivo",
    );
  });
});

describe("verdictHorizonsFor — qué plazo admite veredicto de precio", () => {
  it("largo no admite ninguno", () => {
    expect(verdictHorizonsFor("largo")).toEqual([]);
  });

  it("sin plazo declarado tampoco", () => {
    expect(verdictHorizonsFor(null)).toEqual([]);
  });

  it("corto se juzga a 1, 7 y 30; medio a 30 y 90", () => {
    expect(verdictHorizonsFor("corto")).toEqual([1, 7, 30]);
    expect(verdictHorizonsFor("medio")).toEqual([30, 90]);
  });

  it("una operación a medio plazo no se juzga por el día siguiente", () => {
    const v = judgeTrade({
      side: "buy",
      horizon: "medio",
      atHorizon: 1,
      returnPct: -8,
      benchmarkReturnPct: 0,
    });
    expect(v.edgePct).toBeNull();
    expect(v.noVerdict).toBe("horizonte_fuera_del_plazo");
  });
});

describe("judgeTrade — convención de signo", () => {
  it("una venta a corto que se pierde una subida es un error", () => {
    const v = judgeTrade({
      side: "sell",
      horizon: "corto",
      atHorizon: 7,
      returnPct: 5,
      benchmarkReturnPct: 1,
    });
    expect(v.edgePct).toBeCloseTo(-4, 6);
    expect(v.basis).toBe("benchmark");
    expect(verdictLabel(v)).toBe("error");
  });

  it("vender antes de una caída GENERAL del mercado no es puntería", () => {
    const v = judgeTrade({
      side: "sell",
      horizon: "corto",
      atHorizon: 7,
      returnPct: -6,
      benchmarkReturnPct: -6,
    });
    expect(v.edgePct).toBeCloseTo(0, 6);
    expect(verdictLabel(v)).toBe("neutro");
  });

  it("sin benchmark se mide contra el mercado y lo declara", () => {
    const v = judgeTrade({
      side: "buy",
      horizon: "corto",
      atHorizon: 7,
      returnPct: 3,
      benchmarkReturnPct: null,
    });
    expect(v.basis).toBe("mercado");
    expect(v.edgePct).toBeCloseTo(3, 6);
  });

  it("un ajuste nunca se juzga", () => {
    const v = judgeTrade({
      side: "adjust",
      horizon: "corto",
      atHorizon: 7,
      returnPct: 20,
      benchmarkReturnPct: 0,
    });
    expect(v.edgePct).toBeNull();
    expect(v.noVerdict).toBe("ajuste_no_es_decision");
  });

  it("el ruido no se etiqueta", () => {
    const v = judgeTrade({
      side: "buy",
      horizon: "corto",
      atHorizon: 7,
      returnPct: 0.6,
      benchmarkReturnPct: 0,
    });
    expect(verdictLabel(v)).toBe("neutro");
  });
});
