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
//
// ─── DOS EJES, NO UNO (2026-08-12) ────────────────────────────────────────
//
// EL AGUJERO QUE TAPA, medido con "porque esta cayendo mi cartera hoy, ve
// stock por stock": la respuesta habló de Altria, Rollins, Alphabet, Life360,
// Aeva y Sandisk. Ninguna está en la cartera (PLTR, RKLB, ZETA, SOFI, MSFT,
// META, NU). 20 de 20 citas eran de empresas ajenas.
//
// No fue el redactor ni el modelo: fue que un solo enum de tres valores
// decidía a la vez DOS preguntas independientes.
//
//   ALCANCE (scope) — ¿sobre QUÉ símbolos?  named · portfolio · thematic
//   TRABAJO (job)   — ¿qué quiere el lector? archive · diagnose · decision · preview
//
// "mi cartera" tiene alcance `portfolio` y trabajo `diagnose`. Con un enum
// único no existía ninguna casilla para eso, así que caía al valor por
// defecto (`archive`), y sin símbolos extraídos el retrieval se quedó con
// una búsqueda semántica pura sobre "acción que cae hoy" — la frase más
// genérica que existe en un archivo financiero: casó con todos los "Why X
// Stock Is Sinking Today" del archivo. El retrieval hizo su trabajo
// perfectamente sobre la pregunta equivocada.
//
// Las cinco regresiones anteriores se taparon ensanchando expresiones
// regulares. Ésta no se puede: ninguna regex crea un alcance que no existe.

/** ¿Sobre QUÉ símbolos va la pregunta? */
export type AskScope = "named" | "portfolio" | "thematic";

/** ¿Qué trabajo pide el lector? */
export type AskJob = "decision" | "preview" | "diagnose" | "archive";

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
 * ALCANCE DE CARTERA: la pregunta va sobre el LIBRO ENTERO, no sobre un
 * valor. Los símbolos no hay que adivinarlos — están en la watchlist.
 *
 * Estas frases clasifican SOLAS y no necesitan conjunción con nada, porque
 * tienen una propiedad que a los verbos de acción les falta: **no aparecen
 * en titulares**. Nadie le pregunta a un archivo de noticias por "mi
 * cartera". El posesivo de primera persona es obligatorio: "la cartera de
 * Buffett" o "la cartera de bonos del BCE" son consultas de archivo
 * legítimas y quedan fuera.
 */
const PORTFOLIO = [
  // Español
  /\b(mi|mis)\s+(cartera|carteras|portfolio|posicion|posiciones|acciones|valores|inversiones|participaciones|book)\b/,
  /\b(la|toda\s+la|mi\s+propia)\s+cartera\s+(entera|completa|al\s+completo)\b/,
  /\btoda\s+mi\s+(cartera|exposicion)\b/,
  /\bmi\s+exposicion\s+(total|global|entera)\b/,
  // Inglés
  /\bmy\s+(portfolio|positions|holdings|book|stocks|names|exposure)\b/,
  /\b(the\s+)?(whole|entire|full)\s+(portfolio|book)\b/,
  /\bacross\s+(my|the)\s+(portfolio|positions|holdings|book)\b/,
];

/**
 * Ruido de la propia pregunta de CARTERA, para el canal léxico. Mismo motivo
 * que `DECISION_NOISE`: en "por qué está cayendo mi cartera hoy, ve stock por
 * stock" las 6 plazas se las comían "cayendo", "cartera", "stock" y "hoy" —
 * y "stock" casa por subcadena con literalmente medio archivo financiero.
 */
export const PORTFOLIO_NOISE = new Set([
  "cartera", "carteras", "posicion", "posiciones", "acciones", "valores",
  "inversiones", "participaciones", "exposicion", "entera", "completa",
  "toda", "todas", "stock", "stocks", "valor",
  "portfolio", "positions", "holdings", "book", "names", "exposure",
  "whole", "entire", "full", "across", "each", "every",
]);

/**
 * TRABAJO de DIAGNÓSTICO: "¿por qué se mueve esto?". No es una consulta de
 * archivo y no es una decisión.
 *
 * El bibliotecario tiene PROHIBIDO opinar, así que ante "por qué cae" lo
 * máximo que puede hacer es enumerar noticias y dejar que el lector deduzca
 * la causa. Pero atribuir una caída a un hecho ES el trabajo que se pide, y
 * es verificable: no se predice nada, se explica algo que ya pasó.
 *
 * No exige símbolo — con alcance `portfolio` el diagnóstico va posición a
 * posición, que es justo la pregunta que abrió esto.
 */
