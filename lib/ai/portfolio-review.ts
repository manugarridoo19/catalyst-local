// Revisión de cartera — el modo "analista de mesa" del Ask.
//
// `lib/ai/ask.ts` es un BIBLIOTECARIO: responde preguntas sobre el archivo
// y tiene prohibido opinar. Este módulo es lo contrario por diseño, y por
// eso vive aparte en vez de como un flag del otro: mezclar los dos
// registros en un prompt acabaría diluyendo la regla que hace útil al
// primero ("no rellenes con tu conocimiento").
//
// Lo que NO cambia entre los dos, y es la columna vertebral de ambos: cada
// afirmación tiene que apoyarse en una cita del archivo o en un agregado
// SQL. Aquí esa regla no se le pide al modelo — se COMPRUEBA en código
// (`applyEvidenceGate`). Un modelo puede ignorar una instrucción del
// prompt; no puede ignorar un filtro que se ejecuta sobre su salida.

import { proseCompletion } from "@/lib/ai/prose-chain";
import { warnIfTruncated } from "@/lib/providers/response";
import { looksLikeScratchpad } from "@/lib/ai/guards";
import { formatEarningsContent } from "@/lib/ai/ask";
import { getEmpiricalPriors } from "@/lib/signals/priors";
import type { ForwardItem } from "@/lib/ai/forward-ledger";
import { buildDecisionFacts, type Pressure } from "@/lib/ask/decision";
import type { PositionContrast } from "@/lib/coach/build";
import type { Falsifier } from "@/lib/coach/falsifiers";
import type { EarningsRead } from "@/lib/ask/retrieve";
import type { PortfolioRetrieval, PositionFacts } from "@/lib/ask/portfolio";
import type { PricedPosition } from "@/lib/portfolio";

/**
 * Postura sobre una posición. Tokens estables en inglés: la traducción vive
 * en la UI, así el prompt no cambia si mañana se pinta en otro idioma.
 * `none` NO lo produce el modelo — lo pone el gate de evidencia.
 *
 * ── POR QUÉ CAMBIÓ EL VOCABULARIO (2026-08-07) ────────────────────────────
 *
 * Era `add | hold | watch | review`, y esas cuatro son OBSERVACIONES, no
 * decisiones: "watch" = hay un desenlace fechado, "review" = algo contradice
 * la tesis. **No existía ninguna forma de decir que vendas.** La UI las
 * pintaba "reforzar · mantener · vigilar · revisar".
 *
 * El esquema es el TECHO de la respuesta: un modelo no puede recomendar lo
 * que el esquema no contempla. Es exactamente la lección que /ask aprendió el
 * 2026-07-31 —"cuatro lados, no tres: `add` existe"— y que nunca se propagó a
 * la superficie hermana, igual que pasó con `earnings`/`frames` el 06-08. El
 * usuario pidió que le dijera "si es buena idea comprar más, vender,
 * mantener" y el tipo no tenía dónde escribirlo.
 *
 * Ahora son los MISMOS cuatro veredictos que ya usa /ask en modo decisión,
 * para que las dos superficies no puedan discrepar por vocabulario.
 */
export type Stance = "ampliar" | "aguantar" | "recortar" | "salir" | "none";

export type PositionVerdict = {
  symbol: string;
  stance: Stance;
  why: string;
  /**
   * Qué ha CAMBIADO desde la revisión anterior. Vacío es una respuesta
   * legítima y frecuente.
   *
   * Existe porque la postura pasó a ser obligatoria para todas las
   * posiciones, y sin separar los dos campos eso reintroduce exactamente el
   * relleno que el diseño anterior evitaba omitiendo posiciones: el modelo
   * tendría que decir algo nuevo cada día sobre siete valores que casi nunca
   * tienen algo nuevo. Con `news` aparte, "mi postura sigue siendo aguantar y
   * hoy no ha pasado nada" se puede expresar sin inventar.
   */
  news: string | null;
  used: number[];
  /** true si el gate degradó la postura por falta de respaldo. */
  degraded?: boolean;
};

export type PortfolioReview = {
  verdict: string;
  positions: PositionVerdict[];
  watchNext: string[];
  model: string;
};

