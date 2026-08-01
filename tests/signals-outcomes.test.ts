import { describe, expect, it } from "vitest";
import {
  benchmarkReturn,
  findBaselineDate,
  horizonReturn,
} from "@/lib/signals/outcomes";
import { judgeTrade, verdictLabel } from "@/lib/coach/measure";
import { deriveAggregates } from "@/lib/ask/portfolio";
import type { AdjCloseSeries } from "@/lib/providers/yahoo";

// La aritmética de este archivo está CONGELADA (CLAUDE.md, Signal Lab):
// cambiarla invalida toda comparación histórica del Lab y del coach. Estos
// tests no documentan el comportamiento — lo custodian. Si uno falla tras
// tocar lib/signals/outcomes.ts, lo roto es el cambio, no el test.

function series(dates: string[], closes?: Record<string, number>): AdjCloseSeries {
  const m = new Map<string, number>();
  for (const [i, d] of dates.entries()) m.set(d, closes?.[d] ?? 100 + i);
  if (closes) for (const [d, v] of Object.entries(closes)) m.set(d, v);
  return { dates, closes: m };
}

// Sesiones reales de julio 2026: 03-07 festivo (July 4 observado) y fines
// de semana fuera. El hueco es la gracia: los "días hábiles" son posiciones
// en ESTA serie, no aritmética de calendario.
const JULY = series([
  "2026-06-30",
  "2026-07-01",
  "2026-07-02",
  "2026-07-06",
  "2026-07-07",
  "2026-07-08",
  "2026-07-09",
  "2026-07-10",
  "2026-07-13",
  "2026-07-14",
]);

describe("findBaselineDate — la primera sesión ACCIONABLE", () => {
  it("señal antes del cierre en día de sesión → base ese mismo día", () => {
    // 2026-07-01 18:00Z = 14:00 ET (EDT): el usuario pudo actuar ese día.
    const ms = Date.UTC(2026, 6, 1, 18, 0, 0);
    expect(findBaselineDate(JULY, ms)).toBe("2026-07-01");
  });

  it("señal tras las 16:00 ET → la base es la SIGUIENTE sesión", () => {
    // 20:30Z = 16:30 ET: ese cierre ya era pasado cuando nació la señal.
    const ms = Date.UTC(2026, 6, 1, 20, 30, 0);
    expect(findBaselineDate(JULY, ms)).toBe("2026-07-02");
  });

  it("fin de semana → siguiente sesión, saltando el festivo por la serie", () => {
    // Sábado 2026-07-11: la siguiente sesión de la serie es el lunes 13.
    const ms = Date.UTC(2026, 6, 11, 15, 0, 0);
    expect(findBaselineDate(JULY, ms)).toBe("2026-07-13");
  });

  it("festivo de mercado entre semana → siguiente sesión de la serie", () => {
    // Viernes 2026-07-03 (mercado cerrado): no está en la serie → 07-06.
    const ms = Date.UTC(2026, 6, 3, 16, 0, 0);
    expect(findBaselineDate(JULY, ms)).toBe("2026-07-06");
  });

  it("en INVIERNO el corte de las 16:00 va en EST, no en el offset de verano", () => {
    const JAN = series(["2026-01-14", "2026-01-15", "2026-01-16"]);
    // 20:30Z = 15:30 EST (antes del cierre). Con el offset de verano clavado
    // (UTC-4) se leería 16:30 y saltaría a la sesión siguiente — el mismo
    // sesgo estacional del bug del reset Pacific del audit 2026-08-01.
    const beforeClose = Date.UTC(2026, 0, 15, 20, 30, 0);
    expect(findBaselineDate(JAN, beforeClose)).toBe("2026-01-15");
    // 21:30Z = 16:30 EST: ahora sí, después del cierre.
    const afterClose = Date.UTC(2026, 0, 15, 21, 30, 0);
    expect(findBaselineDate(JAN, afterClose)).toBe("2026-01-16");
  });

  it("sin sesión posterior en la serie → null, nunca una base del pasado", () => {
    const ms = Date.UTC(2026, 6, 20, 15, 0, 0);
    expect(findBaselineDate(JULY, ms)).toBeNull();
  });
});

describe("horizonReturn — horizontes como POSICIONES en la serie de sesiones", () => {
  const closes = series(JULY.dates, {
    "2026-07-02": 100,
    "2026-07-08": 108,
  });

  it("cuenta sesiones reales: 3 hábiles desde 07-02 caen en 07-08 (festivo+finde por medio)", () => {
    const p = horizonReturn(closes, "2026-07-02", 3, "2026-07-20");
    expect(p?.targetDate).toBe("2026-07-08");
    expect(p?.returnPct).toBeCloseTo(8, 10);
  });

  it("horizonte aún no madurado (fuera de la serie) → null", () => {
    expect(horizonReturn(closes, "2026-07-13", 30, "2026-07-20")).toBeNull();
  });

  it("NUNCA mide contra la sesión en curso: target >= hoy ET → null", () => {
    // Con el mercado abierto, el slot de "hoy" de Yahoo es el último precio,
    // no un cierre — medirlo contaminaría el registro con datos no finales.
    expect(horizonReturn(closes, "2026-07-02", 3, "2026-07-08")).toBeNull();
  });

  it("base ausente de la serie → null", () => {
    expect(horizonReturn(closes, "2026-07-04", 1, "2026-07-20")).toBeNull();
  });
});

