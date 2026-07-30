// El MARCO de una posición: qué clase de empresa crees que es.
//
// TS puro (sin BD, sin red). Es la pieza que hace posible el coach, y vale
// la pena entender por qué existe antes de tocarla.
//
// ─── EL PROBLEMA QUE RESUELVE ───────────────────────────────────────────
//
// El diseño obvio de un detector de "tesis rota" es una lista de umbrales:
// margen por debajo de X, guidance recortada, insiders vendiendo. Ese
// diseño NO PUEDE FUNCIONAR, y el contraejemplo es el caso normal, no el
// raro:
//
//   META estrecha márgenes gastando en infraestructura de IA y provisiones
//   legales, mientras el negocio principal sigue creciendo con fuerza.
//
// Un umbral sobre el margen dispara "tesis en riesgo". Está exactamente al
// revés: ese estrechamiento ES la tesis ejecutándose. Quien compró META
// como apuesta de largo plazo compró precisamente eso.
//
// Y el mismo margen estrechándose en una empresa madura que ya sólo tiene
// que cosechar SÍ es la alarma. Mismo número, lectura opuesta.
//
// ─── LA SOLUCIÓN ────────────────────────────────────────────────────────
//
// La diferencia no está en el número: está en la CAPA que se ha movido y
// en qué clase de empresa crees tener. Así que el usuario declara el marco,
// y el marco decide qué es ruido y qué es mortal. Sin marco declarado no
// hay lectura posible — y eso es preferible a una lectura inventada.
//
// Lo que este módulo NO hace: decidir si la tesis está rota. Sólo dice cómo
// de grave es una señal DADO el marco. Concluir sólo se puede cuando se
// cumple un falsador que el usuario aprobó.

/** Las tres capas en las que puede caer un movimiento de los números.
 *
 *  La descomposición es lo único que separa "el margen baja porque el
 *  negocio se deteriora" de "el margen baja porque estamos comprando el
 *  futuro". Sale del propio comunicado: las empresas ATRIBUYEN sus
 *  variaciones ("driven by increased infrastructure investment"), y esa
 *  frase es el dato que nadie lee. */
export const LAYERS = ["nucleo", "inversion", "no_recurrente"] as const;
export type Layer = (typeof LAYERS)[number];

export const LAYER_LABEL: Record<Layer, string> = {
  nucleo: "negocio principal",
  inversion: "inversión deliberada",
  no_recurrente: "no recurrente",
};

export const LAYER_HINT: Record<Layer, string> = {
  nucleo: "ingresos, márgenes y crecimiento del negocio que ya funciona",
  inversion: "capex, I+D y pérdidas del segmento que se está construyendo",
  no_recurrente: "provisiones legales, cargos únicos, divisa",
};

/** Qué le pasa a la tesis cuando una señal cae en una capa.
 *
 *  `esperado` NO es "sin importancia": es una afirmación fuerte y útil —
 *  «esto que parece malo es lo que compraste». Es justo lo que un detector
 *  por umbral no sabe decir. */
export type Severity = "esperado" | "vigilar" | "mortal";

export const FRAMES = [
  "power_play",
  "compounder",
  "turnaround",
  "ciclica",
] as const;
export type Frame = (typeof FRAMES)[number];

export function isFrame(v: unknown): v is Frame {
  return typeof v === "string" && (FRAMES as readonly string[]).includes(v);
}

/** Las señales que el coach sabe clasificar. Deliberadamente pocas: cada
 *  una tiene que ser extraíble de un comunicado o de un filing, y una
 *  taxonomía que no se puede rellenar con datos reales es decoración. */
export const SIGNALS = [
  "margen_comprimido",
  "capex_disparado",
  "nucleo_desacelera",
  "guidance_recortada",
  "hito_incumplido",
  "cuota_perdida",
  "insider_vendiendo",
  "deuda_creciendo",
] as const;
export type Signal = (typeof SIGNALS)[number];

export const SIGNAL_LABEL: Record<Signal, string> = {
  margen_comprimido: "margen comprimido",
  capex_disparado: "capex disparado",
  nucleo_desacelera: "el negocio principal desacelera",
  guidance_recortada: "guidance recortada",
  hito_incumplido: "hito incumplido",
  cuota_perdida: "cuota de mercado perdida",
  insider_vendiendo: "directivos vendiendo de forma sistemática",
  deuda_creciendo: "deuda creciendo",
};

