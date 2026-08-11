// Qué CLASE de empresa crees que es una posición, y qué se sigue de eso.
//
// TS puro (sin BD, sin red). Es la pieza que hace posible el coach.
//
// ─── EL PROBLEMA QUE RESUELVE ───────────────────────────────────────────
//
// El diseño obvio de un detector de "tesis rota" es una lista de umbrales:
// margen por debajo de X, guidance recortada, insiders vendiendo. Ese
// diseño NO PUEDE FUNCIONAR, y el contraejemplo es el caso normal:
//
//   META estrecha márgenes gastando en infraestructura de IA mientras el
//   negocio principal sigue creciendo con fuerza.
//
// Un umbral sobre el margen dispara "tesis en riesgo". Está exactamente al
// revés: ese estrechamiento ES la tesis ejecutándose. Y el mismo margen
// estrechándose en una empresa madura que ya sólo tiene que cosechar SÍ es
// la alarma. Mismo número, lectura opuesta.
//
// ─── POR QUÉ EJES Y NO CUATRO ETIQUETAS ─────────────────────────────────
//
// La primera versión tenía cuatro marcos fijos (power play / compounder /
// turnaround / cíclica). Se rompió a las dos posiciones de una cartera real
// de siete, y las dos veces por lo mismo: describir una empresa con UNA
// etiqueta obliga a elegir cuál de sus rasgos importa.
//
//   - SOFI: "cíclica en transición a compounder" — dos etiquetas a la vez.
//   - META: "compounder defensivo de CAPITAL INTENSIVO, sujeto a
//     ciclicidad macroeconómica EXÓGENA" — tres rasgos ortogonales que
//     ninguna etiqueta contiene.
//
// META forzada a `power_play` daba una lectura correcta del capex y del
// margen, pero marcaba `nucleo_desacelera` como MORTAL. Con ciclicidad
// exógena eso es un falso positivo esperando a ocurrir: la próxima
// recesión publicitaria habría disparado "tesis rota" por algo que no es
// la empresa rompiéndose, sino el ciclo girando. Justo la clase de error
// que este módulo existe para evitar.
//
// Así que la unidad no es la etiqueta: son TRES EJES independientes. Las
// cuatro etiquetas siguen existiendo como ATAJOS (puntos comunes de ese
// espacio), pero lo que se guarda y lo que se lee son los ejes.

/** Cuánto capital necesita el negocio POR NATURALEZA, no este trimestre.
 *  Decide si un capex disparado es la obra o es la grieta. */
export const CAPITAL = ["alto", "bajo"] as const;
export type Capital = (typeof CAPITAL)[number];

/** En qué punto de su vida está. Decide qué significa que el núcleo frene. */
export const MADUREZ = ["cosechando", "construyendo", "recuperandose"] as const;
export type Madurez = (typeof MADUREZ)[number];

/** De dónde vienen sus malos trimestres. `exogeno` = de un ciclo que la
 *  empresa no controla (publicidad, tipos, materias primas, defensa), así
 *  que un bache no es deterioro. `secular` = si va mal, es cosa suya. */
export const CICLO = ["exogeno", "secular"] as const;
export type Ciclo = (typeof CICLO)[number];

export type Axes = { madurez: Madurez; capital: Capital; ciclo: Ciclo };

export const AXIS_LABEL = {
  madurez: {
    cosechando: "ya cosecha",
    construyendo: "está construyendo",
    recuperandose: "se está recuperando",
  } as Record<Madurez, string>,
  capital: {
    alto: "capital intensivo",
    bajo: "poco intensiva en capital",
  } as Record<Capital, string>,
  ciclo: {
    exogeno: "ciclo exógeno",
    secular: "sin ciclo externo",
  } as Record<Ciclo, string>,
};

export const AXIS_HINT = {
  madurez: {
    cosechando: "el negocio ya funciona y genera caja; crecer no exige gasto extraordinario",
    construyendo: "gasta hoy para ganar mañana: un núcleo que financia una apuesta cara",
    recuperandose: "empresa rota que se arregla; la tesis es el PLAN, no los números de hoy",
  } as Record<Madurez, string>,
  capital: {
    alto: "necesita invertir fuerte de forma permanente (infraestructura, fábricas, flota)",
    bajo: "crece sin necesitar capex pesado",
  } as Record<Capital, string>,
  ciclo: {
    exogeno: "sus malos trimestres vienen de un ciclo que no controla — no son deterioro",
    secular: "si los números empeoran, la causa es la empresa",
  } as Record<Ciclo, string>,
};

