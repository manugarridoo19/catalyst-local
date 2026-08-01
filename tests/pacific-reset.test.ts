import { describe, it, expect, afterEach, vi } from "vitest";
import { nextPacificMidnightMs } from "@/lib/providers/gemini";

// El reset de las cuotas diarias free de Google es medianoche PACIFIC, y esa
// hora NO es una constante en UTC: son las 07:00Z en verano (PDT, UTC-7) y
// las 08:00Z en invierno (PST, UTC-8). La versión anterior devolvía siempre
// 07:05Z, así que de noviembre a marzo la key revivía 55 minutos antes de que
// la cuota reseteara, cosechaba otro 429 diario y quedaba enfriada hasta el
// día SIGUIENTE — ~23h perdidas de esa key, cada día de invierno.
//
// Estos tests fijan las DOS estaciones. Si alguien vuelve a clavar una
// constante, el de invierno falla.

const MARGIN_MIN = 5;

/** La hora de pared en America/Los_Angeles de un instante, como "HH:MM". */
function pacificClock(ms: number): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "America/Los_Angeles",
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(ms));
}

/** El día Pacific (YYYY-MM-DD) de un instante. */
function pacificDay(ms: number): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(ms));
}

describe("nextPacificMidnightMs", () => {
  afterEach(() => vi.useRealTimers());

  it("en VERANO (PDT, UTC-7) cae a las 07:05Z", () => {
    // 2026-08-01 18:00Z — pleno horario de verano.
    const now = new Date("2026-08-01T18:00:00Z");
    const reset = nextPacificMidnightMs(now);
    expect(new Date(reset).toISOString()).toBe("2026-08-02T07:05:00.000Z");
    expect(pacificClock(reset)).toBe("00:05");
  });

  it("en INVIERNO (PST, UTC-8) cae a las 08:05Z, no a las 07:05Z", () => {
    // 2026-01-15 18:00Z — pleno horario de invierno. Éste es el caso que la
    // constante 07:05 se comía.
    const now = new Date("2026-01-15T18:00:00Z");
    const reset = nextPacificMidnightMs(now);
    expect(new Date(reset).toISOString()).toBe("2026-01-16T08:05:00.000Z");
    expect(pacificClock(reset)).toBe("00:05");
  });

  it("siempre devuelve medianoche Pacific + margen, en cualquier época del año", () => {
    // Un instante por mes: la hora de pared Pacific del reset tiene que ser
    // 00:05 SIEMPRE, dé igual el offset vigente.
    for (let month = 1; month <= 12; month++) {
      const mm = String(month).padStart(2, "0");
      const now = new Date(`2026-${mm}-15T18:00:00Z`);
      const reset = nextPacificMidnightMs(now);
      expect(pacificClock(reset), `mes ${mm}`).toBe("00:05");
      expect(reset, `mes ${mm}`).toBeGreaterThan(now.getTime());
    }
  });

  it("es SIEMPRE futuro y nunca se pasa de 24h + margen", () => {
    // Barrido cada hora de un día completo: la propiedad que importa para el
    // cooldown es que nunca devuelva un instante pasado (la key no revive
    // sola) ni uno a más de un día vista (no se pierde capacidad de más).
    const base = Date.parse("2026-03-08T00:00:00Z"); // fin de semana del cambio a PDT
    for (let h = 0; h < 48; h++) {
      const now = new Date(base + h * 3600_000);
      const reset = nextPacificMidnightMs(now);
      expect(reset, `h=${h}`).toBeGreaterThan(now.getTime());
      expect(reset - now.getTime(), `h=${h}`).toBeLessThanOrEqual(
        (24 * 60 + MARGIN_MIN + 60) * 60_000,
      );
    }
  });

  it("cae en punto aunque `now` traiga milisegundos", () => {
    // `Intl` formatea a segundos, así que restar sin redondear metía los
    // milisegundos de `now` dentro del offset y el reset salía a las
    // 07:05:00.091Z. Cada cooldown diario heredaba esa deriva.
    const now = new Date("2026-08-01T18:00:00.091Z");
    const reset = nextPacificMidnightMs(now);
    expect(new Date(reset).toISOString()).toBe("2026-08-02T07:05:00.000Z");
    expect(reset % 60_000).toBe(0);
  });

  it("justo ANTES del reset apunta a hoy y justo DESPUÉS al día siguiente", () => {
    // 2026-08-02T07:00Z está 5 min antes de la medianoche Pacific del día 1.
    const antes = new Date("2026-08-02T07:00:00Z");
    expect(new Date(nextPacificMidnightMs(antes)).toISOString()).toBe(
      "2026-08-02T07:05:00.000Z",
    );
    // 10 minutos después ya pasó: el siguiente reset es el del día siguiente.
    const despues = new Date("2026-08-02T07:10:00Z");
    const siguiente = nextPacificMidnightMs(despues);
    expect(new Date(siguiente).toISOString()).toBe("2026-08-03T07:05:00.000Z");
    // Y sigue siendo medianoche Pacific del día Pacific siguiente.
    expect(pacificDay(siguiente)).toBe("2026-08-03");
  });
});
