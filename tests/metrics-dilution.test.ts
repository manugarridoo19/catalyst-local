import { describe, it, expect } from "vitest";
import {
  canonicalPoints,
  pickYoY,
  deriveDilution,
  type XbrlPoint,
} from "@/lib/metrics/dilution";

// DILUCIÓN: lo que se mide es el CONTEO DE ACCIONES, no las recompras.
//
// Una empresa puede anunciar recompras milmillonarias y acabar el año con más
// acciones, si el pago en acciones emite más de lo que la recompra retira.
// Por eso el titular es el resultado y no la intención.
//
// Todo lo delicado está en emparejar periodos, y los dos fallos posibles son
// silenciosos: dan un número plausible.

const p = (
  start: string,
  end: string,
  val: number,
  filed: string,
  form = "10-Q",
): XbrlPoint => ({ start, end, val, filed, form });

describe("canonicalPoints: `fy` identifica el INFORME, no el periodo", () => {
  it("un periodo repetido por reexpresión colapsa en su presentación más reciente", () => {
    // El caso real de MSFT: el año 2023-07-01→2024-06-30 aparece con fy 2024,
    // 2025 y 2026 (más una copia en un 8-K) porque cada 10-K reexpresa los
    // ejercicios anteriores como comparativos. Si esto no colapsara, el
    // emparejamiento interanual elegiría una copia arbitraria.
    const puntos: XbrlPoint[] = [
      { ...p("2023-07-01", "2024-06-30", 7_469_000_000, "2024-07-30", "10-K"), fy: 2024, fp: "FY" },
      { ...p("2023-07-01", "2024-06-30", 7_469_000_000, "2025-07-30", "10-K"), fy: 2025, fp: "FY" },
      { ...p("2023-07-01", "2024-06-30", 7_400_000_000, "2026-07-30", "10-K"), fy: 2026, fp: "FY" },
    ];
    const c = canonicalPoints(puntos);
    expect(c).toHaveLength(1);
    // Gana la presentación más reciente: es la versión vigente del periodo.
    expect(c[0].val).toBe(7_400_000_000);
  });

  it("descarta puntos de saldo (sin `start`) y valores no finitos", () => {
    const puntos = [
      { end: "2026-06-30", val: 100, filed: "2026-07-01", form: "10-Q" },
      p("2026-04-01", "2026-06-30", Number.NaN, "2026-07-01"),
      p("2026-04-01", "2026-06-30", 500, "2026-07-01"),
    ] as XbrlPoint[];
    expect(canonicalPoints(puntos)).toHaveLength(1);
  });

  it("devuelve ordenado por fin de periodo ascendente", () => {
    const c = canonicalPoints([
      p("2026-04-01", "2026-06-30", 3, "2026-07-01"),
      p("2025-04-01", "2025-06-30", 1, "2025-07-01"),
      p("2025-10-01", "2025-12-31", 2, "2026-01-01"),
    ]);
    expect(c.map((x) => x.val)).toEqual([1, 2, 3]);
  });
});

describe("pickYoY: las dos puntas SIEMPRE de la misma cadencia", () => {
  it("compara trimestre contra el mismo trimestre del año anterior", () => {
    const c = pickYoY([
      p("2025-04-01", "2025-06-30", 515_000_000, "2025-08-01"),
      p("2025-07-01", "2025-09-30", 540_000_000, "2025-11-01"),
      p("2026-04-01", "2026-06-30", 630_000_000, "2026-08-01"),
    ]);
    expect(c?.cadence).toBe("quarterly");
    expect(c?.latest.val).toBe(630_000_000);
    // El homólogo es el trimestre de hace un año, NO el inmediatamente
    // anterior: comparar contra el trimestre previo mediría otra cosa y
    // saldría un número perfectamente creíble.
    expect(c?.yearAgo.val).toBe(515_000_000);
  });

  it("NUNCA mezcla un trimestre con un año", () => {
    // Sin la banda de duración, un anual reciente y un trimestral viejo
    // darían una "dilución" del 300% sin que nada fallara.
    const c = pickYoY([
      p("2025-01-01", "2025-12-31", 4_000_000_000, "2026-02-01", "10-K"),
      p("2026-04-01", "2026-06-30", 1_000_000_000, "2026-08-01"),
    ]);
    // Sólo hay un anual y un trimestral: ninguna banda tiene dos puntos.
    expect(c).toBeNull();
  });

  it("cae a anual cuando no hay trimestrales — el caso del emisor extranjero", () => {
    // NU presenta 20-F una vez al año: no tiene trimestres que emparejar y su
    // dato más reciente puede tener año y medio. Es su régimen, no un fallo.
    const c = pickYoY([
      p("2023-01-01", "2023-12-31", 4_860_000_000, "2024-04-01", "20-F"),
      p("2024-01-01", "2024-12-31", 4_892_000_000, "2025-04-01", "20-F"),
    ]);
    expect(c?.cadence).toBe("annual");
    expect(c?.latest.form).toBe("20-F");
  });

  it("sin homólogo dentro de ±45 días del aniversario, no inventa uno", () => {
    // Una empresa recién salida a bolsa con dos trimestres seguidos: sin la
    // ventana emparejaría contra el trimestre anterior y publicaría una
    // dilución TRIMESTRAL etiquetada como interanual.
    const c = pickYoY([
      p("2026-01-01", "2026-03-31", 100, "2026-05-01"),
      p("2026-04-01", "2026-06-30", 130, "2026-08-01"),
    ]);
    expect(c).toBeNull();
  });

  it("prefiere trimestral aunque haya anuales disponibles: es más fresco", () => {
    const c = pickYoY([
      p("2024-01-01", "2024-12-31", 900, "2025-02-01", "10-K"),
      p("2025-01-01", "2025-12-31", 950, "2026-02-01", "10-K"),
      p("2025-04-01", "2025-06-30", 240, "2025-08-01"),
      p("2026-04-01", "2026-06-30", 250, "2026-08-01"),
    ]);
    expect(c?.cadence).toBe("quarterly");
  });
});