/** Qué le pasa a la tesis cuando aparece una señal.
 *
 *  `esperado` NO es "sin importancia": es una afirmación fuerte y útil —
 *  «esto que parece malo es lo que compraste». Es justo lo que un detector
 *  por umbral no sabe decir.
 *
 *  `confirma` (2026-07-31) es el espejo que faltaba: «la tesis se está
 *  cumpliendo donde importa». Sin él, el coach sólo sabía callar o alarmar
 *  — un trimestre excepcional producía únicamente sus dos grietas menores,
 *  sin contrapeso, y la lectura agregada salía bajista por construcción
 *  (caso MSFT medido: resultados récord → dos "mortal" y nada más). */
export type Severity = "confirma" | "esperado" | "vigilar" | "mortal";

export const SIGNALS = [
  "margen_comprimido",
  "capex_disparado",
  "nucleo_desacelera",
  "guidance_recortada",
  "hito_incumplido",
  "cuota_perdida",
  "insider_vendiendo",
  "deuda_creciendo",
  // Señales POSITIVAS (2026-07-31). El prompt del extractor siempre pidió
  // "movements worse OR better", pero el vocabulario sólo nombraba lo
  // peor: el modelo no puede emitir lo que el esquema no contempla (mismo
  // fallo de vocabulario sesgado que ya se midió en la atribución, en
  // espejo). Tres bastan: núcleo, margen y guidance son las tres cosas que
  // una tesis puede estar cumpliendo.
  "nucleo_acelera",
  "margen_expandido",
  "guidance_elevada",
  // El TERCER estado de la guía (2026-08-11). El vocabulario sólo tenía los
  // dos extremos —recortada y elevada—, así que "reafirmada" no era una
  // señal débil: era INEXPRESABLE, y el extractor no podía emitirla por
  // mucho que la leyera en el comunicado. Tercera vez que este proyecto se
  // encuentra el mismo agujero (faltaban las señales positivas; faltaba el
  // lado `add` en la mesa de decisión), y las tres veces con la misma
  // forma: el esquema es el techo de lo que el modelo puede decir.
  //
  // Y no es el estado neutro que parece. Una empresa que bate sus propios
  // números y aun así NO sube el año completo está diciendo algo: o no
  // tiene visibilidad, o se la guarda. Es lo que el mercado castiga sin que
  // ningún titular lo llame mala noticia (caso Adobe: "fiscal year 26 guide
  // reaffirmed not raised, market wanted a beat extension").
  "guidance_reiterada",
] as const;
export type Signal = (typeof SIGNALS)[number];

/** Las señales que afirman que algo va MEJOR. Se usan para elegir la nota:
 *  un "esperado" positivo no es «esto que parece malo es lo que compraste»
 *  sino «viento de cola del ciclo — no lo confundas con la tesis». */
export const POSITIVE_SIGNALS = new Set<Signal>([
  "nucleo_acelera",
  "margen_expandido",
  "guidance_elevada",
]);

export const SIGNAL_LABEL: Record<Signal, string> = {
  margen_comprimido: "margen comprimido",
  capex_disparado: "capex disparado",
  nucleo_desacelera: "el negocio principal desacelera",
  guidance_recortada: "guidance recortada",
  hito_incumplido: "hito incumplido",
  cuota_perdida: "cuota de mercado perdida",
  insider_vendiendo: "directivos vendiendo de forma sistemática",
  deuda_creciendo: "deuda creciendo",
  nucleo_acelera: "el negocio principal acelera",
  margen_expandido: "margen expandido",
  guidance_elevada: "guidance elevada",
  guidance_reiterada: "guidance reafirmada, no elevada",
};

// ─── Atajos ──────────────────────────────────────────────────────────────

