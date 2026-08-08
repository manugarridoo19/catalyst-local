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

export type AskIntent = "decision" | "preview" | "archive";

/**
 * PREVIA de un resultado que aún no ha salido.
 *
 * El tercer agujero, medido el 2026-08-07 con "¿cómo se espera que sea la
 * earnings report de $NU?". Sólo había dos clases de pregunta, así que ésta
 * caía en `archive` — y `archive` es el BIBLIOTECARIO: el prompt le prohíbe
 * opinar y su única sección de futuro le prohíbe además pronosticar. Encima
 * apagaba el canal prospectivo entero (vara de consenso, vendedores
 * sistemáticos, operaciones abiertas, riesgo). Lo máximo que podía contestar
 * era la fecha y el consenso, que es exactamente lo que contestó.
 *
 * Una previa NO es una predicción y el prompt de abajo lo sostiene: es la
 * VARA, el historial de la empresa contra esa vara, lo que ha cambiado desde
 * el trimestre pasado y quién está posicionado. Todo eso son hechos.
 *
 * Se clasifica SOLA, sin exigir símbolo: "¿qué se espera de los resultados de
 * la banca?" también merece esta forma. Pero cede ante `decision` — "¿compro
 * antes de resultados?" pregunta por el dinero, no por el trimestre.
 */
const PREVIEW = [
  // Español
  /\b(como|que|cual)\s+.{0,20}\bse\s+espera\b/,
  /\bque\s+(se\s+)?esperan?\s+(de|para|del)\b/,
  /\bque\s+esperas\b/,
  /\bprevia\b/,
  /\bexpectativas?\b/,
  /\bva\s+a\s+(batir|superar|fallar|decepcionar)\b/,
  /\b(batira|superara|fallara|decepcionara)\b/,
  /\bcomo\s+(va\s+a\s+salir|saldra|saldran)\b/,
  /\bconsenso\b/,
  /\bantes\s+de\s+(los\s+)?(resultados|earnings)\b/,
  // Inglés
  /\bwhat\s+to\s+expect\b/,
  /\bexpectations?\s+(for|on)\b/,
  /\b(earnings\s+)?preview\b/,
  /\bconsensus\s+(for|on)\b/,
  /\bwill\s+.{0,20}\b(beat|miss|top)\b/,
  /\bis\s+.{0,20}\bexpected\s+to\b/,
  /\bhow\s+is\s+.{0,25}\bexpected\b/,
  /\bahead\s+of\s+(the\s+)?(earnings|results|print|quarter)\b/,
];

/**
 * Ruido de la propia pregunta de PREVIA, para el canal léxico. Mismo motivo
 * que `DECISION_NOISE`: en "¿cómo se espera que sea la earnings report de
 * $NU?" las plazas se las comen "espera", "earnings" y "report", y ninguna
 * distingue una noticia de otra dentro del propio ticker.
 */
export const PREVIEW_NOISE = new Set([
  "espera", "esperan", "esperas", "esperado", "esperada", "expectativa",
  "expectativas", "previa", "consenso", "resultados", "trimestre",
  "batir", "superar", "fallar", "decepcionar", "batira", "superara",
  "salir", "saldra", "antes",
  "expect", "expected", "expectations", "preview", "consensus", "earnings",
  "report", "quarter", "results", "beat", "miss", "ahead", "print",
]);

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
  // "add" suelto es seguro AQUÍ y no lo sería en `OPINION`: esta lista sólo
  // abre la puerta en CONJUNCIÓN con primera persona o petición de juicio,
  // así que "What are insiders adding lately?" sigue siendo archivo.
  /\badd(ing)?\b/,
];

/**
 * Peticiones de OPINIÓN: frases que piden un juicio SIN verbo de operación.
 *
 * El agujero medido (2026-07-31, "¿qué te parece SOFI a largo plazo?"): la
 * conjunción de abajo usa el verbo de ACCIÓN como puerta, y una petición de
 * opinión pura no lo lleva — caía a archivo y el bibliotecario respondía con
 * la ficha del valor, que no contesta lo que se preguntó.
 *
 * Estas frases clasifican SOLAS, sin la conjunción, porque tienen la
 * propiedad que a los verbos de acción les falta: no aparecen en titulares
 * ni en preguntas de archivo ("¿qué se dijo de la compra de Iridium?" lleva
 * "compra"; nadie le pregunta "¿qué te parece?" a un archivo esperando un
 * dato). "A largo plazo" a secas queda FUERA a propósito: "¿cuál es la guía
 * a largo plazo de MSFT?" es una consulta de archivo legítima.
 */