type FrameSpec = {
  label: string;
  /** Artículo con el que se nombra el marco en prosa. `label` solo no basta:
   *  "en una compounder" y "en un cíclica" son las dos formas de que el panel
   *  se lea como una traducción automática. */
  article: "un" | "una";
  /** Cómo se reconoce. Va en la UI: elegir mal el marco envenena todo lo
   *  que cuelga de él, así que la elección tiene que ser fácil de acertar. */
  hint: string;
  /** Qué significa "el núcleo" para esta clase de empresa. Es lo que el
   *  extractor de earnings tiene que ir a buscar. */
  core: string;
  /** Severidad por señal. Lo que no aparece cae en `vigilar`: un hueco no
   *  puede degradar a "esperado" — callar sobre algo desconocido sería
   *  tranquilizar sin base. */
  severity: Partial<Record<Signal, Severity>>;
};

/**
 * La tabla que invierte la lectura.
 *
 * Léela en columnas y se ve el porqué: `capex_disparado` es `esperado` en
 * una power play y `mortal` en un compounder. No es una escala de dureza —
 * es que significan cosas distintas. Un compounder que de pronto necesita
 * capex pesado ha dejado de ser un compounder, y eso sí rompe la tesis con
 * la que se compró.
 */
export const FRAME_SPEC: Record<Frame, FrameSpec> = {
  power_play: {
    label: "power play",
    article: "una",
    hint: "gasta hoy para ganar mañana: un núcleo que genera caja financiando una apuesta cara",
    core: "crecimiento de ingresos y márgenes del negocio ya establecido, ANTES del gasto de la apuesta",
    severity: {
      // Lo que compraste. Que suba el capex no es una grieta: es la obra.
      capex_disparado: "esperado",
      // El margen se estrecha POR el capex. Sólo importa si se estrecha
      // en el núcleo, y eso lo dice la atribución, no la cifra agregada.
      margen_comprimido: "esperado",
      // ÉSTA es la mortal, y es la que un umbral sobre márgenes no ve: si
      // el núcleo se frena, la apuesta se queda sin quien la financie y la
      // tesis entera se cae.
      nucleo_desacelera: "mortal",
      cuota_perdida: "mortal",
      // Gastar mucho con deuda creciente cambia quién soporta la apuesta.
      deuda_creciendo: "vigilar",
      guidance_recortada: "vigilar",
      insider_vendiendo: "vigilar",
    },
  },
  compounder: {
    label: "compounder",
    article: "un",
    hint: "ya cosecha: crece de forma constante sin necesitar gasto pesado",
    core: "estabilidad del margen y crecimiento sostenido sin capex extraordinario",
    severity: {
      // Aquí sí: el margen ES la tesis. Comprimirlo es romperla.
      margen_comprimido: "mortal",
      // Un compounder que de pronto necesita capex pesado ha dejado de ser
      // un compounder — la tesis con la que se compró ya no aplica.
      capex_disparado: "mortal",
      nucleo_desacelera: "mortal",
      guidance_recortada: "vigilar",
      cuota_perdida: "vigilar",
      deuda_creciendo: "vigilar",
      insider_vendiendo: "vigilar",
    },
  },
  turnaround: {
    label: "turnaround",
    article: "un",
    hint: "empresa rota que se está arreglando: la tesis es el PLAN, no los números de hoy",
    core: "cumplimiento del calendario de recuperación anunciado por la dirección",
    severity: {
      // Perder dinero es el punto de partida, no la noticia.
      margen_comprimido: "esperado",
      // Incumplir lo prometido es lo único que importa: es la tesis.
      hito_incumplido: "mortal",
      guidance_recortada: "mortal",
      // En una empresa que ya venía rota, la deuda es lo que decide si hay
      // tiempo para arreglarla.
      deuda_creciendo: "mortal",
      nucleo_desacelera: "vigilar",
      capex_disparado: "vigilar",
      insider_vendiendo: "vigilar",
    },
  },
  ciclica: {
    label: "cíclica",
    article: "una",
    hint: "sube y baja con su ciclo: los malos números en el valle son parte del guion",
    core: "posición competitiva y cuota a lo largo del ciclo, no el resultado del trimestre",
    severity: {
      // Caer en el valle es lo que hacen las cíclicas.
      margen_comprimido: "esperado",
      nucleo_desacelera: "esperado",
      guidance_recortada: "esperado",
      // Lo que no se recupera cuando gira el ciclo: la cuota perdida.
      cuota_perdida: "mortal",
      // Y la deuda es lo que determina si llegas vivo al siguiente ciclo.
      deuda_creciendo: "mortal",
      capex_disparado: "vigilar",
      insider_vendiendo: "vigilar",
    },
  },
};