/** Las cuatro etiquetas clásicas, ahora como PUNTOS del espacio de ejes.
 *  Siguen en la UI porque nombrar es más rápido que rellenar tres campos,
 *  pero lo canónico son los ejes: una empresa puede no ser ninguna de las
 *  cuatro (META no lo es) y el sistema tiene que admitirlo. */
export const PRESETS = {
  power_play: { madurez: "construyendo", capital: "alto", ciclo: "secular" },
  compounder: { madurez: "cosechando", capital: "bajo", ciclo: "secular" },
  turnaround: { madurez: "recuperandose", capital: "bajo", ciclo: "secular" },
  ciclica: { madurez: "cosechando", capital: "bajo", ciclo: "exogeno" },
} as const satisfies Record<string, Axes>;

export type Preset = keyof typeof PRESETS;
export const PRESET_NAMES = Object.keys(PRESETS) as Preset[];

export const PRESET_LABEL: Record<Preset, string> = {
  power_play: "power play",
  compounder: "compounder",
  turnaround: "turnaround",
  ciclica: "cíclica",
};

export function isPreset(v: unknown): v is Preset {
  return typeof v === "string" && (PRESET_NAMES as string[]).includes(v);
}

export function isMadurez(v: unknown): v is Madurez {
  return typeof v === "string" && (MADUREZ as readonly string[]).includes(v);
}
export function isCapital(v: unknown): v is Capital {
  return typeof v === "string" && (CAPITAL as readonly string[]).includes(v);
}
export function isCiclo(v: unknown): v is Ciclo {
  return typeof v === "string" && (CICLO as readonly string[]).includes(v);
}

/** Ejes válidos, o `null`. Se usa al leer de BD: las tres columnas son
 *  `text` y nullable, y una posición a medio clasificar NO se puede leer —
 *  media clasificación daría media lectura, que es peor que ninguna. */
export function parseAxes(raw: {
  madurez?: unknown;
  capital?: unknown;
  ciclo?: unknown;
}): Axes | null {
  if (!isMadurez(raw.madurez) || !isCapital(raw.capital) || !isCiclo(raw.ciclo)) {
    return null;
  }
  return { madurez: raw.madurez, capital: raw.capital, ciclo: raw.ciclo };
}

/** El atajo que coincide con estos ejes, si alguno. `null` = combinación
 *  legítima que ninguna etiqueta clásica nombra (el caso META). */
export function presetOf(a: Axes): Preset | null {
  for (const name of PRESET_NAMES) {
    const p = PRESETS[name];
    if (p.madurez === a.madurez && p.capital === a.capital && p.ciclo === a.ciclo) {
      return name;
    }
  }
  return null;
}

/** Cómo se nombra en prosa. Usa el atajo si existe y describe por ejes si
 *  no — sin esto, la combinación de META se quedaría sin nombre y el panel
 *  tendría que callar justo en el caso que motivó el refactor. */
export function describeAxes(a: Axes): string {
  const preset = presetOf(a);
  if (preset) return PRESET_LABEL[preset];
  const partes = [AXIS_LABEL.madurez[a.madurez], AXIS_LABEL.capital[a.capital]];
  if (a.ciclo === "exogeno") partes.push("con ciclo exógeno");
  return partes.join(", ");
}

/** Qué significa "el núcleo" para esta empresa: la vara contra la que se
 *  lee todo lo demás, y lo que el extractor de earnings tiene que buscar. */
export function coreOf(a: Axes): string {
  if (a.madurez === "recuperandose") {
    return "cumplimiento del calendario de recuperación anunciado por la dirección";
  }
  if (a.madurez === "construyendo") {
    return "crecimiento de ingresos y márgenes del negocio ya establecido, ANTES del gasto de la apuesta";
  }
  if (a.ciclo === "exogeno") {
    return "posición competitiva y cuota a lo largo del ciclo, no el resultado del trimestre";
  }
  return a.capital === "alto"
    ? "crecimiento del negocio principal, descontando la inversión estructural"
    : "estabilidad del margen y crecimiento sostenido sin capex extraordinario";
}

// ─── La lectura ──────────────────────────────────────────────────────────

