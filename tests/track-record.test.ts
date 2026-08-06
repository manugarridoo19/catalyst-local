import { describe, expect, it } from "vitest";
import {
  buildTrackRecord,
  type TrackRecordOutcomeRow,
} from "@/lib/coach/track-record";

// Lo que se prueba aquí es que el track record RESPETA el criterio de
// measure.ts al agregar: el veredicto mostrado es el del horizonte más
// maduro, el signo de la venta va invertido y lo que no se juzga lo dice
// con su motivo. Si esta agregación se desviara de judgeTrade, el panel
// diría una cosa fila a fila y otra en el total.

function row(o: {
  trade_id: number;
  symbol?: string;
  side?: string;
  horizon?: string | null;
  created_at?: string;
  at_horizon: number;
  return_pct: number;
  benchmark_return_pct?: number | null;
}): TrackRecordOutcomeRow {
  return {
    trade_id: o.trade_id,
    symbol: o.symbol ?? "TEST",
    side: o.side ?? "buy",
    horizon: o.horizon === undefined ? "corto" : o.horizon,
    annotated_later: false,
    created_at: o.created_at ?? "2026-08-01",
    at_horizon: o.at_horizon,
    return_pct: o.return_pct,
    benchmark_return_pct:
      o.benchmark_return_pct === undefined ? 0 : o.benchmark_return_pct,
  };
}

describe("el veredicto mostrado es el del horizonte más maduro", () => {
  it("con 1d y 7d medidos en un corto, muestra el de 7d", () => {
    const rec = buildTrackRecord(
      [
        row({ trade_id: 1, at_horizon: 1, return_pct: 1.0 }),
        row({ trade_id: 1, at_horizon: 7, return_pct: 5.0 }),
      ],
      0,
      1,
    );
    expect(rec.trades[0].verdict).toMatchObject({
      atHorizon: 7,
      edgePct: 5.0,
      label: "acierto",
    });
    // Pero AMBOS horizontes cuentan en las estadísticas: el agregado es por
    // horizonte, no por operación.
    expect(rec.stats.map((s) => s.horizon)).toEqual([1, 7]);
  });
});

describe("la venta invierte el signo del edge", () => {
  it("vender antes de una subida es un error, no un acierto", () => {
    const rec = buildTrackRecord(
      [
        row({
          trade_id: 1,
          side: "sell",
          horizon: "medio",
          at_horizon: 30,
          return_pct: 6.0,
          benchmark_return_pct: 1.0,
        }),
      ],
      0,
      1,
    );
    expect(rec.trades[0].verdict).toMatchObject({
      edgePct: -5.0,
      label: "error",
    });
  });

  it("vender antes de una caída que fue del mercado entero vale 0 (neutro)", () => {
    const rec = buildTrackRecord(
      [
        row({
          trade_id: 1,
          side: "sell",
          horizon: "medio",
          at_horizon: 30,
          return_pct: -6.0,
          benchmark_return_pct: -6.0,
        }),
      ],
      0,
      1,
    );
    expect(rec.trades[0].verdict).toMatchObject({
      edgePct: 0,
      label: "neutro",
    });
  });
});

describe("lo que no se juzga lo dice, con su motivo", () => {
  it("plazo largo medido: contexto sí, veredicto nunca", () => {
    const rec = buildTrackRecord(
      [row({ trade_id: 1, horizon: "largo", at_horizon: 30, return_pct: -8 })],
      0,
      1,
    );
    const t = rec.trades[0];
    expect(t.verdict).toBeNull();
    expect(t.returns[30]).toBe(-8);
    expect(t.pendingVerdict?.kind).toBe("nunca");
    expect(t.pendingVerdict?.reason).toMatch(/tesis/);
  });

  it("plazo medio con solo 1d medido: madurando, no mudo", () => {
    const rec = buildTrackRecord(
      [row({ trade_id: 1, horizon: "medio", at_horizon: 1, return_pct: 2 })],
      0,
      1,
    );
    expect(rec.trades[0].verdict).toBeNull();
    expect(rec.trades[0].pendingVerdict).toMatchObject({ kind: "madurando" });
    expect(rec.trades[0].pendingVerdict?.reason).toMatch(/30\/90/);
    // Y NO contamina las estadísticas: un 1d de una operación a medio no es
    // un veredicto en ningún agregado.
    expect(rec.stats).toEqual([]);
  });

  it("sin plazo declarado: nunca, con la invitación a clasificarla", () => {
    const rec = buildTrackRecord(
      [row({ trade_id: 1, horizon: null, at_horizon: 7, return_pct: 3 })],
      0,
      1,
    );
    expect(rec.trades[0].pendingVerdict?.kind).toBe("nunca");
    expect(rec.trades[0].pendingVerdict?.reason).toMatch(/plazo/);
  });
});

describe("agregados", () => {
  it("cuenta aciertos/errores/neutros por horizonte con la banda de ruido", () => {
    const rec = buildTrackRecord(
      [
        row({ trade_id: 1, at_horizon: 7, return_pct: 4, created_at: "2026-08-01" }),
        row({ trade_id: 2, at_horizon: 7, return_pct: -3, created_at: "2026-08-02" }),
        row({ trade_id: 3, at_horizon: 7, return_pct: 0.5, created_at: "2026-08-03" }),
      ],
      2,
      5,
    );
    const s7 = rec.stats.find((s) => s.horizon === 7)!;
    expect(s7).toMatchObject({ n: 3, aciertos: 1, errores: 1, neutros: 1 });
    expect(s7.avgEdge).toBeCloseTo(0.5, 5);
    expect(rec.totals).toEqual({
      decisions: 5,
      measured: 3,
      withVerdict: 3,
      awaitingPrice: 2,
    });
  });

  it("ordena el diario del más reciente al más viejo", () => {
    const rec = buildTrackRecord(
      [
        row({ trade_id: 1, at_horizon: 1, return_pct: 1, created_at: "2026-08-01" }),
        row({ trade_id: 2, at_horizon: 1, return_pct: 1, created_at: "2026-08-05" }),
      ],
      0,
      2,
    );
    expect(rec.trades.map((t) => t.tradeId)).toEqual([2, 1]);
  });
});
