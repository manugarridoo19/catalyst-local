import { describe, expect, it } from "vitest";
import { gapFor, inLosses } from "@/lib/metrics/gaps";
import type { TickerMetrics } from "@/lib/metrics/derive";

// Lo que se prueba: que cada raya del panel recibe el motivo CORRECTO y que
// nunca se afirma sin evidencia. Los fixtures calcan los tres casos medidos
// el 2026-08-11 en la watchlist real: RKLB (pérdidas), SOFI (margen
// descartado + banco) y una empresa sin dividendo.

function base(over: Partial<TickerMetrics> = {}): TickerMetrics {
  return {
    forwardPe: null,
    peTtm: null,
    pegTtm: null,
    forwardPeg: null,
    evEbitdaTtm: null,
    psTtm: null,
    pb: null,
    pTbv: null,
    evFcf: null,
    roeTtm: null,
    roicTtm: null,
    grossMarginTtm: null,
    operatingMarginTtm: null,
    netMarginTtm: null,
    fcfMargin: null,
    revenueGrowthTtmYoy: null,
    revenueGrowth3y: null,
    revenueGrowth5y: null,
    epsGrowthTtmYoy: null,
    epsGrowth3y: null,
    fcfCagr5y: null,
    totalDebtToEquity: null,
    currentRatio: null,
    dividendYieldTtm: null,
    payoutRatioTtm: null,
    history: {},
    discarded: [],
    asOf: null,
    ...over,
  };
}

describe("con cifra no hay gap", () => {
  it("devuelve null cuando el valor existe, incluido el 0", () => {
    const m = base({ peTtm: 28.1, dividendYieldTtm: 0 });
    expect(gapFor(m, "peTtm")).toBeNull();
    // 0 es un dato (rentabilidad 0,0%), no un hueco.
    expect(gapFor(m, "dividendYieldTtm")).toBeNull();
  });
});

describe("pérdidas: solo con evidencia del payload", () => {
  // El caso RKLB medido: margen neto negativo, sin P/E, sin dividendo.
  const rklb = base({ psTtm: 25.3, netMarginTtm: -34.1 });

  it("P/E, PEG y crecimientos de BPA caen a «pérdidas»", () => {
    expect(gapFor(rklb, "peTtm")?.label).toBe("pérdidas");
    expect(gapFor(rklb, "pegTtm")?.label).toBe("pérdidas");
    expect(gapFor(rklb, "epsGrowthTtmYoy")?.label).toBe("pérdidas");
    expect(gapFor(rklb, "epsGrowth3y")?.label).toBe("pérdidas");
  });

  it("EV/EBITDA ausente NO se atribuye a pérdidas: una pérdida neta no implica EBITDA negativo", () => {
    expect(gapFor(rklb, "evEbitdaTtm")?.label).toBe("no publica");
  });

  it("sin margen neto ni descarte de P/E no se afirma: cae a «no publica»", () => {
    // NU rentable con epsGrowth3y ausente (base probablemente negativa, pero
    // el payload no lo demuestra): afirmar «pérdidas» sería inventar.
    const nu = base({ peTtm: 30.9, netMarginTtm: 26.8 });
    expect(inLosses(nu)).toBe(false);
    expect(gapFor(nu, "epsGrowth3y")?.label).toBe("no publica");
  });

  it("el descarte de P/E por BPA negativo también es evidencia de pérdidas", () => {
    // Gate de coherencia: peTtm descartado SOLO existe cuando el BPA era
    // negativo. Ahí el PEG puede decir «pérdidas» aunque el margen no esté.
    const m = base({
      psTtm: 6.1,
      discarded: [{ field: "peTtm", reason: "P/E 36.8 con BPA -0.12 — incompatibles" }],
    });
    expect(inLosses(m)).toBe(true);
    expect(gapFor(m, "pegTtm")?.label).toBe("pérdidas");
    // Pero la fila del propio P/E dice «descartado»: la fuente SÍ publicó un
    // número y se tiró — eso pide otra reacción que un dato inexistente.
    expect(gapFor(m, "peTtm")?.label).toBe("descartado");
  });
});

describe("descartado: la razón medida viaja con la etiqueta", () => {
  // El caso SOFI medido: margen neto −19,79% contradiciendo BPA y ROE
  // positivos → el gate tira la FAMILIA (neto + operativo).
  const sofi = base({
    peTtm: 36.8,
    psTtm: 8.4,
    roeTtm: 6.18,
    discarded: [
      {
        field: "margins",
        reason: "margen neto -19.8% contradice BPA 0.47 y ROE 6.18% — denominador incoherente en la fuente",
      },
    ],
  });

  it("«margins» cubre neto Y operativo", () => {
    expect(gapFor(sofi, "netMarginTtm")?.label).toBe("descartado");
    expect(gapFor(sofi, "operatingMarginTtm")?.label).toBe("descartado");
    expect(gapFor(sofi, "netMarginTtm")?.why).toContain("denominador incoherente");
  });

  it("una empresa rentable con margen descartado NO está «en pérdidas»", () => {
    expect(inLosses(sofi)).toBe(false);
    expect(gapFor(sofi, "epsGrowth3y")?.label).toBe("no publica");
  });
});

describe("dividendo", () => {
  it("las DOS claves ausentes → «no paga»", () => {
    const m = base({ psTtm: 25.3 });
    expect(gapFor(m, "dividendYieldTtm")?.label).toBe("no paga");
    expect(gapFor(m, "payoutRatioTtm")?.label).toBe("no paga");
  });

  it("con yield presente, un payout ausente es «no publica», no «no paga»", () => {
    const m = base({ psTtm: 8.4, dividendYieldTtm: 0.8 });
    expect(gapFor(m, "payoutRatioTtm")?.label).toBe("no publica");
  });
});