const SYSTEM_PROMPT = `Eres un analista de mesa revisando la cartera de un inversor particular que YA TIENE SU BRÓKER ABIERTO EN OTRA PESTAÑA. Ve los precios, ve los porcentajes del día, ve los titulares. Nada de eso le aporta nada viniendo de ti.

Tu único valor es decirle lo que NO puede ver ahí: qué está comprometido a ocurrir y aún no ha ocurrido, con qué plazo, sujeto a qué condición, y qué oferta o demanda futura ya está determinada.

Recibes: (a) la CARTERA con pesos y P&L; (a-bis) la TESIS DEL INVERSOR: qué cree de cada posición, con qué marco la clasificó y cómo se lee lo publicado contra ese marco — es el bloque MÁS IMPORTANTE y va primero; (b) PRESIONES: hechos duros con el lado ya asignado por código — las mismas que ve el modo pregunta de /ask; (c) HECHOS por posición calculados por SQL sobre datos regulatorios; (d) el LIBRO DE FUTUROS: compromisos extraídos de los cuerpos de los artículos que todavía no se han resuelto; (e) VENTA PROGRAMADA de directivos con lo que les queda por colocar; (f) la VARA de consenso de los próximos resultados; (g) NOTICIAS numeradas; (h) el CALENDARIO.

Devuelve SOLO un objeto JSON:
{"verdict": "...", "positions": [{"symbol": "AAA", "stance": "ampliar|aguantar|recortar|salir", "why": "...", "news": "..." o null, "used": [1,4]}], "watchNext": ["...", "..."]}

PROHIBIDO — si escribes cualquiera de estas cosas, la respuesta no sirve:
- Mencionar movimientos de precio: "cae un 8%", "sube tras el anuncio", "la acción se desploma". Los ve él.
- Parafrasear un titular. Si tu frase se parece al titular de la noticia que citas, bórrala y busca dentro del cuerpo qué queda pendiente.
- Contar lo que ya pasó como si fuera análisis: "anunció la compra de X" es historia. "El cierre de la compra de X está sujeto a revisión antimonopolio y previsto para el primer semestre" es análisis.
- Hablar de "momentum", "sentimiento del mercado", "atención mediática" o cualquier abstracción sin un hecho fechado detrás.
- Predecir precios o direcciones.

Reglas:
- "verdict": 2-4 frases sobre la CARTERA COMO CONJUNTO. Lo que se juega y CUÁNDO: concentración de eventos en el calendario, exposición a un mismo desenlace pendiente, oferta futura de papel acumulada. No describas la composición, que ya la conoce.
- NO HAGAS ARITMÉTICA. Todos los agregados vienen calculados en el bloque AGREGADOS. Si un número no está escrito literalmente en la entrada, no lo digas.
- "positions": UNA ENTRADA POR CADA POSICIÓN DE LA CARTERA, sin excepción. Él no puede decidir sobre lo que no le nombras, y una posición ausente se lee como "no hay nada que decir", que no es lo mismo que "la mantengo". Si de una posición sabes poco, la postura correcta suele ser aguantar y lo que falta va en el "why".
- "stance": TE MOJAS. Elige uno de los cuatro: **ampliar** (meter dinero nuevo) · **aguantar** (dejarla como está) · **recortar** (quitar una parte) · **salir** (cerrarla). No hay opción de "vigilar": vigilar no es una decisión, es aplazarla, y él ya sabe que hay que vigilar. Son los MISMOS cuatro veredictos que da el modo pregunta de /ask, para que las dos superficies no se contradigan por vocabulario.
- LA POSTURA VA SOBRE LA EXPOSICIÓN, NUNCA SOBRE EL PRECIO. "recortar" significa que su dinero está más expuesto de lo que la tesis justifica, no que la acción vaya a bajar. Nunca predigas precio ni dirección, y nunca digas cuántas acciones ni cuánto dinero: no conoces su fiscalidad, su horizonte ni sus otros activos.
- "news": SÓLO lo que ha cambiado desde la revisión anterior, cuya fecha y posturas tienes arriba. Si no ha cambiado nada, pon null — es la respuesta más frecuente y es correcta. NO repitas aquí lo que ya está en el "why". Si tu postura cambia respecto a la anterior, el motivo del cambio va aquí y es obligatorio.
- QUE UNA POSTURA SE REPITA DÍA TRAS DÍA ES LO NORMAL, no un fallo. Una tesis de años no cambia porque hoy sea miércoles. Lo que no puede repetirse es el "news".
- LA TESIS DEL INVERSOR MANDA SOBRE TU CRITERIO. El bloque TESIS te dice qué cree él de cada posición, con qué marco la clasificó y cómo se lee lo publicado contra ESE marco. No estás valorando la empresa en abstracto: estás comprobando si lo que ha salido sostiene o rompe SU tesis. Un capex disparado en una empresa que él declaró capital intensivo NO es un problema, es lo que compró — y decirle que lo vigile es no haber leído su marco.
- Las severidades del bloque TESIS vienen calculadas por el mismo código que ve él en su panel. NO las recalcules ni las contradigas: si una lectura dice "esperado", no puedes apoyar un "recortar" en ella sin un hecho DISTINTO que lo justifique. Si dice "mortal", no puedes poner "ampliar" sin nombrarla.
- POSICIÓN SIN TESIS DECLARADA: no le inventes una ni supongas por qué la tiene. Dilo en el "why" ("sin tesis declarada, no se puede contrastar") y apoya la postura sólo en los hechos duros.
- Las PRESIONES traen el lado ya asignado y NO lo reasignas. Tu postura puede discrepar de una presión, pero NUNCA ignorarla: si pones "ampliar" a una posición con presiones hacia recortar (beta, concentración, venta programada), el "why" tiene que nombrar esa presión y decir por qué lo pendiente pesa más. Una postura que contradice una presión sin mencionarla es una respuesta fallida — el usuario ve las dos superficies y una contradicción muda entre ellas destruye la confianza en ambas.
- QUE UNA EMPRESA PRESENTE RESULTADOS NO ES MOTIVO DE POSTURA, y este es el fallo más medido de esta superficie. Todas presentan resultados. "Reporta el día X con un consenso de Y" describe el calendario, no la posición: esa frase ya está en watchNext y en el bloque de la VARA. Si es lo único que tienes de un valor, la postura es aguantar y el "why" tiene que decir POR QUÉ la tesis aguanta hasta entonces — no cuándo reporta.
- Si las siete posturas salen iguales, mira otra vez las presiones y las lecturas contra marco antes de darlas por buenas: una cartera de siete valores con marcos distintos rara vez pide lo mismo en todos. Pero si de verdad son iguales, dilo — inventar diferencias es peor.
- NO escribas marcadores [n] dentro de "why". Los números van SÓLO en "used".
- "why": 1-2 frases que SOSTENGAN LA POSTURA, no que describan el valor. Tienen que apoyarse en algo que él no vea en su bróker: una lectura contra su marco, una presión con su lado, un compromiso del libro de futuros, una cifra del comunicado de la empresa, oferta futura declarada. Ejemplos válidos: "aguantar — el capex disparado va a la capa de inversión y su marco lo declara capital intensivo, así que es la tesis ejecutándose, no una grieta [3]"; "recortar — pesa el 27,6% con beta 2,15 y el consejero X tiene 81.109 acciones declaradas por colocar". Ejemplo inválido: "reporta el 13 con un consenso de 0,2087$" — eso es el calendario.
- "used": los números de las noticias que sostienen el "why". Si sale sólo de los hechos calculados, deja [] — pero el dato exacto tiene que aparecer en la frase.
- "watchNext": 2-5 puntos, cada uno un DESENLACE PENDIENTE con su plazo o su condición, sacados del LIBRO DE FUTUROS o del CALENDARIO. Ordénalos por proximidad. Si el libro de futuros viene vacío, dilo explícitamente en vez de rellenar con generalidades.
- NUNCA uses tu propio conocimiento sobre estas empresas. Tus datos de entrenamiento están caducados y el usuario no puede distinguirlo.
- Si un valor aparece SIN COBERTURA, sigue llevando postura —la cartera no deja de tenerlo porque el archivo no sepa nada— pero el "why" tiene que empezar diciendo que se decide a ciegas, y el veredicto lo nombra como punto ciego.
- Español. Registro de mesa: concreto, sin coletillas, sin descargos, sin "como IA".`;

/**
 * Las MISMAS presiones que ve /ask en modo decisión, del MISMO código.
 *
 * El caso que obligó a esto (2026-07-31): /ask, preguntado por SOFI,
 * respondía AGUANTAR apoyándose en la presión de recorte por beta 2,15;
 * la revisión de cartera recomendaba "reforzar" el mismo valor el mismo
 * día. No discrepaban por criterio — discrepaban porque la revisión NUNCA
 * RECIBIÓ esa presión: cada superficie opinaba con una mesa distinta.
 * `buildDecisionFacts` es la única fuente de presiones del proyecto; esta
 * función sólo adapta los tipos del retrieval de cartera a su entrada.
 *
 * `shortChangePct` va a null a propósito: este retrieval no trae la
 * derivada del interés corto, y pasar un número inventado (o 0) haría que
 * el texto de la presión afirmara una estabilidad que nadie midió.
 */