const DIAGNOSE = [
  // Español
  /\bpor\s?que\s+.{0,30}\b(cae|caen|cayo|cayeron|baja|bajan|bajo|sube|suben|subio|subieron|se\s+hunde|se\s+desploma|se\s+dispara)\b/,
  /\bpor\s?que\s+.{0,30}\bes(ta|tan)\s+(cayendo|bajando|subiendo|hundiendo|desplomando|disparando|en\s+rojo|en\s+verde)\b/,
  /\ba\s+que\s+se\s+deb(e|en)\b/,
  /\bque\s+(le\s+)?(pasa|paso|ocurre|ocurrio)\s+(a|con)\b/,
  /\bque\s+esta\s+pasando\s+(con|en)\b/,
  /\bque\s+explica\b/,
  /\bmotivo\s+de\s+la\s+(caida|subida)\b/,
  /\bcausa\s+de\s+la\s+(caida|subida)\b/,
  // Inglés
  /\bwhy\s+(is|are|did|was|were|has|have)\b.{0,30}\b(fall|falling|fell|drop|dropping|dropped|down|up|sink|sinking|rise|rising|rose|crash|crashing|tank|tanking|slide|sliding|plunge|plunging|jump|jumping)\b/,
  /\bwhat(?:'s| is)\s+(going\s+on|happening)\s+with\b/,
  /\bwhat\s+happened\s+(to|with)\b/,
  /\bwhat(?:'s| is)\s+driving\b/,
  /\bwhat\s+explains\b/,
  /\breason\s+for\s+the\s+(drop|fall|decline|selloff|sell-off|rally|jump)\b/,
];

/**
 * Ruido del diagnóstico para el canal léxico. "cae", "hoy" y "por qué" no
 * distinguen una noticia de otra, y "cae"/"baja" casan por subcadena con
 * media portada.
 */
export const DIAGNOSE_NOISE = new Set([
  "cae", "caen", "cayo", "cayeron", "cayendo", "caida", "baja", "bajan",
  "bajando", "sube", "suben", "subio", "subiendo", "subida", "hunde",
  "hundiendo", "desploma", "desplomando", "dispara", "rojo", "verde",
  "debe", "deben", "pasa", "paso", "ocurre", "ocurrio", "pasando",
  "explica", "motivo", "causa", "hoy", "ahora", "porque",
  "falling", "fell", "dropping", "dropped", "sinking", "rising", "rose",
  "crashing", "tanking", "sliding", "plunging", "jumping", "down",
  "happening", "happened", "driving", "explains", "reason", "today",
  "selloff", "decline", "rally",
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

/**
 * Sujeto de TERCERA PERSONA: el que compró o vendió es OTRO.
 *
 * Anula la mitad "primera persona" de la conjunción, y no es cautela
 * teórica — el fallo estaba vivo y lo cazó un test el 2026-08-12: **"quién
 * compró acciones de SOFI" clasificaba DECISIÓN**. `normalizeQuestion` quita
 * las tildes para poder escribir cada patrón una sola vez, así que "compró"
 * (tercera del pasado) y "compro" (primera del presente) son la MISMA cadena,
 * y `SELF` lista "compro" como marca de "esto es dinero mío". Resultado: una
 * consulta de archivo perfectamente normal recibía bloques de aguantar y
 * recortar sobre el dinero de nadie — el mismo fallo que la conjunción existe
 * para evitar, entrando por la puerta de atrás.
 *
 * No se arregla con la tilde: el usuario escribe sin ellas ("porque esta
 * cayendo mi cartera"). Lo que sí desambigua es el SUJETO.
 *
 * No toca `ADVISORY`: "¿quién debería vender aquí?" sigue pidiendo juicio.
 */
const THIRD_PARTY_SUBJECT = [
  /\b(quien|quienes)\b/,
  /\bque\s+(directivo|directivos|fondo|fondos|empresa|empresas|insider|insiders|analista|analistas|gestora|gestoras)\b/,
  /\bwho\b/,
  /\bwhich\s+(fund|funds|insider|insiders|exec|execs|executive|executives|firm|firms)\b/,
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
export function classifyJob(question: string): AskJob {
  const q = normalizeQuestion(question);
  if (OPINION.some((re) => re.test(q))) return "decision";
  const hasAction = ACTION.some((re) => re.test(q));
  const hasSelf =
    !THIRD_PARTY_SUBJECT.some((re) => re.test(q)) && SELF.some((re) => re.test(q));
  const hasAdvisory = ADVISORY.some((re) => re.test(q));
  if (hasAction && (hasSelf || hasAdvisory)) return "decision";
  // La PREVIA va después de la decisión y antes del archivo. El orden no es
  // arbitrario: "¿compro $NU antes de resultados?" casa los dos —lleva verbo
  // de acción, primera persona Y "antes de resultados"— y pregunta por el
  // dinero, no por el trimestre. Quien pregunta qué hacer con su posición
  // quiere un veredicto, no una previa.
  if (PREVIEW.some((re) => re.test(q))) return "preview";
  // El DIAGNÓSTICO va el penúltimo, justo por encima del archivo. Cede ante
  // los tres de arriba a propósito: "¿vendo porque está cayendo?" pregunta
  // qué hacer con el dinero y el porqué de la caída es sólo el contexto.
  if (DIAGNOSE.some((re) => re.test(q))) return "diagnose";
  return "archive";
}

/**
 * ALCANCE: sobre qué símbolos va la pregunta.
 *
 * `hasNamedSymbols` lo decide el llamante porque la extracción toca BD
 * (alias, denylist) y este módulo es TS puro y testeable a mano.
 *
 * **Nombrar un valor GANA sobre el alcance de cartera**, y no es un detalle:
 * "¿por qué cae MSFT en mi cartera?" señala una posición concreta, y abrir
 * las siete sería contestar a otra pregunta. El alcance de cartera es para
 * cuando NO se señala ninguna — que es exactamente cuando hoy el retrieval
 * se quedaba sin referente y salía a buscar por parecido semántico.
 */
export function classifyScope(
  question: string,
  hasNamedSymbols: boolean,
): AskScope {
  if (hasNamedSymbols) return "named";
  return PORTFOLIO.some((re) => re.test(normalizeQuestion(question)))
    ? "portfolio"
    : "thematic";
}
