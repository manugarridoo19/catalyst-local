import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_DB_MB,
  DEFAULT_MIN_IMPACT,
  DEFAULT_RETENTION_DAYS,
  KB_PER_ROW,
  fitsUnderPause,
  steadyStateMb,
} from "@/lib/embeddings/budget";

// Lo que se prueba aquí no es una fórmula: es que la configuración que
// enviamos CABE en el disco que tenemos. La anterior no cabía, nadie lo
// comprobó, y la forma de enterarse habría sido que /ask dejara de encontrar
// lo nuevo en silencio a mediados de agosto.
//
// Todas las cifras vienen de la base real medida el 2026-08-12:
//   base entera            352 MB de 512 (Neon free)
//   news_embeddings        159 MB en 28.862 filas → 5,5 kB/fila
//   resto de tablas        193 MB (news 109, news_tickers 32, scores 14, …)
//   flujo impacto>=3       989-1.698 filas/día entre semana
//   flujo impacto>=4         298-571 filas/día entre semana

/** Todo lo que no son embeddings, medido. Es el suelo sobre el que se apila
 *  el archivo, y lo único de este cálculo que no controlamos. */
const OTHER_TABLES_MB = 193;

/** Día fuerte, no la media: si sólo cabe en un día flojo, no cabe. */
const PEAK_IMPACT3_ROWS = 1698;
const PEAK_IMPACT4_ROWS = 571;
const AVG_IMPACT3_ROWS = 1060;

describe("la configuración anterior no cabía, y ése es el bug", () => {
  it("impacto>=3 con 60 días desborda hasta el plan entero de Neon", () => {
    const mb = steadyStateMb({
      retentionDays: 60,
      rowsPerDay: PEAK_IMPACT3_ROWS,
      otherTablesMb: OTHER_TABLES_MB,
    });
    // ~740 MB sobre una base de 512: no es que rozara el umbral de pausa, es
    // que la ventana prometida no cabía en la base entera.
    expect(mb).toBeGreaterThan(512);
    expect(fitsUnderPause({
      retentionDays: 60,
      rowsPerDay: PEAK_IMPACT3_ROWS,
      otherTablesMb: OTHER_TABLES_MB,
    })).toBe(false);
  });

  it("tampoco cabía con el flujo MEDIO — no era un pico raro", () => {
    // El contraejemplo importa: si sólo fallara en el día peor se podría
    // discutir que era mala suerte. Con la media de la semana tampoco entra.
    expect(
      steadyStateMb({
        retentionDays: 60,
        rowsPerDay: AVG_IMPACT3_ROWS,
        otherTablesMb: OTHER_TABLES_MB,
      }),
    ).toBeGreaterThan(DEFAULT_MAX_DB_MB);
  });
});

describe("la configuración que enviamos cabe", () => {
  it("impacto>=4 con 45 días entra por debajo del umbral de pausa, en día fuerte", () => {
    const mb = steadyStateMb({
      retentionDays: DEFAULT_RETENTION_DAYS,
      rowsPerDay: PEAK_IMPACT4_ROWS,
      otherTablesMb: OTHER_TABLES_MB,
    });
    expect(mb).toBeLessThan(DEFAULT_MAX_DB_MB);
    // Y no por los pelos: el margen tiene que absorber que `news` crezca.
    expect(DEFAULT_MAX_DB_MB - mb).toBeGreaterThan(30);
  });

  it("los valores por defecto que se envían son los que se comprobaron", () => {
    // Si alguien sube la retención o baja el umbral sin rehacer la cuenta,
    // este archivo es el que tiene que romperse — no el archivo consultable
    // tres semanas después.
    expect(DEFAULT_MIN_IMPACT).toBe(4);
    expect(DEFAULT_RETENTION_DAYS).toBe(45);
    expect(KB_PER_ROW).toBeCloseTo(5.5, 1);
  });
});

describe("la cuenta", () => {
  it("escala con los tres factores y redondea a MB", () => {
    // 100 filas/día × 10 días × 5,5 kB = 5.500 kB ≈ 5,4 MB, + 100 de base.
    expect(
      steadyStateMb({ retentionDays: 10, rowsPerDay: 100, otherTablesMb: 100 }),
    ).toBe(105);
  });

  it("acepta un coste por fila distinto: 768 dims hoy no es 768 dims siempre", () => {
    expect(
      steadyStateMb({
        retentionDays: 10,
        rowsPerDay: 100,
        otherTablesMb: 0,
        kbPerRow: 11,
      }),
    ).toBe(11);
  });
});