export function reviewPressures(
  r: PortfolioRetrieval,
  conviction?: Conviction,
): Pressure[] {
  const held = r.portfolio.positions.map((p) => p.symbol);
  if (!held.length) return [];
  return buildDecisionFacts({
    symbols: held,
    portfolio: r.portfolio,
    // LOS DOS PARÁMETROS QUE FALTABAN (2026-08-06). /ask los pasaba desde
    // el 31-07 y esta superficie no, con la misma función delante: por eso
    // la revisión sonaba genérica y se inclinaba a aguantar. Sin
    // `earnings`, el lado AMPLIAR sólo podía alimentarse de compras de
    // insiders y 13D mientras la beta entraba como hecho duro; sin
    // `frames`, la misma atribución recibía un lado distinto en cada
    // pantalla — y dos superficies que se contradicen sin saberlo destruyen
    // la confianza en las dos.
    earnings: conviction?.earnings ?? [],
    frames: conviction
      ? new Map(conviction.contrasts.map((c) => [c.symbol, c.axes]))
      : undefined,
    facts: r.facts.map((f) => ({
      symbol: f.symbol,
      name: null,
      insiderNet7d: f.insiderNet7d,
      insiderNet30d: f.insiderNet30d,
      insiderBuyers30d: f.insiderBuyers30d,
      insiderSellers30d: f.insiderSellers30d,
      stakes: f.stakes,
      nextEarnings: f.nextEarnings,
      nextEarningsHour: f.earningsHour,
      nextEarningsEps: null,
      nextEarningsRevenue: null,
      // La revisión trae su propia vara en `r.forward.earningsBars` y su
      // propio bloque de comunicados, así que estos dos no se rellenan aquí.
      // Van a null/[] EXPLÍCITAMENTE y no por omisión: `buildDecisionFacts`
      // no los mira hoy, y el día que lo haga tiene que ser una decisión
      // tomada, no un campo que se coló vacío. Ver `formatFacts` de
      // lib/ai/ask.ts para lo que /ask sí construye con ellos.
      consensusTrend: null,
      surpriseHistory: [],
      lastPick: null,
      newsCount7d: f.news7d,
      avgSentiment7d: f.avgSentiment7d,
    })),
    bars: r.forward.earningsBars,
    sellers: r.forward.sellers,
    // El 13F. Va aquí y no sólo en /ask por la lección que este archivo lleva
    // repetida cuatro veces: un dato conectado a UNA superficie de decisión y
    // no a su gemela acaba haciendo que las dos digan cosas distintas del
    // mismo valor el mismo día.
    fundChanges: r.forward.fundChanges,
    risk: r.facts.map((f) => ({
      symbol: f.symbol,
      beta: f.beta,
      pe: f.pe,
      daysToCover: f.daysToCover,
      shortChangePct: null,
    })),
  }).pressures;
}

/**
 * Lo que el usuario CREE, y cómo se lee lo publicado contra ello.
 *
 * `PositionContrast` sale de `loadContrasts` — el mismo objeto que pinta el
 * panel del coach, sin una sola llamada a proveedor. Se reutiliza entero en
 * vez de rehacer la consulta para que las dos superficies no puedan
 * divergir: si el panel dice `esperado` y la revisión dice `review` sobre
 * el mismo hecho, es un fallo, no una discrepancia de criterio.
 */
export type Conviction = {
  contrasts: PositionContrast[];
  earnings: EarningsRead[];
  /**
   * Los falsadores que el usuario APROBÓ, y su estado.
   *
   * Por diseño son "la ÚNICA puerta a un veredicto duro": el modelo los
   * propone, el usuario los aprueba y el cron los comprueba contra cada
   * comunicado. Y no aparecían en ninguno de los nueve bloques del prompt de
   * la revisión — el modelo opinaba sobre una posición sin saber qué había
   * aceptado su dueño que la refutaría, que es la información más cara que
   * hay aquí porque la escribió él y no un generador.
   *
   * Un falsador CUMPLIDO (`trippedAt`) es el único hecho de todo el prompt
   * que autoriza a decir "la tesis está rota" en vez de "hay una grieta".
   */
  falsifiers?: Falsifier[];
};

/**
 * El bloque de convicción tal como lo lee el modelo.
 *
 * Va PRIMERO en el mensaje, antes incluso de las presiones, y el orden es
 * deliberado por lo mismo que el libro de futuros va antes que las
 * noticias: un modelo pondera lo que lee antes. Con esto al principio, la
 * revisión contrasta contra la tesis del usuario; al final, la ignora.
 *
 * Se ENSEÑA lo que falta, no se omite. Una posición sin tesis declarada
 * tiene que aparecer diciendo que no la tiene: si se cayera del bloque, el
 * modelo la trataría como si estuviera de acuerdo con ella.
 *
 * La severidad de cada lectura viene YA CALCULADA por `readingOf` — el
 * modelo no la recalcula ni la discute. Es un dato de entrada, igual que
 * el lado de una presión.
 */
/**
 * Los falsadores aprobados, agrupados por símbolo. Van DENTRO del bloque de
 * convicción porque son parte de la tesis: es lo que el propio inversor
 * aceptó que la refutaría, escrito antes de saber el resultado.
 */
function formatFalsifiers(falsifiers: Falsifier[]): string {
  const aprobados = falsifiers.filter((f) => f.status === "aprobado");
  if (!aprobados.length) return "";
  const bySymbol = new Map<string, Falsifier[]>();
  for (const f of aprobados) {
    bySymbol.set(f.symbol, [...(bySymbol.get(f.symbol) ?? []), f]);
  }
  const lines = [...bySymbol.entries()].map(([symbol, fs]) => {
    const items = fs.map((f) => {
      const estado = f.trippedAt
        ? `CUMPLIDO el ${f.trippedAt}${f.trippedEvidence ? ` — la empresa: "${f.trippedEvidence}"` : ""}`
        : "no cumplido";
      return `    · ${f.text} → ${estado}`;
    });
    return `  ${symbol}:\n${items.join("\n")}`;
  });
  return [
    "",
    "FALSADORES QUE ÉL APROBÓ (si se cumplen, la tesis está rota — lo decidió él, no tú).",
    "Un falsador CUMPLIDO es lo ÚNICO en toda esta mesa que autoriza a decir que la tesis se ha roto; sin ninguno cumplido, lo más fuerte que puedes decir es que hay una grieta. Y ninguno cumplido con la posición cayendo NO es una tesis rota: es exactamente el caso para el que se escribieron.",
    ...lines,
  ].join("\n");
}