/**
 * Gravedad de una señal DADOS los ejes.
 *
 * Cada rama tiene un porqué, no una intuición:
 *
 * - **capex**: con capital ALTO invertir fuerte es la naturaleza del
 *   negocio, no una desviación (META, MSFT construyendo centros de datos).
 *   Con capital bajo depende de la madurez: quien construye gasta por
 *   definición; quien ya cosecha y de pronto necesita capex pesado ha
 *   DEJADO DE SER lo que compraste.
 * - **núcleo desacelerando**: con ciclo EXÓGENO no se puede distinguir el
 *   bache del deterioro sin más trimestres, así que `vigilar` — nunca
 *   `mortal`. Ésa era la lectura que rompía META. Con ciclo secular sí es
 *   mortal salvo en una recuperación, donde los números malos son el punto
 *   de partida.
 * - **guidance**: en una recuperación incumplir lo prometido ES romper la
 *   tesis (la tesis es el plan). Con ciclo exógeno, recortar en el valle es
 *   el guion.
 * - **cuota perdida**: mortal siempre, salvo recuperándose — ahí soltar
 *   cuota no rentable puede ser el plan.
 * - **deuda**: mortal cuando el tiempo es la restricción (recuperación) o
 *   cuando hay que sobrevivir al valle de un ciclo sin la caja de un
 *   negocio intensivo detrás.
 * - **insiders**: nunca mortal y nunca esperado. Es una señal ambigua por
 *   naturaleza y fingir lo contrario sería inventar.
 *
 * Sin ejes devuelve `null`, no un valor por defecto: cualquier default
 * leería mal la mitad de las carteras.
 */
export function severityOf(axes: Axes | null, signal: Signal): Severity | null {
  if (axes === null) return null;
  const { madurez, capital, ciclo } = axes;

  switch (signal) {
    case "capex_disparado":
      if (capital === "alto") return "esperado";
      if (madurez === "construyendo") return "esperado";
      if (madurez === "cosechando") return "mortal";
      return "vigilar";

    case "margen_comprimido":
      if (capital === "alto") return "esperado";
      if (madurez !== "cosechando") return "esperado";
      return ciclo === "exogeno" ? "esperado" : "mortal";

    case "nucleo_desacelera":
      // La rama que motivó el refactor. Con ciclo exógeno, un núcleo que
      // frena puede ser la macro y no la empresa: no se puede afirmar.
      if (ciclo === "exogeno") return "vigilar";
      if (madurez === "recuperandose") return "vigilar";
      return "mortal";

    case "guidance_recortada":
      if (madurez === "recuperandose") return "mortal";
      return ciclo === "exogeno" ? "esperado" : "vigilar";

    case "hito_incumplido":
      return madurez === "cosechando" ? "vigilar" : "mortal";

    case "cuota_perdida":
      return madurez === "recuperandose" ? "vigilar" : "mortal";

    case "deuda_creciendo":
      if (madurez === "recuperandose") return "mortal";
      if (ciclo === "exogeno" && capital === "bajo") return "mortal";
      return "vigilar";

    case "insider_vendiendo":
      return "vigilar";

    // ── Positivas ─────────────────────────────────────────────────────
    // La misma asimetría que sus espejos negativos, en la otra dirección:
    // con ciclo EXÓGENO un buen trimestre puede ser el ciclo soplando a
    // favor y no la empresa — afirmar "confirma" sería el mismo error que
    // afirmar "mortal" cuando frena (la rama que rompía META). `esperado`
    // aquí significa «viento de cola: disfrútalo sin apuntártelo».
    case "nucleo_acelera":
    case "margen_expandido":
      return ciclo === "exogeno" ? "esperado" : "confirma";

    case "guidance_elevada":
      // La guidance es la DIRECCIÓN hablando de futuro, no el ciclo
      // hablando del presente: elevar el año completo con ciclo exógeno
      // sigue siendo la empresa comprometiéndose. Con recuperación es lo
      // más fuerte que puede pasar (la tesis ES el plan, y va adelantado).
      return "confirma";

    case "guidance_reiterada":
      // NUNCA `mortal`: la empresa no ha incumplido nada, sólo ha dejado de
      // prometer más. Poner mortal aquí devolvería el detector por umbral.
      //
      // Con ciclo EXÓGENO, mantener la vara es lo cuerdo y muchas veces lo
      // más honesto que puede hacer una dirección: subirla con la macro en
      // contra sería temerario, y recortarla en el valle ya es `esperado`
      // en la rama hermana. Simétrico con ella.
      if (ciclo === "exogeno") return "esperado";
      // Secular: aquí sí dice algo. Batir tus propios números y aun así no
      // comprometerte con el año completo es una afirmación sobre tu
      // visibilidad, y es lo que el mercado castiga sin que ningún titular
      // lo llame mala noticia (Adobe: "guide reaffirmed not raised, market
      // wanted a beat extension").
      //
      // `recuperandose` NO se separa a `confirma`, y es la decisión que más
      // se pensó. El espejo formal invitaba: si recortar es `mortal` donde
      // la tesis ES el plan, no deslizarse parece afirmativo. Pero
      // `confirma` significa en este módulo «la tesis cumpliéndose donde
      // importa», y una guía repetida no prueba eso — prueba que la
      // dirección repite. Una recuperación que reafirma trimestre tras
      // trimestre mientras los números no se mueven es la firma exacta de
      // la trampa de valor, y quien la ha pagado la describe así: no se
      // puede ir de A a Z de golpe y entonces anunciar que nada funcionó.
      // Lo que confirmaría una recuperación son los números moviéndose, y
      // para eso ya están `nucleo_acelera` y `margen_expandido`.
      return "vigilar";
  }
}

