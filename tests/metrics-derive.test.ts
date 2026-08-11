import { describe, expect, it } from "vitest";
import { deriveMetrics, historyStat } from "@/lib/metrics/derive";
import type { FinnhubBasicFinancials, MetricPoint } from "@/lib/providers/finnhub";

// Lo que se prueba aquí no es aritmética de ratios: son las tres formas
// MEDIDAS en que este payload engaña a quien lo lee entero. Un fallo aquí no
// da un número raro en pantalla — mete una cifra falsa en el prompt de una
// decisión de dinero, que es el modo de fallo que nadie audita.

/** Serie descendente (más reciente primero), como la devuelve Finnhub. */
function series(values: number[], from = 2026): MetricPoint[] {
  return values.map((v, i) => ({
    period: `${from - Math.floor(i / 4)}-${String(12 - (i % 4) * 3).padStart(2, "0")}-30`,
    v,
  }));
}

function payload(
  metric: Record<string, unknown>,
  quarterly: Record<string, MetricPoint[]> = {},
): FinnhubBasicFinancials {
  return { metric, series: { quarterly } };
}

describe("unidades: la serie va en fracción y el objeto plano en porcentaje", () => {
  // Medido 2026-08-11 sobre MSFT: series.quarterly.roicTTM[0].v = 0,265
  // mientras metric.roeTTM = 33,22. Sin normalizar, el panel enseñaría
  // "ROIC 0,27%" al lado de "ROE 33,22%" y nadie lo leería como un bug.
  it("multiplica por 100 lo que viene de la serie", () => {
    const m = deriveMetrics(
      payload({}, { roicTTM: series([0.265, 0.31]), fcfMargin: series([0.2182]) }),
    );
    expect(m.roicTtm).toBeCloseTo(26.5, 4);
    expect(m.fcfMargin).toBeCloseTo(21.82, 4);
  });

  it("NO toca los adimensionales del objeto plano", () => {
    const m = deriveMetrics(
      payload({
        "totalDebt/totalEquityQuarterly": 0.2416,
        currentRatioQuarterly: 1.2303,
      }),
    );
    expect(m.totalDebtToEquity).toBe(0.2416);
    expect(m.currentRatio).toBe(1.2303);
  });

  it("lee el punto MÁS RECIENTE, que es el primero del array", () => {
    // Finnhub va de 2026-06-30 a 1990-03-31. Asumir orden ascendente daría
    // el ROIC de hace 36 años sin ningún síntoma visible.
    const m = deriveMetrics(payload({}, { roicTTM: series([0.265, 0.9, 0.01]) }));
    expect(m.roicTtm).toBeCloseTo(26.5, 4);
  });

  it("cae a roiTTM del objeto plano si la serie no trae roicTTM", () => {
    // `roicTTM` NO existe en el objeto plano (verificado): sin este respaldo,
    // un símbolo sin serie se quedaría sin la métrica de calidad principal.
    const m = deriveMetrics(payload({ roiTTM: 26.5 }));
    expect(m.roicTtm).toBe(26.5);
  });
});

describe("percentil contra su propia historia", () => {
  it("bajo = barato: sitúa el múltiplo vivo en su distribución", () => {
    // Ventana real de MSFT (20 trimestres) con P/E vivo 28,08 → percentil 25.
    const w = [
      20.7, 22.0, 30.1, 36.7, 36.3, 28.9, 33.8, 35.3, 38.5, 36.6, 33.9, 31.0,
      35.0, 31.1, 26.5, 24.9, 26.4, 31.9, 35.5, 31.2,
    ];
    const stat = historyStat(series(w), 28.0774);
    expect(stat).not.toBeNull();
    expect(stat!.pctile).toBe(25);
    expect(stat!.median).toBeCloseTo(31.55, 2);
    expect(stat!.n).toBe(20);
  });

  it("EXCLUYE los tramos en pérdidas en vez de tratarlos como baratos", () => {
    // Una empresa que pasa de pérdidas a beneficios: si los P/E negativos
    // entran en la distribución, el múltiplo de hoy sale carísimo comparado
    // con unos números que no eran múltiplos.
    const conNegativos = [...Array(8).fill(-15), ...Array(12).fill(40)];
    const stat = historyStat(series(conNegativos), 30);
    expect(stat!.n).toBe(12); // sólo los 12 positivos
    expect(stat!.pctile).toBe(0); // 30 es más barato que sus 12 trimestres válidos
    expect(stat!.median).toBe(40);
  });

  it("devuelve null por debajo del mínimo de trimestres", () => {
    // 4 observaciones hacen que cualquier valor caiga en 0/25/50/75/100: el
    // percentil existiría y no significaría nada.
    expect(historyStat(series([20, 25, 30, 35]), 22)).toBeNull();
  });

  it("no publica percentil de un múltiplo que el gate tiró", () => {
    // Si el percentil se calculara antes del gate, un P/E descartado por
    // incoherente volvería a entrar por la puerta de atrás con su percentil.
    const m = deriveMetrics(
      payload(
        { peTTM: 30, epsTTM: -1.2 },
        { peTTM: series(Array(20).fill(35)) },
      ),
    );
    expect(m.peTtm).toBeNull();
    expect(m.history.pe).toBeUndefined();
  });
});

