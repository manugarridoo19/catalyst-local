import { describe, expect, it } from "vitest";
import {
  FRAMES,
  FRAME_SPEC,
  SIGNALS,
  readingOf,
  severityOf,
} from "@/lib/coach/frames";
import { judgeTrade, verdictLabel } from "@/lib/coach/measure";
import { verdictHorizonsFor } from "@/lib/coach/horizon";

// Lo que se prueba aquí es el CRITERIO del coach, no aritmética. Un fallo
// silencioso no da un número torcido: da un consejo equivocado sobre dinero
// real, que es la clase de error que hace que dejes de usar la herramienta.

describe("el marco invierte la lectura de la MISMA señal", () => {
  // EL TEST QUE DEFINE EL MÓDULO. Si estos dos dejan de estar en desacuerdo,
  // el detector ha vuelto a ser un umbral y el caso META vuelve a fallar.
  it("capex disparado: esperado en power play, mortal en compounder", () => {
    expect(severityOf("power_play", "capex_disparado")).toBe("esperado");
    expect(severityOf("compounder", "capex_disparado")).toBe("mortal");
  });

  it("margen comprimido: esperado en power play, mortal en compounder", () => {
    expect(severityOf("power_play", "margen_comprimido")).toBe("esperado");
    expect(severityOf("compounder", "margen_comprimido")).toBe("mortal");
  });

  it("guidance recortada: esperado en una cíclica, mortal en un turnaround", () => {
    // En el valle del ciclo recortar guidance es el guion. En un turnaround
    // es incumplir justo lo que se compró.
    expect(severityOf("ciclica", "guidance_recortada")).toBe("esperado");
    expect(severityOf("turnaround", "guidance_recortada")).toBe("mortal");
  });
});

describe("el caso META", () => {
  // Compra de META declarada `largo` + marco power play, con el margen
  // estrechado por capex de IA y provisiones legales.
  it("no marca como grieta lo que es la tesis ejecutándose", () => {
    const r = readingOf("power_play", "margen_comprimido", "inversion");
    expect(r.severity).toBe("esperado");
    expect(r.note).toContain("lo esperado");
  });

  it("pero el núcleo frenándose SÍ es mortal en ese mismo marco", () => {
    // Ésta es la asimetría que un umbral sobre márgenes nunca ve.
    const r = readingOf("power_play", "nucleo_desacelera", "nucleo");
    expect(r.severity).toBe("mortal");
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
    // El movimiento del mercado SÍ se conserva: es contexto legítimo, lo
    // que no es legítimo es llamarlo error.
    expect(v.marketPct).toBeCloseTo(-13, 6);
  });
});

describe("severityOf — huecos y ausencias", () => {
  it("sin marco declarado devuelve null, nunca un default", () => {
    // Un default leería mal la mitad de las carteras. Preferimos no leer.
    for (const s of SIGNALS) expect(severityOf(null, s)).toBeNull();
  });

  it("una señal no listada cae en 'vigilar', nunca en 'esperado'", () => {
    // Callar sobre lo desconocido sería tranquilizar sin base.
    for (const f of FRAMES) {
      for (const s of SIGNALS) {
        const explicit = FRAME_SPEC[f].severity[s];
        if (explicit === undefined) expect(severityOf(f, s)).toBe("vigilar");
      }
    }
  });

  it("ningún marco deja 'nucleo_desacelera' en esperado salvo la cíclica", () => {
    // Que el negocio principal se frene sólo es normal cuando el ciclo lo
    // explica. En cualquier otro marco, tratarlo como normal sería el fallo
    // más caro posible.
    for (const f of FRAMES) {
      if (f === "ciclica") continue;
      expect(severityOf(f, "nucleo_desacelera")).not.toBe("esperado");
    }
  });
});

describe("readingOf — la capa desempata lo intermedio", () => {
  it("una señal a vigilar pesa más si golpeó el núcleo", () => {
    const nucleo = readingOf("power_play", "guidance_recortada", "nucleo");
    const oneOff = readingOf("power_play", "guidance_recortada", "no_recurrente");
    expect(nucleo.severity).toBe("vigilar");
    expect(oneOff.severity).toBe("vigilar");
    expect(nucleo.note).not.toBe(oneOff.note);
    expect(oneOff.note).toContain("no se repite");
  });

  it("sin marco lo DICE en vez de callar", () => {
    const r = readingOf(null, "margen_comprimido", "nucleo");
    expect(r.severity).toBeNull();
    expect(r.note).toContain("sin marco");
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
    // Exceso +4 sobre SPY; vender se lo perdió → −4.
    expect(v.edgePct).toBeCloseTo(-4, 6);
    expect(v.basis).toBe("benchmark");
    expect(verdictLabel(v)).toBe("error");
  });

  it("vender antes de una caída GENERAL del mercado no es puntería", () => {
    // La acción cae 6 y SPY cae 6: el exceso es 0, así que el "acierto"
    // vale exactamente lo que vale.
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