describe("benchmarkReturn — mismas DOS fechas que el punto medido", () => {
  const spy = series(["2026-07-02", "2026-07-08"], {
    "2026-07-02": 500,
    "2026-07-08": 510,
  });

  it("con las dos fechas presentes devuelve el retorno del benchmark", () => {
    const r = benchmarkReturn(spy, {
      baselineDate: "2026-07-02",
      targetDate: "2026-07-08",
    });
    expect(r).toBeCloseTo(2, 10);
  });

  it("si al benchmark le falta una de las fechas → null (y el caller NO escribe la fila)", () => {
    expect(
      benchmarkReturn(spy, { baselineDate: "2026-07-02", targetDate: "2026-07-09" }),
    ).toBeNull();
  });
});

describe("judgeTrade — la convención de signo y las cuatro salidas sin veredicto", () => {
  const base = {
    returnPct: 5,
    benchmarkReturnPct: 2,
    atHorizon: 7,
  } as const;

  it("ajuste → nunca es una decisión de mercado", () => {
    const v = judgeTrade({ ...base, side: "adjust", horizon: "corto" });
    expect(v.noVerdict).toBe("ajuste_no_es_decision");
    expect(v.edgePct).toBeNull();
    // El movimiento del mercado se devuelve igual: es contexto legítimo.
    expect(v.marketPct).toBeCloseTo(3, 10);
  });

  it("sin plazo declarado → sin veredicto", () => {
    const v = judgeTrade({ ...base, side: "buy", horizon: null });
    expect(v.noVerdict).toBe("sin_plazo_declarado");
  });

  it("largo → el precio no juzga una tesis de años (rama de código, no prompt)", () => {
    const v = judgeTrade({ ...base, side: "buy", horizon: "largo" });
    expect(v.noVerdict).toBe("plazo_largo_no_se_juzga_por_precio");
  });

  it("horizonte fuera del plazo → cada plazo sólo responde en sus horizontes", () => {
    const v = judgeTrade({ ...base, side: "buy", horizon: "corto", atHorizon: 90 });
    expect(v.noVerdict).toBe("horizonte_fuera_del_plazo");
  });

  it("COMPRA: edge = +exceso sobre SPY", () => {
    const v = judgeTrade({ ...base, side: "buy", horizon: "corto" });
    expect(v.edgePct).toBeCloseTo(3, 10);
    expect(v.basis).toBe("benchmark");
  });

  it("VENTA: edge = −exceso (el contrafactual de vender es no haber vendido)", () => {
    const v = judgeTrade({ ...base, side: "sell", horizon: "corto" });
    expect(v.edgePct).toBeCloseTo(-3, 10);
  });

  it("sin benchmark disponible degrada a mercado crudo y lo DICE en basis", () => {
    const v = judgeTrade({
      ...base,
      side: "sell",
      horizon: "corto",
      benchmarkReturnPct: null,
    });
    expect(v.basis).toBe("mercado");
    expect(v.edgePct).toBeCloseTo(-5, 10);
  });

  it("verdictLabel: la banda de ruido no etiqueta el ±1%", () => {
    expect(verdictLabel({ edgePct: 0.5, basis: "benchmark", noVerdict: null, marketPct: 0.5 })).toBe("neutro");
    expect(verdictLabel({ edgePct: 1.5, basis: "benchmark", noVerdict: null, marketPct: 1.5 })).toBe("acierto");
    expect(verdictLabel({ edgePct: -1.5, basis: "benchmark", noVerdict: null, marketPct: -1.5 })).toBe("error");
    expect(verdictLabel({ edgePct: null, basis: null, noVerdict: "sin_plazo_declarado", marketPct: 2 })).toBeNull();
  });
});

describe("deriveAggregates — números que llegan a pantalla sin pasar por el LLM", () => {
  // Sólo los campos que la función lee; el resto del shape no participa.
  type FactsArg = Parameters<typeof deriveAggregates>[0];
  type PortfolioArg = Parameters<typeof deriveAggregates>[1];

  const facts = [
    { symbol: "AAA", beta: 2, nextEarnings: "2026-08-10" },
    { symbol: "BBB", beta: null, nextEarnings: "2026-08-10" },
    { symbol: "CCC", beta: 1, nextEarnings: null },
  ] as unknown as FactsArg;

  const portfolio = {
    positions: [
      { symbol: "AAA", weightPct: 40 },
      { symbol: "BBB", weightPct: null }, // sin precio ese día
      { symbol: "CCC", weightPct: 30 },
    ],
  } as unknown as PortfolioArg;

  it("beta ponderada REESCALADA al peso con beta conocida, y declara la cobertura", () => {
    const d = deriveAggregates(facts, portfolio);
    // AAA (beta 2, peso 40) + CCC (beta 1, peso 30) → (2·40+1·30)/70.
    expect(d.weightedBeta).toBeCloseTo(110 / 70, 10);
    expect(d.betaCoveragePct).toBeCloseTo(70, 10);
  });

  it("posición sin precio NO entra como 0% en el cluster: sale en unpricedSymbols", () => {
    const d = deriveAggregates(facts, portfolio);
    const cluster = d.earningsClusters.find((c) => c.date === "2026-08-10");
    expect(cluster?.weightPct).toBeCloseTo(40, 10);
    expect(cluster?.unpricedSymbols).toEqual(["BBB"]);
    expect(cluster?.symbols).toEqual(["AAA", "BBB"]);
  });
});