describe("deriveDilution: el signo y el hueco", () => {
  const shares = [
    p("2025-04-01", "2025-06-30", 1_000_000_000, "2025-08-01"),
    p("2026-04-01", "2026-06-30", 1_100_000_000, "2026-08-01"),
  ];

  it("dilución positiva = hay más acciones que hace un año", () => {
    const d = deriveDilution({ shares, sbc: [], buybacks: [], taxonomy: "us-gaap" });
    expect(d.dilutionPct).toBeCloseTo(10, 5);
    expect(d.cadence).toBe("quarterly");
  });

  it("un conteo que BAJA da negativo: la empresa está retirando acciones", () => {
    const d = deriveDilution({
      shares: [
        p("2025-04-01", "2025-06-30", 2_590_000_000, "2025-08-01"),
        p("2026-04-01", "2026-06-30", 2_564_000_000, "2026-08-01"),
      ],
      sbc: [],
      buybacks: [],
      taxonomy: "us-gaap",
    });
    expect(d.dilutionPct).toBeLessThan(0);
  });

  it("el SBC de IFRS llega NEGATIVO y se normaliza a magnitud", () => {
    // Medido en NU: `ExpenseFromSharebasedPaymentTransactionsWithEmployees`
    // vale −372.669.000 porque IFRS lo declara como deducción, mientras el
    // `ShareBasedCompensation` de us-gaap llega positivo. Sin normalizar, el
    // panel decía "SBC −372M", que se lee como si la empresa hubiera
    // INGRESADO dinero por pagar a su gente en acciones.
    const d = deriveDilution({
      shares,
      sbc: [p("2024-01-01", "2024-12-31", -372_669_000, "2025-04-01", "20-F")],
      buybacks: [],
      taxonomy: "ifrs-full",
    });
    expect(d.sbc).toBe(372_669_000);
  });

  it("recompras a 0 y recompras AUSENTES no son lo mismo", () => {
    // 0 es una cifra declarada ("no recompramos este trimestre"); null es que
    // la empresa no publica el concepto siquiera. El panel las pinta distinto.
    const conCero = deriveDilution({
      shares,
      sbc: [],
      buybacks: [p("2026-04-01", "2026-06-30", 0, "2026-08-01")],
      taxonomy: "us-gaap",
    });
    const sinDato = deriveDilution({ shares, sbc: [], buybacks: [], taxonomy: "us-gaap" });
    expect(conCero.buybacks).toBe(0);
    expect(sinDato.buybacks).toBeNull();
  });

  it("sin poder emparejar, conserva las piezas sueltas en vez de tirarlo todo", () => {
    const d = deriveDilution({
      shares: [p("2026-04-01", "2026-06-30", 500, "2026-08-01")],
      sbc: [p("2026-04-01", "2026-06-30", 42, "2026-08-01")],
      buybacks: [],
      taxonomy: "us-gaap",
    });
    expect(d.dilutionPct).toBeNull();
    expect(d.dilutedShares).toBe(500);
    expect(d.sbc).toBe(42); // un SBC sin comparativa sigue siendo un dato
  });

  it("denominador cero no es dilución infinita, es dato inservible", () => {
    const d = deriveDilution({
      shares: [
        p("2025-04-01", "2025-06-30", 0, "2025-08-01"),
        p("2026-04-01", "2026-06-30", 100, "2026-08-01"),
      ],
      sbc: [],
      buybacks: [],
      taxonomy: "us-gaap",
    });
    expect(d.dilutionPct).toBeNull();
  });
});
