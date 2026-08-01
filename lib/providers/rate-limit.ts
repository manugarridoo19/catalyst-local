// Freno de tasa por proceso: cubo de fichas.
//
// POR QUÉ UN CUBO Y NO UN HUECO FIJO ENTRE LLAMADAS. Los límites de estas
// APIs son un PRESUPUESTO POR MINUTO, no un espaciado obligatorio: diez
// peticiones seguidas son perfectamente legales mientras quede presupuesto.
// La primera versión de esto repartía un hueco uniforme (60s/55 ≈ 1,1s) y
// habría convertido la watchlist de `/api/quotes` —que pide ~10 símbolos de
// golpe— de ~1s a ~11s. El freno tiene que morder cuando se agota el minuto,
// no en cada llamada.
//
// LA RESERVA ES SÍNCRONA, y eso no es un detalle de estilo. Entre leer y
// escribir `tokens` no hay ningún `await`: quien llama se lleva su ficha
// antes de ceder el control. Calcular la espera DESPUÉS de un await dejaría
// que dos llamadas concurrentes se llevaran la misma ficha y el freno no
// frenaría nada. Es la misma lección que ya estaba medida en el proyecto para
// las cuotas globales: reservar el turno primero, dormir después.
//
// `tokens` puede quedar NEGATIVO a propósito: es lo que pone en cola a los
// que esperan (cada uno calcula su espera sobre el déficit acumulado) en vez
// de despertarlos a todos en el mismo instante.

export type RateLimiterOptions = {
  /** Presupuesto sostenido, y también el tamaño máximo de la ráfaga. */
  maxPerMinute: number;
  /** Ventana del presupuesto. Sólo se toca en tests. */
  windowMs?: number;
  /** Reloj inyectable (tests con reloj virtual). */
  now?: () => number;
  /** Espera inyectable (tests con reloj virtual). */
  sleep?: (ms: number) => Promise<void>;
};

export type RateLimiter = {
  /** Reserva una ficha; espera sólo si el presupuesto está agotado. */
  reserve(): Promise<void>;
  /** Fichas disponibles ahora (puede ser negativa). Diagnóstico y tests. */
  available(): number;
};

const DEFAULT_WINDOW_MS = 60_000;

export function createRateLimiter(opts: RateLimiterOptions): RateLimiter {
  const max = Math.max(1, opts.maxPerMinute);
  const windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
  const now = opts.now ?? (() => Date.now());
  const sleep =
    opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  let tokens = max;
  let lastRefill = now();

  function refill(): void {
    const t = now();
    const gained = ((t - lastRefill) / windowMs) * max;
    if (gained > 0) {
      // El tope es `max`: parar una hora no da una hora de fichas acumuladas.
      tokens = Math.min(max, tokens + gained);
      lastRefill = t;
    }
  }

  return {
    async reserve(): Promise<void> {
      refill();
      const deficit = 1 - tokens;
      tokens -= 1;
      if (deficit > 0) {
        await sleep(Math.ceil((deficit / max) * windowMs));
      }
    },
    available(): number {
      refill();
      return tokens;
    },
  };
}
