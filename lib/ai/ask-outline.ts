// El GUION de la respuesta: qué epígrafes contestan a ESTA pregunta.
//
// ─── Por qué existe ───────────────────────────────────────────────────────
//
// Hasta el 2026-08-12 la forma de una respuesta de /ask salía de una lista
// cerrada de cuatro plantillas y sus claves eran un enum fijo
// (`SECTION_KEYS`). Preguntando "por qué está cayendo mi cartera hoy, ve
// stock por stock" la respuesta llegó con LOS NÚMEROS / LECTURA DEL MERCADO /
// LO QUE CASI NADIE MENCIONA: los mismos epígrafes que para cualquier otra
// pregunta. La instrucción explícita del usuario sobre la FORMA de la
// respuesta —"ve stock por stock"— no tenía dónde aterrizar, porque la forma
// se decidía en código antes de leer la pregunta.
//
// ─── Por qué una llamada aparte y no una instrucción en el prompt ─────────
//
// Es la doctrina del propio proyecto, subida un nivel
// ([[feedback_llm_task_shape_over_prompt]]): cuando un modelo insiste en un
// comportamiento a pesar del prompt, se cambia la FORMA de la tarea. Pedirle
// "adapta las secciones a la pregunta" en el mismo mensaje donde tiene veinte
// artículos delante pierde contra el gradiente natural de resumir lo que ve.
// Con dos llamadas, la primera **no tiene el material delante**: sólo la
// pregunta y un INVENTARIO de lo que hay. No puede resumir nada porque no
// tiene nada que resumir; sólo puede responder qué haría falta para contestar.
//
// ─── Lo que NO cambia ─────────────────────────────────────────────────────
//
// Los gates siguen en código: el guion propone, `askArchive` dispone. Ni una
// sola regla de evidencia se relaja — el redactor sigue sin poder inventar
// números, citar de memoria ni escribir una sección sin respaldo.
//
// Y no gobierna las cuatro formas: `decision` y `preview` conservan su
// esquema fijo a propósito. Sus claves son PORTANTES —`stance` tiene un gate
// que la borra sin respaldo, `add` existe porque sin ella el modelo no podía
// recomendar ampliar, y el orden lo reimpone el código porque un modelo de la
// cola de la cadena devuelve las claves como le sale—. Cambiarlas por un
// guion libre tiraría tres arreglos medidos para resolver un problema que
// esas dos formas ya no tienen.

import { proseCompletion } from "@/lib/ai/prose-chain";

/** Un epígrafe propuesto. `brief` es la instrucción interna para el
 *  redactor: qué tiene que contener esta sección y nada más. */
export type OutlineSection = {
  key: string;
  title: string;
  brief: string;
};

/**
 * Techo de secciones. Seis es el máximo que usan las formas fijas (decisión y
 * previa) y por encima de eso una respuesta temática deja de leerse.
 *
 * PERO el techo tiene que CABER a la pregunta, y con un tope fijo no cabía:
 * medido el 2026-08-12 con la cartera de 7 posiciones, el editor devolvió 6
 * secciones y se dejó RKLB fuera. Una respuesta "stock por stock" a la que le
 * falta un valor es peor que una que no lo intenta, porque el lector no puede
 * saber cuál falta. Cuando la pregunta es por entidades, el techo sube hasta
 * cubrirlas.
 */
const BASE_MAX_SECTIONS = 6;
/** Tope duro. Por encima de esto el prompt de redacción y su presupuesto de
 *  salida dejan de dar: son epígrafes de 2-4 frases cada uno. */
const HARD_MAX_SECTIONS = 12;

function maxSectionsFor(entities: number): number {
  // `entities + 1`, y el +1 no es margen de seguridad: es el HUECO de la
  // sección de cabecera. Medido con la cartera de 7 y un tope de 7, el
  // editor gastó las siete en una posición cada una — así que la primera
  // sección era META y no la respuesta de frente que la propia primera
  // regla exige. Con siete valores cayendo a la vez, "esto es mercado, no
  // siete historias" es lo primero que hay que decir, y no cabía.
  return Math.min(HARD_MAX_SECTIONS, Math.max(BASE_MAX_SECTIONS, entities + 1));
}
/** Piso. Con una sola sección el guion no aporta nada sobre la prosa suelta,
 *  pero tampoco estorba: se acepta. Cero secciones sí es un fallo. */
const MIN_SECTIONS = 1;

const outlinePromptFor = (maxSections: number) => `You are the editor of a financial research desk. You do NOT write the answer — you decide its SHAPE.

You receive the reader's QUESTION and an INVENTORY of the material the archive actually holds for it. You never see the material itself, and that is on purpose: your job is to decide what would ANSWER this question, not to summarise anything.

Output ONLY a JSON object:
{"sections": [{"key": "snake_case_id", "title": "SHORT ALL-CAPS LABEL", "brief": "one sentence, in English, telling the writer exactly what goes in this section"}]}

Rules:
- Between 1 and ${maxSections} sections. FEWER IS BETTER. Every section you add is a promise the material has to keep; an empty heading is a lie about how much the archive knows.
- The FIRST section must answer the question head-on. If the reader asks "why", section one says why. If they ask "which", section one names them.
- OBEY AN EXPLICIT INSTRUCTION ABOUT FORM. If the question says "stock by stock", "one by one", "uno por uno", "por separado", "compare X and Y", "just the number", "in one line" — that instruction IS the outline. A reader who asks for a per-holding breakdown and gets four thematic essays did not get an answer. When the instruction implies one section per entity, emit one section per entity, using the entity as the key (e.g. key "meta", title "META").
- WHEN YOU GO ONE-PER-ENTITY, COVER EVERY ENTITY THE INVENTORY LISTS. All of them, including the ones that moved the least and the ones that moved the OTHER WAY — "this is the only one holding up" is an answer to "why is it falling", and a reader who gets six of his seven holdings cannot tell which one you dropped. If they do not all fit, do not go one-per-entity at all: group them instead and say so.
- PROPOSE ONLY WHAT THE INVENTORY CAN SUPPORT. The inventory tells you what exists: positions with their day move already computed, company press releases already read, article bodies extracted, structured filing facts. Do not propose a section on insider activity if the inventory reports none. Do not propose a "what's next" section if there are no dated commitments.
- Never propose a section that asks for a forecast, a price target, a direction, or an amount to trade. Those are the project's red lines and the writer will refuse them, leaving your section empty.
- "title": the reader's language, taken from the QUESTION — not the inventory's. SHORT: two or three words.
- "key": stable snake_case ASCII, unique, no accents.
- Do not propose a generic "conclusion" or "summary" section. The first section already carries the answer; a summary at the end is padding.`;

