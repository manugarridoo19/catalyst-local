// ¿Qué clase de pregunta es ésta? TS PURO, sin BD — testeable a mano.
//
// EL AGUJERO QUE TAPA (medido 2026-07-30 con "¿es buena idea dejar correr
// $MSFT o mejor vendemos una parte hoy?"): /ask trataba TODA pregunta como
// una consulta al archivo. El prompt de `lib/ai/ask.ts` define al modelo
// como bibliotecario con prohibición expresa de opinar, así que una
// pregunta de DECISIÓN sobre una posición propia chocaba contra la regla y
// lo único que quedaba era una descripción genérica del valor. No fallaba
// el modelo: fallaba que nadie le hubiera dicho que le estaban preguntando
// otra cosa.
//
// La clasificación es DELIBERADAMENTE conservadora en un sentido: una
// pregunta de archivo mal clasificada como decisión sale peor que al revés,
// porque despliega bloques ("a favor de recortar") que no vienen a cuento.
// De ahí la conjunción de abajo.

export type AskIntent = "decision" | "archive";

/**
 * Verbos de ACCIÓN sobre una posición. Ojo: sólo formas verbales, nunca el
 * sustantivo. "la compra de Iridium" o "las ventas de julio" son
 * vocabulario normal de una noticia y meterían en modo decisión media
 * portada financiera.
 */
const ACTION = [
  // Español
  /\bvend(o|es|e|emos|en|er|erla|erlo|eria|eriamos|iera)\b/,
  /\bcompr(o|as|amos|ar|arla|arlo|aria|ariamos)\b/,
  /\bmanten(go|emos|er|erla|erlo|dria)\b/,
  /\baguant(o|amos|ar|arla|arlo|aria)\b/,
  /\brecort(o|amos|ar|arla|arlo|aria)\b/,
  /\bpromedi(o|amos|ar)\b/,
  /\bampli(o|amos|ar|aria)\b/,
  /\bentr(o|amos|ar)\b/,
  /\bsal(go|imos|ir|irme)\b/,
  /\bcierr(o|a)\b|\bcerrar\b/,
  /\bdeshac(er|erme)\b|\bdeshag(o|amos)\b/,
  /\bdej(o|ar|amos)(la|lo|las|los)?\s+correr\b/,
  /\b(tomar|recoger|realizar)\s+(beneficios|ganancias|plusvalias)\b/,
  /\bstop\s?loss\b/,
  // Inglés
  /\bsell(ing|s)?\b/,
  /\bbuy(ing|s)?\b/,
  /\bhold(ing)?\b/,
  /\btrim(ming|s)?\b/,
  /\bexit(ing)?\b/,
  /\blet\s+it\s+run\b/,
  /\btake\s+profits?\b/,
  /\b(double|average)\s+down\b/,
  /\bcut\s+(my|the)\s+(loss|losses|position)\b/,
];

/**
 * Marcas de PRIMERA PERSONA: "esto es dinero mío". Es la mitad que impide
 * el falso positivo que más importa — "What are insiders buying lately?" es
 * una de las tres preguntas de ejemplo de la propia UI y lleva un verbo de
 * acción dentro. Sin este segundo requisito entraría en modo decisión.
 */
const SELF = [
  /\b(mi|mis|mio|mia|mios|mias|nuestro|nuestra|nuestros|nuestras|me)\b/,
  /\b(vendo|vendemos|compro|compramos|tengo|tenemos|llevo|llevamos|entro|entramos|salgo|salimos|mantengo|mantenemos|aguanto|aguantamos|recorto|recortamos|cierro|cerramos|amplio|ampliamos|promedio)\b/,
  /\b(my|our|mine)\b/,
  /\b(i|we)\s+(should|shall|hold|sell|buy|own|have|keep|bought|sold)\b/,
];

/** Marcas de que se pide un JUICIO, no un dato. Vale por sí sola junto a un
 *  verbo de acción aunque la pregunta esté escrita en impersonal
 *  ("¿conviene vender ahora?"). */
const ADVISORY = [
  /\b(buena|mala)\s+idea\b/,
  /\b(merece|vale)\s+la\s+pena\b/,
  /\bconvien(e|dria)\b/,
  /\bque\s+(hago|hacemos|harias|haces)\b/,
  /\bmejor\s+(vender|comprar|salir|esperar|recortar|aguantar)\b/,
  /\brecomiend(as|arias)\b/,
  /\bshould\s+(i|we)\b/,
  /\bworth\s+(it|holding|selling|buying|keeping)\b/,
  /\bbetter\s+to\s+(sell|hold|buy|trim|wait)\b/,
];

/**
 * Ruido de la propia pregunta de decisión, para el canal LÉXICO.
 *
 * `keywords()` en retrieve.ts se queda con 6 palabras de contenido y las
 * busca con ILIKE sobre titulares. En "¿es buena idea dejar correr $MSFT o
 * mejor vendemos una parte hoy?" esas 6 plazas se las comen "buena", "idea",
 * "dejar", "correr", "vendemos" y "parte" — ninguna describe una noticia, y
 * "parte"/"correr" además casan con medio archivo por subcadena. El canal
 * léxico dejaba de aportar justo en la pregunta que más lo necesitaba.
 */
export const DECISION_NOISE = new Set([
  "buena", "mala", "idea", "dejar", "dejo", "correr", "mejor", "parte",
  "vender", "vendo", "vendemos", "venderla", "venderlo", "comprar", "compro",
  "compramos", "mantener", "mantengo", "aguantar", "aguanto", "recortar",
  "recorto", "promediar", "ampliar", "salir", "salgo", "entrar", "entro",
  "cerrar", "cierro", "deshacerme", "conviene", "convendria", "merece",
  "pena", "vale", "hago", "hacemos", "harias", "recomiendas", "ahora",
  "sell", "selling", "buy", "buying", "hold", "holding", "trim", "exit",
  "should", "worth", "keep", "keeping", "better", "profits", "position",
  "posicion", "posiciones", "cartera",
]);

/** Minúsculas y sin tildes: los patrones de arriba se escriben una sola vez
 *  y casan igual con "amplío", "qué hago" o "posición". */
export function normalizeQuestion(question: string): string {
  return question
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/\s+/g, " ");
}

/**
 * Decisión = hay un VERBO DE ACCIÓN sobre una posición **y** además o bien
 * la pregunta habla en primera persona o bien pide explícitamente un juicio.
 *
 * La conjunción no es cautela gratuita, es lo que separa estos dos casos
 * reales que comparten el mismo verbo:
 *
 *   "What are insiders buying lately?"        → archivo (no es tu dinero)
 *   "¿es buena idea dejar correr $MSFT…?"     → decisión
 */
export function classifyIntent(question: string): AskIntent {
  const q = normalizeQuestion(question);
  const hasAction = ACTION.some((re) => re.test(q));
  if (!hasAction) return "archive";
  const hasSelf = SELF.some((re) => re.test(q));
  const hasAdvisory = ADVISORY.some((re) => re.test(q));
  return hasSelf || hasAdvisory ? "decision" : "archive";
}