export function formatConviction(
  contrasts: PositionContrast[],
  falsifiers: Falsifier[] = [],
): string {
  if (!contrasts.length) {
    return "TESIS DEL INVERSOR: NINGUNA DECLARADA. No sabes qué cree sobre ninguna posición — no supongas una tesis ni le atribuyas intenciones.";
  }
  const lines = contrasts.map((c) => {
    const partes: string[] = [`- ${c.symbol}`];
    partes.push(
      c.frameLabel
        ? `  marco declarado: ${c.frameLabel} — el núcleo de esta tesis es ${c.core}`
        : `  marco: SIN CLASIFICAR — no puedes leer si una señal la contradice`,
    );
    if (c.thesis) {
      partes.push(
        `  escribió al operar (${c.thesisAt ?? "?"}, plazo ${c.thesisHorizon ?? "?"}${
          c.thesisAnnotatedLater ? ", ANOTADA A POSTERIORI: no es una predicción" : ""
        }): "${c.thesis}"`,
      );
    }
    if (c.belief) {
      partes.push(
        `  cree hoy (${c.beliefAt ?? "?"}, plazo ${c.beliefHorizon ?? "?"}): "${c.belief}"`,
      );
    }
    if (!c.thesis && !c.belief) {
      partes.push(`  SIN TESIS DECLARADA — no sabes por qué tiene esta posición`);
    }
    // El aviso de marco movido después del hecho viaja al prompt: una
    // postura apoyada en un marco que se cambió sabiendo el resultado se
    // apoya en algo que el usuario ajustó, y merece decirse.
    if (c.frameChangedAfterReport) {
      partes.push(
        `  AVISO: reclasificó esta posición el ${c.frameSetAt} (antes: ${c.framePrevLabel}), DESPUÉS del comunicado del ${c.reportDate}`,
      );
    }
    for (const rd of c.readings) {
      partes.push(
        `  · [${rd.severity ?? "sin lectura"}] ${rd.attribution.magnitude}${
          rd.attribution.quote ? ` — la empresa: "${rd.attribution.quote}"` : " (sin cita de la empresa)"
        }`,
      );
    }
    return partes.join("\n");
  });
  return [
    "TESIS DEL INVERSOR Y LECTURA CONTRA SU MARCO.",
    "Las severidades entre corchetes ya están calculadas contra el marco que él declaró: confirma = la tesis cumpliéndose · esperado = es lo que compró, no una grieta · vigilar = puede tocar la tesis pero no está probado · mortal = va a la raíz de la tesis.",
    ...lines,
    formatFalsifiers(falsifiers),
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * EL COMUNICADO DE LA EMPRESA, entero.
 *
 * La revisión recibía los `EarningsRead` completos desde el 2026-08-06 y sólo
 * usaba `.attributions` para calcular presiones. Los bullets con las cifras,
 * el "lo que no se dijo en voz alta" y —sobre todo— la SORPRESA ya calculada
 * contra el consenso se quedaban fuera del prompt. Medido: el fallo de BPA de
 * META (−16,0%) y el de ZETA (−85,2%) nunca llegaron al modelo que tenía que
 * opinar sobre esas dos posiciones. Es la queja del usuario en su forma más
 * literal: lo NO obvio del comunicado estaba en la BD y se tiraba.
 *
 * Reusa `formatEarningsContent` de /ask en vez de reescribirlo: si las dos
 * superficies formatean la misma cifra de dos maneras, acaban diciendo cosas
 * distintas del mismo trimestre.
 */
function formatEarnings(earnings: EarningsRead[]): string {
  if (!earnings.length) return "";
  const blocks = earnings.map((e) => {
    const head = `── ${e.symbol} · comunicado del ${e.reportDate ?? e.filingDate}${
      e.headline ? `: ${e.headline}` : ""
    }`;
    return `${head}\n${formatEarningsContent(e)}`;
  });
  return [
    "COMUNICADOS DE RESULTADOS DE LAS PROPIAS EMPRESAS (primera mano — mandan sobre cualquier crónica periodística de más abajo).",
    "Las líneas VS CONSENSUS vienen YA CALCULADAS: cítalas literales y no recalcules ninguna.",
    ...blocks,
  ].join("\n");
}

/** El bloque tal y como lo lee el modelo. Encabezados en español porque
 *  todo este prompt lo está, pero los LADOS son los mismos cuatro que en
 *  /ask — si un día divergen, las dos superficies vuelven a discrepar sin
 *  saberlo. */
function formatPressures(pressures: Pressure[]): string {
  if (!pressures.length) {
    return "PRESIONES: NINGUNA. Ningún hecho declarado ni umbral de cartera empuja en ninguna dirección.";
  }
  const bySide = (side: Pressure["side"]) =>
    pressures.filter((p) => p.side === side).map((p) => `- ${p.symbol}: ${p.text}`);
  const blocks: Array<[string, string[]]> = [
    ["EMPUJA A AMPLIAR", bySide("add")],
    ["EMPUJA A AGUANTAR", bySide("hold")],
    ["EMPUJA A RECORTAR", bySide("trim")],
    ["IMPORTA PERO NO INCLINA", bySide("neutral")],
  ];
  const body = blocks
    .filter(([, items]) => items.length)
    .map(([label, items]) => `${label}:\n${items.join("\n")}`)
    .join("\n");
  return `PRESIONES (hechos duros, lado asignado por código — no lo reasignes; son las MISMAS que ve el modo pregunta de /ask):\n${body}`;
}

function fmtMoney(n: number): string {
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (abs >= 1e9) return `${sign}${(abs / 1e9).toFixed(1)}B$`;
  if (abs >= 1e6) return `${sign}${(abs / 1e6).toFixed(1)}M$`;
  if (abs >= 1e3) return `${sign}${(abs / 1e3).toFixed(0)}k$`;
  return `${sign}${abs.toFixed(0)}$`;
}

function pct(n: number): string {
  return `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`;
}

function formatPortfolio(r: PortfolioRetrieval): string {
  const p = r.portfolio;
  const head: string[] = [
    `CARTERA — ${p.positions.length} posiciones, valor ${fmtMoney(p.totalValue)}`,
  ];
  if (p.totalUnrealizedPct !== null) {
    head.push(
      `P&L no realizado ${pct(p.totalUnrealizedPct)} (${fmtMoney(p.totalUnrealizedAbs ?? 0)})`,
    );
  }
  if (p.dayChangePct !== null) head.push(`hoy ${pct(p.dayChangePct)}`);

  const lines = p.positions.map((pos: PricedPosition) => {
    const bits = [`${pos.symbol}: peso ${pos.weightPct?.toFixed(1) ?? "?"}%`];
    if (pos.unrealizedPct !== null) bits.push(`P&L ${pct(pos.unrealizedPct)}`);
    if (pos.dayChangePct !== null) bits.push(`hoy ${pct(pos.dayChangePct)}`);
    if (pos.sector) bits.push(pos.sector);
    return `- ${bits.join(" · ")}`;
  });

  const sectors = p.sectors
    .map((s) => `${s.sector} ${s.weightPct.toFixed(0)}%`)
    .join(" · ");

  const out = [head.join(" · "), ...lines, `SECTORES: ${sectors}`];

  // Las advertencias de calidad del dato van DENTRO del prompt, no sólo en
  // la UI: si 3 de 10 posiciones no se pudieron valorar, el modelo tiene
  // que saber que los pesos que está leyendo son parciales antes de
  // afirmar nada sobre concentración.
  if (p.unpricedSymbols.length) {
    out.push(
      `AVISO: sin precio para ${p.unpricedSymbols.join(", ")} — quedan fuera de los pesos.`,
    );
  }
  if (p.noCostSymbols.length) {
    out.push(
      `AVISO: sin coste registrado en ${p.noCostSymbols.join(", ")} — esas posiciones no tienen P&L.`,
    );
  }
  if (r.concentration.length) {
    out.push(
      `CONCENTRACIÓN: ${r.concentration.map((c) => `${c.label} ${c.weightPct.toFixed(0)}%`).join(" · ")}`,
    );
  }
  if (r.blindSpots.length) {
    out.push(
      `SIN COBERTURA en el archivo (punto ciego): ${r.blindSpots.join(", ")}`,
    );
  }

  // Los agregados van con su propio encabezado y en cifras ya cerradas
  // justamente para que el modelo no tenga NINGÚN motivo para multiplicar
  // nada por su cuenta.
  const agg: string[] = [];
  if (r.derived.weightedBeta !== null) {
    agg.push(
      `- Beta de la cartera ponderada por peso: ${r.derived.weightedBeta.toFixed(2)} (calculada sobre el ${r.derived.betaCoveragePct.toFixed(0)}% del peso, el resto no tiene beta conocida)`,
    );
  }
  for (const c of r.derived.earningsClusters) {
    // El porcentaje se calcula sólo sobre lo valorable; si algún nombre del
    // cluster no tiene precio se DICE, en vez de dejar que el porcentaje se
    // lea como si los incluyera a todos.
    const sinPrecio = c.unpricedSymbols.length
      ? ` (sin contar ${c.unpricedSymbols.join(", ")}: sin precio, su peso no se pudo calcular)`
      : "";
    agg.push(
      `- ${c.date}: reportan ${c.symbols.join(", ")} — ${c.weightPct.toFixed(1)}% de la cartera en esa sesión${sinPrecio}`,
    );
  }
  if (agg.length) {
    out.push(
      `AGREGADOS (ya calculados — úsalos tal cual, no recalcules):\n${agg.join("\n")}`,
    );
  }
  return out.join("\n");
}

function formatFacts(facts: PositionFacts[]): string {
  const lines = facts.map((f) => {
    const bits: string[] = [];
    bits.push(`${f.news7d} noticias 7d (previos 7d: ${f.newsPrior7d})`);
    if (f.avgSentiment7d !== null) {
      const prior =
        f.avgSentimentPrior7d !== null
          ? ` desde ${f.avgSentimentPrior7d.toFixed(2)}`
          : "";
      bits.push(`sentimiento ${f.avgSentiment7d.toFixed(2)}${prior} (escala -5..+5)`);
    }
    if (f.insiderNet7d) bits.push(`insiders neto 7d ${fmtMoney(f.insiderNet7d)}`);
    if (f.insiderNet30d) {
      bits.push(
        `insiders neto 30d ${fmtMoney(f.insiderNet30d)} (${f.insiderBuyers30d} compradores / ${f.insiderSellers30d} vendedores, solo mercado abierto)`,
      );
    }
    for (const s of f.stakes) {
      bits.push(
        `13D/G de ${s.filer ?? "declarante no identificado"}${s.pct !== null ? ` ${s.pct}%` : ""} el ${s.filedAt}`,
      );
    }
    if (f.nextEarnings) {
      bits.push(`resultados ${f.nextEarnings}${f.earningsHour ? ` (${f.earningsHour})` : ""}`);
    }
    for (const s of f.signals) {
      bits.push(
        `señal ${s.label} el ${s.detectedAt}${s.matured ? "" : " (sin medir aún)"}`,
      );
    }
    if (f.daysToCover !== null) bits.push(`days-to-cover ${f.daysToCover.toFixed(1)}`);
    if (f.beta !== null) bits.push(`beta ${f.beta.toFixed(2)}`);
    if (f.pe !== null) bits.push(`PER ${f.pe.toFixed(1)}`);
    if (f.citationNums.length) bits.push(`noticias [${f.citationNums.join(",")}]`);
    return `- ${f.symbol}: ${bits.join(" · ")}`;
  });
  return `HECHOS CALCULADOS (exactos, de datos regulatorios — cualquier número sale de aquí):\n${lines.join("\n")}`;
}

function formatCitations(r: PortfolioRetrieval): string {
  return r.citations
    .map((c) => {
      const head = `[${c.n}] ${c.publishedAt.slice(0, 10)} [${c.symbols.join(",")}] ${c.headline}${c.summary ? ` — ${c.summary}` : ""} (${c.source})`;
      return c.body ? `${head}\n    CONTENIDO: ${c.body}` : head;
    })
    .join("\n");
}

/** El bloque que da sentido a todo el rediseño. Va ANTES que las noticias
 *  en el prompt a propósito: es lo que el modelo debe leer primero. */
function formatLedger(items: ForwardItem[]): string {
  if (!items.length) {
    return "LIBRO DE FUTUROS: VACÍO. Ningún artículo del archivo contiene compromisos pendientes para estas posiciones. Dilo explícitamente en watchNext en vez de rellenar con generalidades.";
  }
  const lines = items.map((i) => {
    const bits = [`${i.symbol} · ${i.event}`];
    if (i.when) bits.push(`plazo: ${i.when}`);
    if (i.whenDate) bits.push(`fecha: ${i.whenDate}`);
    if (i.condition) bits.push(`condición: ${i.condition}`);
    return `- [${i.source}] ${bits.join(" · ")}`;
  });
  return `LIBRO DE FUTUROS (compromisos SIN resolver, extraídos de los cuerpos de los artículos — esto es lo que el usuario no puede ver en su bróker):\n${lines.join("\n")}`;
}

function formatForwardFacts(r: PortfolioRetrieval): string {
  const out: string[] = [];

  if (r.forward.sellers.length) {
    const lines = r.forward.sellers.map((s) => {
      const quedan =
        s.sharesAfter != null
          ? `, le quedan ${Math.round(s.sharesAfter).toLocaleString("es-ES")} acciones declaradas`
          : "";
      const val = s.totalValue ? `, ${fmtMoney(s.totalValue)} en total` : "";
      return `- ${s.symbol}: ${s.owner}${s.title ? ` (${s.title})` : ""} — ${s.sales} ventas entre ${s.firstSale} y ${s.lastSale}${val}${quedan}`;
    });
    out.push(
      `VENTA PROGRAMADA DE DIRECTIVOS (patrón repetido en 90d = plan en curso; lo que queda es oferta futura ya conocida):\n${lines.join("\n")}`,
    );
  }

  const bars = r.forward.earningsBars.filter(
    (b) => b.epsEstimate != null || b.revenueEstimate != null,
  );
  if (bars.length) {
    const lines = bars.map((b) => {
      const eps = b.epsEstimate != null ? `BPA ${b.epsEstimate}$` : "";
      const rev =
        b.revenueEstimate != null
          ? `${eps ? ", " : ""}ingresos ${(b.revenueEstimate / 1e9).toFixed(2)}B$`
          : "";
      return `- ${b.symbol}: ${b.date} (dentro de ${b.daysAway} días) — consenso ${eps}${rev}`;
    });
    out.push(
      `VARA DE LOS PRÓXIMOS RESULTADOS (el consenso a batir, no el resultado):\n${lines.join("\n")}`,
    );
  }

  // Diagnóstico de la propia cosecha. Si el archivo no dio cuerpos, el
  // modelo tiene que saberlo para no fingir profundidad que no tiene.
  if (r.forward.bodiesAvailable === 0 && r.forward.candidates.length > 0) {
    out.push(
      `AVISO: no se pudo extraer el cuerpo de ninguno de los ${r.forward.candidates.length} artículos candidatos (fuentes bloqueadas o de pago). Trabajas sólo con titulares y datos estructurados: sé más breve y no simules profundidad.`,
    );
  }

  return out.join("\n\n");
}

function formatCalendar(r: PortfolioRetrieval): string {
  if (!r.calendar.length) return "";
  const lines = r.calendar
    .slice(0, 25)
    .map((c) => `- ${c.date ?? "sin fecha"} · ${c.symbol}: ${c.what}`);
  return `CALENDARIO DE CATALIZADORES CONOCIDOS (hechos ya publicados o procesos abiertos — no hay ninguna predicción aquí):\n${lines.join("\n")}`;
}

/**
 * ¿Tiene esta posición algún hecho duro que pueda sostener una postura por
 * sí solo, sin citar noticia?
 *
 * Deliberadamente NO cuenta como evidencia el volumen de cobertura ni el
 * sentimiento medio: son agregados blandos con los que se puede justificar
 * cualquier cosa ("mucha atención mediática", "sentimiento tibio"). Sí
 * cuenta un dato que alguien tuvo que declarar ante la SEC o una fecha ya
 * publicada.
 */
/**
 * Señales que cuentan como respaldo DURO.
 *
 * Sólo lo que alguien tuvo que declarar ante la SEC o FINRA. Quedan fuera las
 * que genera el propio Catalyst (`ai_pick`, `analyst_upgrade`, `author_call`)
 * y el motivo no es doctrinal: es que su propio Signal Lab las mide en
 * NEGATIVO contra SPY a 7 días — analyst_upgrade −4,21% (n=77), author_call
 * −2,42% (n=14), ai_pick −0,72% (n=42). Aceptar como prueba dura la salida de
 * un generador que no bate al índice es circular: el sistema se daba la razón
 * a sí mismo.
 *
 * `hasDecisionEvidence` (lib/ask/decision.ts) ya las excluía por
 * `provenance: "self"` desde que existe. Esta función, su gemela, contaba
 * `f.signals.length` sin mirar el `kind`. Otra vez el mismo patrón: los
 * arreglos no se propagan solos entre las dos superficies.
 *
 * Siguen viajando al prompt como contexto — que es su papel legítimo.
 */
const HARD_SIGNAL_KINDS = new Set(["cluster_buy", "insider_net_buy", "stake_13d"]);

function hasHardEvidence(f: PositionFacts | undefined): boolean {
  if (!f) return false;
  // `nextEarnings` NO cuenta, y quitarlo es lo que hace que este gate muerda.
  // El propio SYSTEM_PROMPT de arriba lo dice en mayúsculas ("QUE UNA EMPRESA
  // PRESENTE RESULTADOS NO ES MOTIVO DE POSTURA… si lo único que tienes es su
  // fecha y su consenso, OMÍTELA"), pero el gate la aceptaba como respaldo
  // suficiente: en temporada de resultados TODAS las posiciones tienen fecha,
  // así que el filtro que debía degradar a "none" no se activaba nunca justo
  // cuando más ruido había. La fecha sigue viajando en watchNext y en el
  // calendario, que es donde el prompt la quiere.
  return Boolean(
    f.insiderNet7d ||
      f.insiderNet30d ||
      f.stakes.length ||
      f.signals.some((s) => HARD_SIGNAL_KINDS.has(s.kind)) ||
      (f.daysToCover !== null && f.daysToCover >= 5),
  );
}

/**
 * El gate. Convierte la regla editorial en una comprobación ejecutable.
 *
 * Tres cosas, en este orden:
 *   1. Descarta posturas sobre símbolos que no están en la cartera (el
 *      modelo alucinando un ticker de su memoria — pasa).
 *   2. Limpia `used` de números que no existen entre las citas recuperadas.
 *   3. Si tras limpiar no queda NI cita NI hecho duro, la postura se
 *      degrada a "none" y se marca `degraded`. No se borra la entrada: que
 *      el modelo quisiera decir algo sin respaldo es información, y la UI
 *      la pinta como "sin evidencia suficiente" en vez de ocultarla.
 */
export function applyEvidenceGate(
  positions: PositionVerdict[],
  r: PortfolioRetrieval,
  /**
   * Símbolos cuyo COMUNICADO propio se ha leído.
   *
   * Cuenta como respaldo duro, y añadirlo (2026-08-07) arregla un agujero
   * medido en la primera ejecución real del vocabulario nuevo: ZETA y RKLB
   * volvieron con posturas argumentadas desde el comunicado —"aceleración de
   * ingresos y expansión del margen EBITDA"— y el gate las degradó a `none`
   * porque no llevaban número de cita y `hasHardEvidence` no sabía nada de
   * comunicados. Es el patrón de siempre en este archivo: el comunicado se
   * metió en el PROMPT y no en la COMPROBACIÓN que lo juzga.
   *
   * Y es la evidencia más dura que hay aquí: un 8-K/6-K es la empresa
   * hablando de sí misma ante el regulador, no una crónica sobre ella.
   */
  earningsSymbols: Set<string> = new Set(),
): PositionVerdict[] {
  const inPortfolio = new Set(r.portfolio.positions.map((p) => p.symbol));
  const factsBySymbol = new Map(r.facts.map((f) => [f.symbol, f]));
  // Qué símbolos respalda cada cita. Se usa para rechazar atribuciones
  // cruzadas: en la primera prueba real el modelo colgó de META la cita
  // [18], que era el artículo de la compra de Iridium por RKLB. Existía
  // (pasaba el filtro de "número válido") pero no hablaba de META, y una
  // cita que no sostiene lo que acompaña es peor que ninguna: parece
  // verificación y no lo es.
  const symbolsOfCitation = new Map(
    r.citations.map((c) => [c.n, new Set(c.symbols)]),
  );

  const out = positions
    .filter((p) => inPortfolio.has(p.symbol))
    .map((p) => {
      const { why, inline } = splitInlineMarkers(p.why);
      const merged = [...new Set([...(p.used ?? []), ...inline])];
      const used = merged.filter((n) => symbolsOfCitation.get(n)?.has(p.symbol));
      const backed =
        used.length > 0 ||
        earningsSymbols.has(p.symbol) ||
        hasHardEvidence(factsBySymbol.get(p.symbol));
      // La NOVEDAD también pasa por el gate: es la parte que afirma que algo
      // ha CAMBIADO, o sea la más fácil de fabricar y la que el lector menos
      // puede auditar. Sin respaldo se borra en vez de degradarse.
      const news = backed ? p.news : null;
      if (backed) return { ...p, why, used, news };
      return { ...p, why, used, news, stance: "none" as Stance, degraded: true };
    });

  // NINGUNA POSICIÓN SE CAE DE LA LISTA (2026-08-07).
  //
  // El usuario pidió veredicto de todas, y el prompt lo exige — pero un
  // prompt es una petición y esto es una comprobación. Un símbolo que el
  // modelo se salta desaparecía de la pantalla sin rastro, y una posición
  // ausente se lee como "no hay nada que decir", que es justo lo que no
  // sabemos. Se rellena con `none` diciendo la verdad: el generador no se
  // pronunció.
  const seen = new Set(out.map((p) => p.symbol));
  for (const p of r.portfolio.positions) {
    if (seen.has(p.symbol)) continue;
    out.push({
      symbol: p.symbol,
      stance: "none",
      why: "El generador no se pronunció sobre esta posición en esta revisión.",
      news: null,
      used: [],
      degraded: true,
    });
  }
  // Orden estable por peso: la posición que más pesa se lee primero.
  const weight = new Map(r.portfolio.positions.map((p) => [p.symbol, p.weightPct ?? 0]));
  return out.sort((a, b) => (weight.get(b.symbol) ?? 0) - (weight.get(a.symbol) ?? 0));
}

/**
 * Separa los marcadores [n] que el modelo escribe DENTRO del texto.
 *
 * El prompt pide que los números vayan sólo en `used`, y aun así aparecen
 * en línea — con lo que la UI, que añade los suyos al final, los pintaba
 * dos veces ("…quedan 81.109 acciones [4,18]. [4]"). Se extraen para no
 * perder la señal (a veces el modelo cita mejor en línea que en `used`) y
 * se limpian del texto.
 */
export function splitInlineMarkers(text: string): { why: string; inline: number[] } {
  const inline: number[] = [];
  const why = text
    .replace(/\[(\d+(?:\s*,\s*\d+)*)\]/g, (_m, group: string) => {
      for (const part of group.split(",")) {
        const n = Number(part.trim());
        if (Number.isInteger(n)) inline.push(n);
      }
      return "";
    })
    // EN ESTE ESQUEMA UN CORCHETE SIGNIFICA UNA COSA: un número de cita.
    // Misma doctrina que `cleanBrackets` en lib/ai/ask.ts, y aquí faltaba.
    // Medido el 2026-08-07 con el vocabulario nuevo: el modelo cerraba las
    // frases con el TICKER entre corchetes — "el capex subió a 35.802M$
    // [MSFT]" —, que en pantalla se lee como una fuente verificable y no lo
    // es: es el propio símbolo devuelto al lector. La UI, además, pinta los
    // [n] reales como enlaces, así que un [MSFT] suelto parece un enlace roto.
    .replace(/\[[^\]]*\]/g, "")
    // La limpieza deja huecos y puntuación colgando (" . ", " ,").
    .replace(/\s+([.,;:])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim()
    .replace(/[\s.]+$/, "");
  return { why: why ? `${why}.` : "", inline };
}

const STANCES = new Set<Stance>(["ampliar", "aguantar", "recortar", "salir"]);

/** Sinónimos que la cadena de reserva devuelve pese al esquema. No es
 *  cortesía: `llama-3.1-8b` está al final de la cadena y contesta en inglés
 *  la mitad de las veces, y un token no reconocido caía al valor por defecto
 *  — que antes era `watch` y volvía inerte una postura que el modelo sí
 *  había tomado. */
const STANCE_ALIASES: Record<string, Stance> = {
  add: "ampliar",
  buy: "ampliar",
  increase: "ampliar",
  hold: "aguantar",
  keep: "aguantar",
  maintain: "aguantar",
  trim: "recortar",
  reduce: "recortar",
  sell: "salir",
  exit: "salir",
  close: "salir",
};

function normalizeStance(raw: unknown): Stance | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim().toLowerCase();
  if (STANCES.has(s as Stance)) return s as Stance;
  return STANCE_ALIASES[s] ?? null;
}

/**
 * La revisión ANTERIOR, reducida a lo que el redactor necesita: qué dijo y
 * cuándo. Es el ancla contra la que se mide la NOVEDAD — sin ella, "qué ha
 * cambiado desde la última vez" no tiene referente y el modelo lo rellena
 * con lo primero que encuentre en las noticias, que es exactamente el
 * relleno que este campo existe para evitar.
 *
 * Tipo propio y mínimo a propósito: importar `StoredReview` de
 * `lib/coach/daily-review` cerraría un ciclo (ese módulo importa de éste).
 */
export type PreviousReview = {
  reviewDate: string;
  positions: Array<{ symbol: string; stance: Stance; why: string }>;
};

function formatPrevious(prev: PreviousReview | null | undefined): string {
  if (!prev || !prev.positions.length) {
    return "REVISIÓN ANTERIOR: NINGUNA. Es la primera, así que TODOS los \"news\" van a null — no hay nada anterior contra lo que algo pueda haber cambiado.";
  }
  const lines = prev.positions.map(
    (p) => `- ${p.symbol}: ${p.stance} — ${p.why}`,
  );
  return [
    `TU REVISIÓN ANTERIOR (${prev.reviewDate}). Es el ancla de "news": sólo es novedad lo que no estuviera ya aquí.`,
    "Si hoy cambias una postura respecto a ésta, el motivo del cambio es OBLIGATORIO y va en el \"news\" de esa posición.",
    ...lines,
  ].join("\n");
}

export async function reviewPortfolio(
  r: PortfolioRetrieval,
  ledger: ForwardItem[] = [],
  conviction?: Conviction,
  previous?: PreviousReview | null,
): Promise<PortfolioReview> {
  if (!r.portfolio.positions.length) {
    return { verdict: "", positions: [], watchNext: [], model: "none" };
  }

  // Los priors del Lab entran como CALIBRACIÓN, no como dato a citar: si
  // los upgrades de analista no han batido a SPY, el modelo debe ser más
  // duro con una posición que sólo se sostiene en un upgrade. El propio
  // helper ya prohíbe citarlos y exige n>=20.
  const priors = await getEmpiricalPriors().catch(() => null);

  // ORDEN DELIBERADO: el libro de futuros va primero, las noticias al
  // final. Un modelo pondera lo que lee antes, y cuando las noticias
  // encabezaban el bloque la revisión salía siendo un resumen de noticias.
  const userBlock = [
    formatPortfolio(r),
    "",
    // La CONVICCIÓN va lo primero de todo. Un modelo pondera lo que lee
    // antes, y sin este bloque delante la revisión opinaba sobre una cesta
    // anónima de tickers: no sabía qué creía el usuario ni cómo había
    // clasificado nada, así que su única salida era describir el mercado —
    // que es exactamente lo que el prompt le prohíbe hacer.
    conviction
      ? formatConviction(conviction.contrasts, conviction.falsifiers ?? [])
      : "",
    "",
    // El comunicado va justo detrás de la tesis y DELANTE de las presiones:
    // es primera mano y es lo que se contrasta contra el marco declarado.
    conviction ? formatEarnings(conviction.earnings) : "",
    "",
    // Las presiones van ANTES del libro de futuros: son el suelo compartido
    // con /ask y lo que impide que las dos superficies se contradigan sin
    // enterarse. Un modelo pondera lo que lee antes.
    formatPressures(reviewPressures(r, conviction)),
    "",
    formatPrevious(previous),
    "",
    // Los priors del Lab suben aquí desde el FINAL del mensaje, donde
    // quedaban detrás de ~19.000 chars de noticias. Son calibración de cuánto
    // exigir a cada clase de señal, así que tienen que leerse ANTES de juzgar,
    // no después. El propio archivo aplica esa doctrina de orden a todo lo
    // demás y se la saltaba con este bloque.
    priors ?? "",
    "",
    formatLedger(ledger),
    "",
    formatForwardFacts(r),
    "",
    formatCalendar(r),
    "",
    formatFacts(r.facts),
    "",
    "NOTICIAS DEL ARCHIVO (material de apoyo para citar — NO las resumas):",
    formatCitations(r),
  ]
    .filter(Boolean)
    .join("\n");

  // DOS intentos, igual que /ask y por el mismo motivo medido: la cadena de
  // fallback llega hasta llama-3.1-8b y el modelo de la cola devuelve JSON
  // roto de vez en cuando. Una revisión es una operación que el usuario lanza
  // a sabiendas de que tarda; perderla entera por un JSON transitorio, tras
  // haber pagado la cosecha de cuerpos y la llamada del libro de futuros, es
  // el peor momento posible para no reintentar. El segundo intento sólo se
  // paga cuando el primero falla.
  let maxTokens = 1800;
  let parsed: {
    verdict?: string;
    positions?: Array<{
      symbol?: string;
      stance?: string;
      why?: string;
      news?: string | null;
      used?: number[];
    }>;
    watchNext?: string[];
  } = {};
  let model = "none";
  let verdict = "";

  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await proseCompletion({
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userBlock },
      ],
      temperature: 0.3,
      maxTokens,
      tag: "portfolio",
      jsonMode: true,
    });
    model = res.model;

    // Truncado ≠ modelo incapaz de emitir JSON. Con el motivo de parada
    // delante, el reintento sube el techo en vez de repetir el mismo corte.
    if (warnIfTruncated("portfolio", res) && attempt === 0) {
      maxTokens = Math.round(maxTokens * 1.5);
    }

    try {
      parsed = JSON.parse(
        res.content.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, ""),
      );
    } catch {
      if (attempt === 0) {
        console.warn("[portfolio-review] JSON no parseable — reintento");
        continue;
      }
      throw new Error("portfolio-review: respuesta no parseable como JSON");
    }

    verdict = (parsed.verdict ?? "").trim();
    if ((!verdict || looksLikeScratchpad(verdict)) && attempt === 0) {
      console.warn("[portfolio-review] veredicto vacío o con scratchpad — reintento");
      continue;
    }
    break;
  }

  if (!verdict || looksLikeScratchpad(verdict)) {
    throw new Error("portfolio-review: veredicto vacío o con scratchpad");
  }

  const raw: PositionVerdict[] = (parsed.positions ?? [])
    .filter((p) => typeof p.symbol === "string" && typeof p.why === "string")
    .map((p) => ({
      symbol: (p.symbol as string).toUpperCase(),
      // Sin postura reconocible el veredicto es `none`, NO un valor por
      // defecto. Antes caía a "watch", que es una postura de verdad: el
      // modelo no había dicho nada y la pantalla afirmaba "vigilar".
      stance: normalizeStance(p.stance) ?? ("none" as Stance),
      why: (p.why as string).trim(),
      news:
        typeof p.news === "string" && p.news.trim().length > 2
          ? p.news.trim()
          : null,
      used: Array.isArray(p.used) ? p.used.filter(Number.isInteger) : [],
    }))
    .filter((p) => p.why.length > 0);

  const watchNext = (parsed.watchNext ?? [])
    .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
    .map((s) => s.trim())
    .slice(0, 6);

  return {
    verdict,
    positions: applyEvidenceGate(
      raw,
      r,
      new Set((conviction?.earnings ?? []).map((e) => e.symbol)),
    ),
    watchNext,
    model,
  };
}