const OPINION = [
  // Español — SIEMPRE en tú Y en usted. El fallo medido (2026-07-31,
  // segunda vez): "¿qué LE parece comprar SOFI a largo plazo?" — el usuario
  // le habla de usted al Ask y el detector sólo sabía "te parece". Y como
  // "comprar" es verbo de acción, la pregunta entró por la conjunción
  // (acción sin primera persona ni juicio) y cayó a archivo otra vez.
  /\bque\s+(te|le|os|les)\s+parec(e|en|eria)\b/,
  /\bque\s+(opinas|piensas)\b/,
  /\bque\s+(opina|piensa)\s+usted\b/,
  /\bcomo\s+(lo|la|los|las)\s+ves\b/,
  /\bcomo\s+ves\b/,
  /\bcomo\s+(lo|la|los|las)?\s*ve\s+usted\b/,
  /\b(tu|su)\s+(opinion|lectura|tesis|postura|vision)\b/,
  /\bte\s+mojas\b|\bse\s+moja\b|\bmojate\b|\bmojese\b/,
  // El condicional de SEGUNDA persona ES la petición de juicio: "¿comprarías?"
  // pregunta qué harías tú, no qué pasó. La tercera persona queda FUERA a
  // propósito: "¿por qué compraría Buffett esta acción?" es archivo — por
  // eso la forma sin -s sólo entra pegada a "usted".
  /\b(comprarias|venderias|aguantarias|recortarias|ampliarias|entrarias|saldrias|mantendrias)\b/,
  /\b(compraria|venderia|aguantaria|recortaria|ampliaria|entraria|saldria|mantendria)\s+usted\b/,
  /\balcista\s+o\s+bajista\b/,
  /\b(merece|mereceria|vale|valdria)\s+la\s+pena\b/,
  // Inglés
  /\bwhat\s+do\s+you\s+think\b/,
  /\byour\s+take\b/,
  /\bthoughts\s+on\b/,
  /\bhow\s+do\s+you\s+see\b/,
  /\bwould\s+you\s+(buy|sell|hold|trim|enter|exit|add)\b/,
  /\bbullish\s+or\s+bearish\b/,
  /\bworth\s+it\b/,
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
  // Añadidas el 2026-08-07. El agujero medido: "¿debería comprar más $NU?"
  // clasificaba ARCHIVO y contestaba el bibliotecario, que tiene prohibido
  // opinar — la queja original con otra redacción. Lleva verbo de acción
  // ("comprar") pero ninguna marca de primera persona escrita ni ninguna de
  // las peticiones de juicio que había aquí. Lo mismo con "¿tiene sentido
  // ampliar en $SOFI?" y "¿es buen momento para entrar en $RKLB?".
  //
  // SÓLO las formas de primera persona de deber: "debo", "debemos",
  // "debería", "deberíamos". "debe" / "debes" / "deben" quedan FUERA a
  // propósito — son tercera persona y "¿la empresa debe vender su división?"
  // es una pregunta de archivo perfectamente legítima que lleva verbo de
  // acción y entraría en modo decisión con bloques sobre el dinero de nadie.
  /\bdeb(o|emos|eria|eriamos)\b/,
  /\btiene\s+sentido\b/,
  /\bes\s+(un\s+)?(buen|mal)\s+momento\b/,
  /\bgood\s+time\s+to\b/,
  // Añadidas el 2026-08-08. El agujero medido: "¿es momento de vender
  // Palantir?" clasificaba ARCHIVO y contestó el bibliotecario con la ficha
  // de resultados, sin decir ni una palabra sobre vender — la queja original
  // con su QUINTA redacción. "es buen/mal momento" estaba (arriba); la misma
  // pregunta SIN adjetivo, que es como se dice en la calle, no. La familia
  // entera es el juicio TEMPORAL: preguntar si es la hora de hacerlo.
  //
  // Ninguna clasifica sola — todas exigen la conjunción con un verbo de
  // acción, así que "¿en qué momento de la llamada habló del capex?" o
  // "¿cuándo es el momento de mayor volumen?" siguen siendo archivo.
  /\b(es|sera|llego|ha\s+llegado)\s+(ya\s+)?(el\s+)?momento\s+de\b/,
  /\bes\s+(ya\s+)?hora\s+de\b/,
  /\bva\s+siendo\s+hora\b/,
  /\btoca\s+(ya\s+)?(vender|comprar|salir|recortar|ampliar|aguantar|entrar)\b/,
  /\bis\s+it\s+time\b/,
  /\btime\s+to\s+(sell|buy|exit|trim|add|enter|take)\b/,
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
  // Vocabulario de las preguntas de OPINIÓN: en "¿qué te parece SOFI a
  // largo plazo?" las 6 plazas del canal léxico se las comían "parece",
  // "largo" y "plazo" — ninguna nombra nada del mundo.
  "parece", "parecen", "pareceria", "opinas", "piensas", "opina", "piensa",
  "usted", "ves", "opinion", "lectura", "postura", "tesis", "vision",
  "mojas", "moja", "mojate", "mojese", "alcista", "bajista",
  "comprarias", "venderias", "aguantarias", "recortarias", "ampliarias",
  "entrarias", "saldrias", "mantendrias", "compraria", "venderia",
  "largo", "plazo", "think", "thoughts", "take", "bullish", "bearish",
  "term", "would",
  // Vocabulario del juicio temporal (2026-08-08): en "¿es momento de vender
  // Palantir?" las plazas del canal léxico se las comían "momento" y
  // "vender" — ninguna nombra nada del mundo.
  "momento", "hora", "llegado", "siendo", "toca", "time",
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
 * QUÉ decisión se está preguntando, no sólo QUE es una decisión.
 *
 * El agujero medido (2026-07-31): "¿qué te parece COMPRAR SOFI a largo
 * plazo?" clasificaba bien como decisión… y la respuesta venía en clave
 * aguantar/recortar — contestaba a una pregunta que nadie hizo. El prompt
 * necesita saber si se pregunta por ENTRAR dinero nuevo o por SACARLO para
 * exigir que el veredicto responda a ESA pregunta.
 *
 * `general` cuando no hay verbo direccional o hay de los dos lados ("¿vendo
 * o amplío?"): ahí el abanico completo de veredictos es la respuesta.
 */
export type AskFocus = "entry" | "exit" | "general";

const ENTRY = [
  /\bcompr(o|as|amos|ar|arla|arlo|aria|arias|ariamos)\b/,
  /\bentr(o|amos|ar|aria|arias)\b/,
  /\bampli(o|amos|ar|aria|arias)\b/,
  /\breforzar\b|\brefuerz(o|as)\b/,
  /\banad(o|ir|iria)\b/,
  /\binversion\b|\binvertir\b|\binviert(o|es|a)\b/,
  /\bbuy(ing)?\b/,
  /\benter(ing)?\b/,
  /\b(double|average)\s+down\b/,
  /\badd(ing)?\s+(to|more)\b/,
];

const EXIT = [
  /\bvend(o|es|e|emos|er|erla|erlo|eria|erias|iera)\b/,
  /\bsal(go|imos|ir|iria|irme)\b/,
  /\brecort(o|amos|ar|arla|arlo|aria|arias)\b/,
  /\bcierr(o|a)\b|\bcerrar\b/,
  /\bdeshac(er|erme)\b|\bdeshag(o|amos)\b/,
  /\b(tomar|recoger|realizar)\s+(beneficios|ganancias|plusvalias)\b/,
  /\bsell(ing|s)?\b/,
  /\bexit(ing)?\b/,
  /\btrim(ming|s)?\b/,
  /\btake\s+profits?\b/,
  /\bcut\s+(my|the)\s+(loss|losses|position)\b/,
];

export function classifyFocus(question: string): AskFocus {
  const q = normalizeQuestion(question);
  const entry = ENTRY.some((re) => re.test(q));
  const exit = EXIT.some((re) => re.test(q));
  if (entry && !exit) return "entry";
  if (exit && !entry) return "exit";
  return "general";
}

/**
 * Decisión = una petición de OPINIÓN explícita (vale por sí sola), o bien
 * un VERBO DE ACCIÓN sobre una posición **y** además o bien la pregunta
 * habla en primera persona o bien pide explícitamente un juicio.
 *
 * La conjunción no es cautela gratuita, es lo que separa estos dos casos
 * reales que comparten el mismo verbo:
 *
 *   "What are insiders buying lately?"        → archivo (no es tu dinero)
 *   "¿es buena idea dejar correr $MSFT…?"     → decisión
 *
 * OPINION va por fuera de la conjunción: "¿qué te parece SOFI a largo
 * plazo?" no lleva verbo de operación y aun así sólo admite una respuesta
 * que se moje.
 */
export function classifyIntent(question: string): AskIntent {
  const q = normalizeQuestion(question);
  if (OPINION.some((re) => re.test(q))) return "decision";
  const hasAction = ACTION.some((re) => re.test(q));
  const hasSelf = SELF.some((re) => re.test(q));
  const hasAdvisory = ADVISORY.some((re) => re.test(q));
  if (hasAction && (hasSelf || hasAdvisory)) return "decision";
  // La PREVIA va después de la decisión y antes del archivo. El orden no es
  // arbitrario: "¿compro $NU antes de resultados?" casa los dos —lleva verbo
  // de acción, primera persona Y "antes de resultados"— y pregunta por el
  // dinero, no por el trimestre. Quien pregunta qué hacer con su posición
  // quiere un veredicto, no una previa.
  if (PREVIEW.some((re) => re.test(q))) return "preview";
  return "archive";
}
