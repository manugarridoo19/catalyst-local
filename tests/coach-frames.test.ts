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
import { movedAfter } from "@/lib/coach/build";
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

describe("readingOf — el gate de cita sobre lo mortal", () => {
  // El caso MSFT del 2026-07-31: dos "mortal" con quote null — la capa era
  // inferencia del extractor, no declaración de la empresa — y el panel
  // afirmaba "golpea la tesis en su raíz" con total confianza. Misma
  // doctrina que los falsadores: la afirmación más dura exige la cita.
  it("mortal CON la frase de la empresa se afirma", () => {
    const r = readingOf(
      PRESETS.compounder,
      "capex_disparado",
      "inversion",
      "capital expenditures increased to fund datacenter expansion",
    );
    expect(r.severity).toBe("mortal");
    expect(r.note).toContain("raíz");
  });

  it("mortal SIN cita se degrada a vigilar y lo dice", () => {
    const r = readingOf(PRESETS.compounder, "capex_disparado", "inversion", null);
    expect(r.severity).toBe("vigilar");
    expect(r.note).toContain("no se afirma");
  });

  it("capex en marco de capex bajo pregunta si lo desfasado es el MARCO", () => {
    // La otra mitad del caso MSFT: declarada compounder de capex bajo
    // mientras invierte 35,8B$/trimestre. El coach no puede elegir entre
    // "tesis golpeada" y "clasificación vieja" — tiene que plantear las dos.
    const sinCita = readingOf(PRESETS.compounder, "capex_disparado", "inversion", null);
    expect(sinCita.note).toContain("MARCO");
    const conCita = readingOf(
      PRESETS.compounder,
      "capex_disparado",
      "inversion",
      "driven by record investment in AI infrastructure",
    );
    expect(conCita.severity).toBe("mortal");
    expect(conCita.note).toContain("MARCO");
  });
});

describe("señales positivas — el espejo que faltaba", () => {
  // Sin ellas, un trimestre excepcional producía SOLO sus grietas menores y
  // el coach salía bajista por construcción (MSFT: resultados récord → dos
  // "mortal" y nada más en el panel).
  it("el núcleo acelerando confirma la tesis… salvo que el ciclo sople a favor", () => {
    // El par en desacuerdo, como capex esperado/mortal: si estas dos
    // convergen, la señal positiva ha dejado de leer el marco.
    expect(severityOf(PRESETS.compounder, "nucleo_acelera")).toBe("confirma");
    expect(severityOf(META, "nucleo_acelera")).toBe("esperado");
    expect(readingOf(META, "nucleo_acelera", "nucleo").note).toContain("viento de cola");
  });

  it("elevar guidance es la dirección comprometiéndose: confirma incluso con ciclo", () => {
    expect(severityOf(PRESETS.ciclica, "guidance_elevada")).toBe("confirma");
    expect(severityOf(PRESETS.turnaround, "guidance_elevada")).toBe("confirma");
  });

  it("ninguna señal positiva puede salir mortal ni vigilar", () => {
    for (const madurez of ["cosechando", "construyendo", "recuperandose"] as const) {
      for (const capital of ["alto", "bajo"] as const) {
        for (const ciclo of ["exogeno", "secular"] as const) {
          for (const s of ["nucleo_acelera", "margen_expandido", "guidance_elevada"] as const) {
            const sev = severityOf({ madurez, capital, ciclo }, s);
            expect(sev === "confirma" || sev === "esperado").toBe(true);
          }
        }
      }
    }
  });

  it("la nota de confirma dice QUÉ se está cumpliendo, no un aplauso genérico", () => {
    const r = readingOf(PRESETS.compounder, "nucleo_acelera", "nucleo");
    expect(r.severity).toBe("confirma");
    expect(r.note).toContain("cumpliéndose");
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

// El rastro del marco. Lo que se custodia aquí no es una comparación de
// cadenas: es la condición bajo la que el panel se atreve a decir que la
// vara se movió sabiendo ya el resultado. Un falso positivo acusa al
// usuario de algo que no hizo; un falso negativo deja pasar exactamente el
// sesgo que el log existe para cazar.
describe("marco movido después del hecho", () => {
  it("cambio posterior al comunicado: se marca", () => {
    expect(movedAfter("2026-08-02", "2026-07-29")).toBe(true);
  });

  it("cambio anterior al comunicado: NO se marca, es historia y no sesgo", () => {
    expect(movedAfter("2026-07-01", "2026-07-29")).toBe(false);
  });

  // EL CASO QUE FIJA LA DOCTRINA. Con resolución de día, "el mismo día" no
  // distingue haberlo cambiado antes de leer el comunicado de haberlo
  // cambiado después. El coach no afirma lo que no puede probar: igual que
  // un `mortal` sin cita de la empresa baja a `vigilar`.
  it("mismo día: NO se marca — no se puede probar el orden", () => {
    expect(movedAfter("2026-07-29", "2026-07-29")).toBe(false);
  });

  it("sin comunicado o sin cambio registrado no hay nada que comparar", () => {
    expect(movedAfter("2026-08-02", null)).toBe(false);
    expect(movedAfter(null, "2026-07-29")).toBe(false);
    expect(movedAfter(null, null)).toBe(false);
  });

  // El año manda sobre el día: `"2026-01-05" > "2025-12-31"` es cierto por
  // orden lexicográfico SÓLO porque el formato es YYYY-MM-DD con relleno de
  // ceros. Si alguna vez el SQL devuelve DD-MM o quita el cero, esto rompe.
  it("cruza el año sin invertirse (depende del formato YYYY-MM-DD)", () => {
    expect(movedAfter("2026-01-05", "2025-12-31")).toBe(true);
    expect(movedAfter("2025-12-31", "2026-01-05")).toBe(false);
  });
});
