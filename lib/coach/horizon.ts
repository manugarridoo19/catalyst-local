// El plazo declarado de una operación, y qué se puede afirmar sobre ella.
//
// TS puro (sin BD, sin red): lo comparten el formulario del cliente, el job
// de medición y el prompt del coach. Una sola definición, por el mismo
// motivo que `lib/portfolio.ts` — si el formulario ofreciera unos plazos y
// el evaluador usara otros, habría operaciones imposibles de juzgar y nadie
// lo notaría hasta ver un veredicto absurdo.
//
// LA IDEA CENTRAL: el plazo no describe la operación, decide QUÉ PREGUNTA
// se le puede hacer. Una compra a largo plazo no es una compra a corto que
// tarda más — es una apuesta a otra cosa, y el precio a 30 días no la
// confirma ni la refuta. Preguntárselo igualmente es el error que hace
// inútil a la mayoría de los "coaches" automáticos.

export const HORIZONS = ["corto", "medio", "largo"] as const;
export type TradeHorizon = (typeof HORIZONS)[number];

export function isTradeHorizon(v: unknown): v is TradeHorizon {
  return typeof v === "string" && (HORIZONS as readonly string[]).includes(v);
}

/** Horizontes en días HÁBILES que el job rellena para TODA operación. Se
 *  miden todos siempre porque una sola llamada de precios por símbolo los
 *  sirve a todos: el coste marginal de guardar 90 y 180 es una fila. Lo que
 *  cambia según el plazo declarado no es qué se mide, es qué se AFIRMA. */
export const MEASURED_HORIZONS = [1, 7, 30, 90, 180] as const;

/** Días naturales a partir de los cuales un horizonte en días hábiles puede
 *  haber madurado. Prefiltro barato en SQL; la maduración real la decide la
 *  serie de sesiones (así los festivos salen bien sin calendario propio). */
export const RIPE_CALENDAR_DAYS: Record<number, number> = {
  1: 4,
  7: 13,
  30: 48,
  90: 140,
  180: 270,
};

/**
 * Horizontes sobre los que ESTE plazo admite un veredicto de acierto/error.
 *
 * `largo` devuelve lista vacía, y no es una omisión: una tesis de años no se
 * refuta con un precio a nueve meses. Las operaciones a largo se siguen
 * midiendo (el dato de mercado se guarda igual, neutro y sin signo) y se
 * siguen mostrando — pero como CONTEXTO, nunca etiquetadas como error. Lo
 * que a ellas las pone a prueba es que se rompan los hechos de la tesis, y
 * eso no es una pregunta de precio.
 */
export function verdictHorizonsFor(h: TradeHorizon | null): readonly number[] {
  switch (h) {
    case "corto":
      return [1, 7, 30];
    case "medio":
      return [30, 90];
    case "largo":
      return [];
    default:
      // Sin plazo declarado no hay veredicto posible. No es un fallo: es que
      // juzgar sin saber a qué aspirabas es exactamente lo que rompe la
      // confianza en el panel. Estas operaciones salen en el diario y se
      // pueden clasificar después (marcadas como anotadas a posteriori).
      return [];
  }
}

export const HORIZON_LABEL: Record<TradeHorizon, string> = {
  corto: "corto · días o semanas",
  medio: "medio · meses",
  largo: "largo · años",
};

/** Lo que se le dice al usuario que implica elegir cada plazo. Va en la UI
 *  junto al selector: si no sabe que `largo` desactiva el veredicto de
 *  precio, elegirá mal y el dato nacerá torcido. */
export const HORIZON_HINT: Record<TradeHorizon, string> = {
  corto: "se juzga por el precio a 1, 7 y 30 sesiones",
  medio: "se juzga por el precio a 30 y 90 sesiones",
  largo: "no se juzga por precio — se vigila que la tesis siga en pie",
};