/**
 * ¿Esta señal contradice la tesis, o la confirma?
 *
 * La respuesta útil no es la severidad a secas sino la frase que la
 * acompaña. Una señal `esperado` merece decirse EN VOZ ALTA («esto que
 * parece malo es lo que compraste»): callarla dejaría al usuario leyendo el
 * titular alarmista sin el contexto que él mismo declaró.
 */
export function readingOf(
  axes: Axes | null,
  signal: Signal,
  layer: Layer | null,
  /** La frase literal donde la empresa atribuye el movimiento. `null` = la
   *  capa es inferencia del extractor. Decide si un mortal se puede AFIRMAR. */
  quote: string | null = null,
): { severity: Severity | null; note: string } {
  const sev = severityOf(axes, signal);
  if (sev === null || axes === null) {
    return {
      severity: null,
      note: "sin clasificar esta posición: no se puede leer si esto contradice tu tesis",
    };
  }

  if (sev === "confirma") {
    return {
      severity: sev,
      note: `${porQue(axes, signal)}: la tesis cumpliéndose donde importa — ${coreOf(axes)}`,
    };
  }
  if (sev === "esperado") {
    // Un "esperado" positivo con ciclo exógeno no es «esto que parece malo
    // es lo que compraste» sino su reverso: el ciclo sopla a favor y no se
    // puede apuntar a la tesis — el mismo agnosticismo que hace `vigilar`
    // a nucleo_desacelera en esa rama.
    if (POSITIVE_SIGNALS.has(signal)) {
      return {
        severity: sev,
        note: `${porQue(axes, signal)}: viento de cola del ciclo — no lo confundas con la tesis cumpliéndose`,
      };
    }
    return { severity: sev, note: `${porQue(axes, signal)}: es lo esperado, no una grieta` };
  }
  if (sev === "mortal") {
    // ── Gate de cita ─────────────────────────────────────────────────
    // Misma doctrina que los falsadores: un `occurred: true` sin cita se
    // degrada en código. "Golpea la tesis en su raíz" es el veredicto más
    // duro del panel y no puede descansar en una capa que el extractor
    // INFIRIÓ: sin la frase de la empresa se baja a vigilar y se dice por
    // qué. El tipo `Attribution` prometía este marcado desde el día uno
    // ("una atribución sin cita se acepta, pero se marca") y nadie lo
    // implementó — los dos "mortal" de MSFT del 29-07 tenían quote: null.
    if (!quote) {
      return {
        severity: "vigilar",
        note:
          `${porQue(axes, signal)}: apuntaría a la raíz de la tesis, pero la atribución es una ` +
          `lectura del extractor, no una declaración de la empresa — sin esa frase no se afirma. ` +
          `Compruébalo en el comunicado antes de actuar${marcoDesfasado(axes, signal, layer)}`,
      };
    }
    return {
      severity: sev,
      note: `${porQue(axes, signal)}: golpea la tesis en su raíz — ${coreOf(axes)}${marcoDesfasado(axes, signal, layer)}`,
    };
  }
  // El caso intermedio es donde la CAPA manda: la misma señal pesa distinto
  // si golpeó el negocio principal o si es un cargo que no se repite.
  if (layer === "nucleo") {
    return {
      severity: sev,
      note: `${porQue(axes, signal)}: cae en el negocio principal, que es donde sí importa`,
    };
  }
  if (layer === "no_recurrente") {
    return {
      severity: sev,
      note: "es un cargo que no se repite: no dice nada del negocio",
    };
  }
  return { severity: sev, note: `${porQue(axes, signal)}: conviene seguirlo, sin ser concluyente` };
}

