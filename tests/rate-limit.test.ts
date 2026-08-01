import { describe, expect, it } from "vitest";
import { createRateLimiter } from "@/lib/providers/rate-limit";

// Freno de tasa compartido de Finnhub. Lo que se prueba aquí no es una
// utilidad genérica: es lo que evita repetir el 2026-08-01, cuando el
// refresher acumuló 7.048 respuestas 429 porque cuatro caminos tenían cada
// uno su concurrencia local contra un presupuesto que nadie hacía cumplir.
//
// Reloj VIRTUAL: `sleep` no duerme, así que el test mide el comportamiento
// real del algoritmo en microsegundos. Sin esto, el caso de la ráfaga de 141
// tardaría minuto y medio.
//
// `advanceOnSleep` NO es un adorno. Adelantar el reloj al invocar `sleep`
// modela bien una cadena SECUENCIAL (cada espera termina antes de la
// siguiente llamada), pero miente sobre una ráfaga CONCURRENTE: allí las tres
// llamadas ocurren en el mismo instante y el reloj no se ha movido para
// ninguna. Con el modelo secuencial, la 2ª de tres llamadas simultáneas veía
// tiempo transcurrido que en la realidad no existe y parecía no encolarse.
function harness(maxPerMinute: number, advanceOnSleep = true) {
  let clock = 0;
  const waits: number[] = [];
  const limiter = createRateLimiter({
    maxPerMinute,
    now: () => clock,
    sleep: async (ms: number) => {
      waits.push(ms);
      if (advanceOnSleep) clock += ms;
    },
  });
  return {
    limiter,
    waits,
    get clock() {
      return clock;
    },
    advance(ms: number) {
      clock += ms;
    },
  };
}

describe("createRateLimiter", () => {
  it("deja pasar una ráfaga hasta el cupo sin esperar ni una vez", async () => {
    // El caso de /api/quotes: ~10 símbolos de golpe tienen que salir ya.
    const h = harness(55);
    for (let i = 0; i < 10; i++) await h.limiter.reserve();
    expect(h.waits).toEqual([]);
    expect(h.clock).toBe(0);
  });

  it("agota el cupo entero antes de frenar", async () => {
    const h = harness(55);
    for (let i = 0; i < 55; i++) await h.limiter.reserve();
    expect(h.waits).toEqual([]);
    // La 56ª ya no tiene presupuesto: espera lo que tarda en generarse UNA
    // ficha, no una ventana entera.
    await h.limiter.reserve();
    expect(h.waits).toHaveLength(1);
    expect(h.waits[0]).toBe(Math.ceil(60_000 / 55));
  });

  it("reparte los sobrantes de una ráfaga grande a la tasa objetivo", async () => {
    // 141 = los símbolos que el Signal Lab pedía por tick antes del arreglo.
    // Las 55 primeras son ráfaga; las 86 restantes tienen que salir a 55/min.
    const h = harness(55);
    for (let i = 0; i < 141; i++) await h.limiter.reserve();
    const sobrantes = 141 - 55;
    const esperado = (sobrantes / 55) * 60_000;
    // Tolerancia de una ficha por el redondeo al alza de cada espera.
    expect(h.clock).toBeGreaterThanOrEqual(esperado - 1);
    expect(h.clock).toBeLessThanOrEqual(esperado + 60_000 / 55 + 1);
  });

  it("rellena con el tiempo: tras una ventana vuelve a haber ráfaga entera", async () => {
    const h = harness(55);
    for (let i = 0; i < 55; i++) await h.limiter.reserve();
    h.advance(60_000);
    h.waits.length = 0;
    for (let i = 0; i < 55; i++) await h.limiter.reserve();
    expect(h.waits).toEqual([]);
  });

  it("no acumula presupuesto por encima del cupo", async () => {
    // Diez minutos parado no dan diez minutos de fichas: si las acumulara,
    // el primer tick tras una noche dormido saldría con una ráfaga de 550 y
    // se comería el 429 igual.
    const h = harness(55);
    h.advance(10 * 60_000);
    expect(h.limiter.available()).toBe(55);
    for (let i = 0; i < 55; i++) await h.limiter.reserve();
    await h.limiter.reserve();
    expect(h.waits).toHaveLength(1);
  });

  it("reserva la ficha de forma SÍNCRONA: dos llamadas a la vez no comparten turno", async () => {
    // La propiedad que hace que el freno frene. Si el descuento ocurriera
    // después de un await, dos llamadas concurrentes leerían el mismo valor
    // de `tokens` y ambas creerían tener presupuesto.
    const h = harness(55);
    const pendientes = [
      h.limiter.reserve(),
      h.limiter.reserve(),
      h.limiter.reserve(),
    ];
    // Sin await todavía: el descuento ya tiene que haber ocurrido.
    expect(h.limiter.available()).toBe(52);
    await Promise.all(pendientes);
    expect(h.waits).toEqual([]);
  });

  it("pone en cola a los que esperan en vez de despertarlos a la vez", async () => {
    // Con el cupo agotado, tres llamadas concurrentes deben recibir esperas
    // CRECIENTES. Si todas calcularan el mismo déficit, saldrían juntas y la
    // ráfaga se repetiría intacta un instante después. Reloj congelado
    // durante la ráfaga: es lo que pasa de verdad cuando las tres salen del
    // mismo `Promise.all`.
    const h = harness(10, false);
    for (let i = 0; i < 10; i++) await h.limiter.reserve();
    h.waits.length = 0;
    await Promise.all([
      h.limiter.reserve(),
      h.limiter.reserve(),
      h.limiter.reserve(),
    ]);
    expect(h.waits).toHaveLength(3);
    expect(h.waits[0]).toBeLessThan(h.waits[1]);
    expect(h.waits[1]).toBeLessThan(h.waits[2]);
  });

  it("trata un cupo absurdo como al menos 1 por minuto", async () => {
    const h = harness(0);
    await h.limiter.reserve();
    await h.limiter.reserve();
    expect(h.waits).toHaveLength(1);
    expect(h.waits[0]).toBe(60_000);
  });
});