/**
 * Un movimiento de los números, con la capa a la que la EMPRESA lo atribuye.
 *
 * Es el dato que hacía falta y que no teníamos. `readBetweenLines` ya
 * observaba ("margin pressure"), pero observar no basta: el margen
 * estrechándose por comprar infraestructura y el margen estrechándose
 * porque el negocio pierde fuelle son el mismo número y la lectura opuesta.
 * Lo que los separa es la ATRIBUCIÓN, y está escrita en el comunicado
 * ("driven by increased infrastructure investment"). Nadie la lee.
 *
 * `quote` no es adorno: es lo que permite comprobar que la capa no se la ha
 * inventado el modelo. Una atribución sin cita se acepta, pero se marca —
 * el coach dirá que la capa es una lectura y no una declaración.
 */
export type Attribution = {
  signal: Signal;
  layer: Layer;
  /** Qué se movió y cuánto, con las palabras y la magnitud del comunicado. */
  magnitude: string;
  /** Frase literal donde la empresa atribuye el movimiento. `null` si el
   *  comunicado no lo atribuye: entonces la capa es inferencia. */
  quote: string | null;
};

function isSignal(v: unknown): v is Signal {
  return typeof v === "string" && (SIGNALS as readonly string[]).includes(v);
}

function isLayer(v: unknown): v is Layer {
  return typeof v === "string" && (LAYERS as readonly string[]).includes(v);
}

/**
 * Valida lo que devuelve el extractor. Descarta en silencio lo que no encaje
 * en el vocabulario en vez de intentar mapearlo: una señal inventada por el
 * modelo entraría en `severityOf` como `vigilar` y produciría una alarma
 * sobre algo que nadie definió.
 */
export function parseAttributions(raw: unknown): Attribution[] {
  if (!Array.isArray(raw)) return [];
  const out: Attribution[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    if (!isSignal(o.signal) || !isLayer(o.layer)) continue;
    const magnitude =
      typeof o.magnitude === "string" && o.magnitude.trim()
        ? o.magnitude.trim().slice(0, 220)
        : null;
    if (!magnitude) continue; // sin magnitud no hay nada que contar
    const quote =
      typeof o.quote === "string" && o.quote.trim()
        ? o.quote.trim().slice(0, 400)
        : null;
    out.push({ signal: o.signal, layer: o.layer, magnitude, quote });
  }
  // Tope de cordura: un comunicado con 20 "señales" es el modelo troceando
  // el mismo hecho, no una empresa con veinte problemas.
  return out.slice(0, 8);
}

/**
 * Gravedad de una señal DADO el marco declarado.
 *
 * Sin marco devuelve `null`, no una severidad por defecto. Elegir un
 * default sería exactamente el error que este módulo existe para evitar:
 * cualquier valor que pusiéramos leería mal la mitad de las carteras.
 */
export function severityOf(frame: Frame | null, signal: Signal): Severity | null {
  if (frame === null) return null;
  return FRAME_SPEC[frame].severity[signal] ?? "vigilar";
}

/**
 * ¿Esta señal contradice la tesis, o la confirma?
 *
 * La respuesta útil para el usuario no es la severidad a secas sino la
 * frase que la acompaña. Una señal `esperado` merece decirse EN VOZ ALTA
 * ("esto que parece malo es lo que compraste"): callarla dejaría al usuario
 * leyendo el titular alarmista sin el contexto que él mismo declaró.
 */
export function readingOf(
  frame: Frame | null,
  signal: Signal,
  layer: Layer | null,
): { severity: Severity | null; note: string } {
  const sev = severityOf(frame, signal);
  if (sev === null) {
    return {
      severity: null,
      note: "sin marco declarado para esta posición: no se puede leer si esto contradice tu tesis",
    };
  }
  const f = FRAME_SPEC[frame!];
  if (sev === "esperado") {
    return {
      severity: sev,
      note: `en ${f.article} ${f.label} esto es lo esperado, no una grieta`,
    };
  }
  if (sev === "mortal") {
    return {
      severity: sev,
      note: `en ${f.article} ${f.label} esto golpea la tesis en su raíz: ${f.core}`,
    };
  }
  // El caso intermedio es donde la capa manda: la MISMA señal marcada como
  // "vigilar" pesa distinto si golpeó el negocio principal o si es un cargo
  // que no se repite.
  if (layer === "nucleo") {
    return {
      severity: sev,
      note: "cae en el negocio principal, que es donde sí importa",
    };
  }
  if (layer === "no_recurrente") {
    return {
      severity: sev,
      note: "es un cargo que no se repite: no dice nada del negocio",
    };
  }
  return { severity: sev, note: "conviene seguirlo, sin ser concluyente" };
}