/** Lo que el editor puede saber sin ver el material. */
export type OutlineInventory = {
  question: string;
  /** `archive` | `diagnose` — las dos formas que gobierna este guion. */
  job: string;
  scope: string;
  /** Una línea por recurso disponible, ya en lenguaje llano. */
  lines: string[];
  /** Cuántas ENTIDADES hay sobre la mesa (posiciones, tickers preguntados).
   *  Sube el techo de secciones lo justo para que quepan todas: es lo que
   *  hace posible un "stock por stock" completo. */
  entities?: number;
};

function slugKey(raw: unknown, i: number): string {
  const s = typeof raw === "string" ? raw : "";
  const clean = s
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 24);
  return clean || `s${i + 1}`;
}

/**
 * Sanea la salida del editor. Es un GATE, no una conversión amable: lo que no
 * cumpla se cae. Un guion inválido devuelve `null` y el llamante se queda con
 * su forma fija — degradar a lo de siempre es aceptable, redactar contra un
 * esquema roto no.
 */
export function parseOutline(
  raw: unknown,
  maxSections: number = BASE_MAX_SECTIONS,
): OutlineSection[] | null {
  const obj = raw as { sections?: unknown };
  if (!Array.isArray(obj?.sections)) return null;
  const out: OutlineSection[] = [];
  const seen = new Set<string>();
  for (const [i, s] of obj.sections.entries()) {
    const sec = s as { key?: unknown; title?: unknown; brief?: unknown };
    const title = typeof sec?.title === "string" ? sec.title.trim().slice(0, 40) : "";
    const brief = typeof sec?.brief === "string" ? sec.brief.trim().slice(0, 300) : "";
    // Sin título no hay epígrafe, y sin `brief` el redactor no sabe qué
    // meter dentro: los dos son obligatorios. Una sección a medias produce
    // exactamente el relleno que este guion existe para evitar.
    if (!title || !brief) continue;
    let key = slugKey(sec?.key ?? title, i);
    // Claves duplicadas: el redactor devuelve un array y el orden se
    // reimpone por clave, así que dos secciones con la misma clave se
    // fundirían en una y la respuesta perdería un bloque sin avisar.
    while (seen.has(key)) key = `${key}_${seen.size}`;
    seen.add(key);
    out.push({ key, title, brief });
    if (out.length >= maxSections) break;
  }
  return out.length >= MIN_SECTIONS ? out : null;
}

/**
 * Pide el guion. Devuelve `null` ante CUALQUIER fallo — no lanza.
 *
 * Que no lance es el requisito de diseño: esta llamada es una mejora de la
 * forma, no un eslabón del que dependa la respuesta. Si el editor no
 * contesta, /ask sigue respondiendo con su plantilla de siempre, que es
 * exactamente lo que hacía ayer. Una feature nueva no puede convertirse en
 * un punto único de fallo de una que ya funcionaba.
 */
export async function planOutline(
  inv: OutlineInventory,
): Promise<OutlineSection[] | null> {
  const userBlock = [
    `QUESTION: ${inv.question}`,
    `Question type: ${inv.job} · scope: ${inv.scope}`,
    "",
    "INVENTORY — what the archive holds for this question:",
    ...inv.lines.map((l) => `- ${l}`),
  ].join("\n");

  const maxSections = maxSectionsFor(inv.entities ?? 0);

  try {
    const res = await proseCompletion({
      messages: [
        { role: "system", content: outlinePromptFor(maxSections) },
        { role: "user", content: userBlock },
      ],
      temperature: 0.1,
      // El guion son ~6 objetos cortos. Con 500 sobra y el techo bajo es
      // parte del control de coste: esta llamada se paga en TODA pregunta de
      // archivo o diagnóstico, no sólo en las de decisión.
      maxTokens: 220 + maxSections * 70,
      tag: "ask-outline",
      jsonMode: true,
      geminiTimeoutMs: 20_000,
      geminiOverallTimeoutMs: 35_000,
    });
    const parsed = JSON.parse(
      res.content.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, ""),
    ) as unknown;
    const outline = parseOutline(parsed, maxSections);
    console.log(
      `[ask-outline] model=${res.model} secciones=${outline?.length ?? 0}` +
        (outline ? ` [${outline.map((s) => s.key).join(", ")}]` : " (descartado)"),
    );
    return outline;
  } catch (err) {
    console.warn(
      "[ask-outline] sin guion, se usa la forma fija:",
      err instanceof Error ? err.message.slice(0, 140) : err,
    );
    return null;
  }
}