/**
 * La pregunta que un umbral no sabe hacer: ¿y si lo desfasado es el MARCO?
 *
 * Un capex disparado que la empresa atribuye a inversión deliberada, en una
 * posición declarada como "capex bajo", admite dos lecturas y el coach no
 * puede elegir por ti: o la empresa ha dejado de ser lo que compraste (la
 * tesis está golpeada) o sigue siéndolo y es tu CLASIFICACIÓN la que se
 * quedó vieja (caso MSFT 2026: declarada compounder de capex bajo mientras
 * invierte 35,8B$/trimestre en IA con el mercado revalorándola). Afirmar lo
 * primero sin plantear lo segundo convertía una casilla desactualizada en
 * una recomendación de venta.
 */
function marcoDesfasado(a: Axes, signal: Signal, layer: Layer | null): string {
  if (signal === "capex_disparado" && a.capital === "bajo" && layer === "inversion") {
    return (
      ". Y una pregunta antes de actuar: si esta inversión es deliberada y va a sostenerse, " +
      "lo desfasado puede ser tu MARCO (declaraste capex bajo), no la empresa — " +
      "reclasifícala como capital intensivo o acepta esta lectura, pero decide tú cuál de las dos"
    );
  }
  return "";
}

/** Qué EJE concreto está mandando en esta lectura. Sin esto, el panel dice
 *  "esperado" y el usuario no sabe por cuál de las tres cosas que declaró
 *  — que es justo lo que hay que poder discutirle al coach. */
function porQue(a: Axes, signal: Signal): string {
  switch (signal) {
    case "capex_disparado":
      return a.capital === "alto"
        ? "en un negocio capital intensivo"
        : `en una empresa que ${AXIS_LABEL.madurez[a.madurez]} sin capex pesado`;
    case "margen_comprimido":
      return a.capital === "alto"
        ? "en un negocio capital intensivo"
        : `en una empresa que ${AXIS_LABEL.madurez[a.madurez]}`;
    case "nucleo_desacelera":
    case "guidance_recortada":
    case "nucleo_acelera":
    case "margen_expandido":
    // Reafirmar sí puede leerse por el ciclo, al revés que ELEVAR:
    // mantener la vara con la macro en contra es una decisión sobre el
    // entorno, no sólo sobre la empresa.
    case "guidance_reiterada":
      return a.ciclo === "exogeno"
        ? "con un ciclo que la empresa no controla"
        : `en una empresa que ${AXIS_LABEL.madurez[a.madurez]}`;
    case "guidance_elevada":
      // Aunque el ciclo sea exógeno, elevar guidance es la dirección
      // comprometiéndose con el futuro — el eje que manda es la madurez.
      return `en una empresa que ${AXIS_LABEL.madurez[a.madurez]}`;
    default:
      return `en una empresa que ${AXIS_LABEL.madurez[a.madurez]}`;
  }
}

// ─── Atribución ──────────────────────────────────────────────────────────

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

/**
 * Un movimiento de los números, con la capa a la que la EMPRESA lo atribuye.
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
  /** Frase literal donde la empresa lo atribuye. `null` si el comunicado no
   *  lo atribuye: entonces la capa es inferencia. */
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
 * modelo entraría en `severityOf` y produciría una alarma sobre algo que
 * nadie definió.
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