describe("gate de coherencia", () => {
  it("el caso SOFI: margen neto negativo con BPA y ROE positivos", () => {
    // Medido 2026-08-11: netProfitMarginTTM −19,79 con epsTTM +0,47,
    // roeTTM +6,18 y peTTM 36,78. El denominador de la fuente no es el
    // ingreso de un banco.
    const m = deriveMetrics(
      payload({
        netProfitMarginTTM: -19.78861,
        operatingMarginTTM: -19.92119,
        epsTTM: 0.4736,
        roeTTM: 6.18,
        peTTM: 36.7823,
        forwardPE: 22.53474,
      }),
    );
    expect(m.netMarginTtm).toBeNull();
    // Cae la FAMILIA: neto y operativo dividen por el mismo ingreso roto.
    expect(m.operatingMarginTtm).toBeNull();
    // Lo que no depende de ese denominador sobrevive.
    expect(m.roeTtm).toBe(6.18);
    expect(m.forwardPe).toBeCloseTo(22.53, 2);
    // Y queda constancia: un dato ausente y un dato descartado piden
    // reacciones distintas.
    expect(m.discarded.map((d) => d.field)).toContain("margins");
  });

  it("una empresa que PIERDE de verdad conserva su margen negativo", () => {
    // El contraejemplo obligatorio: sin él, el gate borraría el dato correcto
    // de toda empresa en pérdidas y el panel diría que no se sabe.
    const m = deriveMetrics(
      payload({
        netProfitMarginTTM: -34.07,
        operatingMarginTTM: -34.07,
        epsTTM: -0.42,
        roeTTM: -12.26,
      }),
    );
    expect(m.netMarginTtm).toBe(-34.07);
    expect(m.operatingMarginTtm).toBe(-34.07);
    expect(m.discarded).toHaveLength(0);
  });

  it("un múltiplo negativo es null, nunca 'barato'", () => {
    const m = deriveMetrics(
      payload({ peTTM: -12.4, psTTM: -3, evEbitdaTTM: -8, forwardPE: -20 }),
    );
    expect(m.peTtm).toBeNull();
    expect(m.psTtm).toBeNull();
    expect(m.evEbitdaTtm).toBeNull();
    expect(m.forwardPe).toBeNull();
  });

  it("margen bruto fuera del rango contable cae con nota", () => {
    const m = deriveMetrics(payload({ grossMarginTTM: 140 }));
    expect(m.grossMarginTtm).toBeNull();
    expect(m.discarded.map((d) => d.field)).toContain("grossMarginTtm");
  });
});

describe("cobertura ausente", () => {
  it("un símbolo sin datos no inventa ceros", () => {
    const m = deriveMetrics(payload({}, {}));
    expect(m.forwardPe).toBeNull();
    expect(m.peTtm).toBeNull();
    expect(m.history).toEqual({});
    expect(m.asOf).toBeNull();
  });

  it("RKLB: sin P/E ni EV/EBITDA, pero con P/S y margen bruto", () => {
    // Medido: una power play en pérdidas no tiene cuatro de las casillas del
    // checklist clásico. Su ausencia es la respuesta correcta, no un suspenso.
    const m = deriveMetrics(
      payload({ psTTM: 70.45, grossMarginTTM: 36.56, operatingMarginTTM: -34.07 }),
    );
    expect(m.peTtm).toBeNull();
    expect(m.evEbitdaTtm).toBeNull();
    expect(m.psTtm).toBe(70.45);
    expect(m.grossMarginTtm).toBe(36.56);
  });
});
