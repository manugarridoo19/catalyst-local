import { verdictHorizonsFor, type TradeHorizon } from "@/lib/coach/horizon";

// Cómo se lee el resultado de UNA operación tuya.
//
// TS puro (sin BD, sin red): lo consumen el panel del cliente y el prompt
// del coach. Si cada superficie aplicara su criterio, la pantalla y el
// modelo dirían cosas distintas del mismo hecho.
//
// LO QUE LA BD GUARDA ES NEUTRO. `trade_outcomes.return_pct` es el retorno
// del MERCADO entre dos cierres ajustados, sin signo de decisión aplicado.
// Que una subida del 4% sea buena o mala para ti no es un dato del mercado:
// depende de qué hiciste y de a qué aspirabas. Esa lectura se hace AQUÍ, en
// código revisable, y no al escribir en disco — una convención de signo
// archivada es imposible de corregir después sin remedir todo el historial.

export type JudgedTrade = {
  side: "buy" | "sell" | "adjust";
  /** Plazo DECLARADO por el usuario al operar. `null` = sin clasificar. */
  horizon: TradeHorizon | null;
  /** Horizonte de esta medición, en días hábiles (1|7|30|90|180). */
  atHorizon: number;
  /** Retorno del MERCADO entre la sesión base y la del horizonte, en %.
   *  Positivo = la acción subió. Sin signo de decisión aplicado. */
  returnPct: number;
  /** Retorno de SPY entre las dos MISMAS fechas. `null` si no había
   *  benchmark disponible en esa pasada. */
  benchmarkReturnPct: number | null;
};

export type TradeVerdict = {
  /** Cuánto mejor (o peor) te fue por haber actuado, en puntos
   *  porcentuales. Positivo = la decisión sumó. `null` = no se juzga. */
  edgePct: number | null;
  /** Contra qué se comparó. Quien lo pinte tiene que decirlo: no es lo
   *  mismo acertar que acertar en un mercado que subía entero. */
  basis: "benchmark" | "mercado" | null;
  /** Por qué no hay veredicto, cuando no lo hay. Se devuelve para que la UI
   *  lo DIGA — un guion mudo se lee como "no hay datos todavía", que es una
   *  cosa muy distinta de "esta operación no se juzga así". */
  noVerdict:
    | null
    | "ajuste_no_es_decision"
    | "sin_plazo_declarado"
    | "plazo_largo_no_se_juzga_por_precio"
    | "horizonte_fuera_del_plazo";
  /** El movimiento del mercado, siempre presente. Aunque no haya veredicto,
   *  saber qué hizo la acción después es CONTEXTO legítimo — lo que no es
   *  legítimo es llamarlo acierto o error. */
  marketPct: number;
};

/** Umbral por debajo del cual una operación no es ni acierto ni error. No
 *  es estadística: un ±1% a 7 días es ruido, y etiquetar el ruido es cómo
 *  se fabrican patrones que no existen. */
export const NOISE_BAND_PCT = 1.0;

/**
 * ¿Salió bien esta operación?
 *
 * ─── LA CONVENCIÓN DE SIGNO, Y POR QUÉ ES JUSTA AHORA ───────────────────
 *
 * COMPRA: acertaste si subió. `edge = +exceso sobre SPY`.
 *
 * VENTA: el contrafactual de vender es NO haber vendido. Si la acción sube
 * después, esas acciones habrían valido más y la venta te costó dinero real
 * y medible. `edge = −exceso sobre SPY`.
 *
 * Esa lectura de la venta sería injusta —y lo era en el diseño anterior—
 * aplicada a ciegas: recortar concentración o sacar liquidez son ventas
 * cuyo éxito no vive en el precio posterior. Lo que la vuelve justa es que
 * ahora **sólo se aplica a lo que declaraste corto o medio**. Si vendiste
 * pensando en años, o no declaraste plazo, no hay veredicto: `edgePct` sale
 * `null` con su motivo. El código lo impide; no es una instrucción del
 * prompt que el modelo pueda ignorar.
 *
 * SIEMPRE contra SPY cuando existe: vender antes de una caída del 6% no es
 * puntería si el mercado entero cayó un 6% esa semana. Con el benchmark
 * delante, ese "acierto" vale 0, que es lo que vale.
 */
export function judgeTrade(t: JudgedTrade): TradeVerdict {
  const useBench = t.benchmarkReturnPct !== null;
  const market = useBench ? t.returnPct - t.benchmarkReturnPct! : t.returnPct;
  const basis = useBench ? ("benchmark" as const) : ("mercado" as const);
  const none = (reason: NonNullable<TradeVerdict["noVerdict"]>): TradeVerdict => ({
    edgePct: null,
    basis: null,
    noVerdict: reason,
    marketPct: market,
  });

  // Una corrección a mano no es una decisión de mercado. Medirla fabricaría
  // aciertos y errores que nadie tomó.
  if (t.side === "adjust") return none("ajuste_no_es_decision");
  if (t.horizon === null) return none("sin_plazo_declarado");
  if (t.horizon === "largo") return none("plazo_largo_no_se_juzga_por_precio");
  // Juzgar una operación a medio plazo por lo que hizo el precio al día
  // siguiente es el mismo error en pequeño. Cada plazo sólo responde en sus
  // horizontes; los demás se guardan y se enseñan como contexto.
  if (!verdictHorizonsFor(t.horizon).includes(t.atHorizon)) {
    return none("horizonte_fuera_del_plazo");
  }

  return {
    edgePct: t.side === "buy" ? market : -market,
    basis,
    noVerdict: null,
    marketPct: market,
  };
}

/** Etiqueta legible. Separada de `judgeTrade` porque la banda de ruido es
 *  una decisión de PRESENTACIÓN: cambiarla no debe alterar el número que se
 *  acumula en las estadísticas. */
export function verdictLabel(
  v: TradeVerdict,
): "acierto" | "error" | "neutro" | null {
  if (v.edgePct === null) return null;
  if (v.edgePct > NOISE_BAND_PCT) return "acierto";
  if (v.edgePct < -NOISE_BAND_PCT) return "error";
  return "neutro";
}
