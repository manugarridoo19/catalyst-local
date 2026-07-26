// Libro de futuros — primera de las dos llamadas LLM de la revisión.
//
// POR QUÉ DOS LLAMADAS Y NO UNA CON MÁS INSTRUCCIONES:
//
// Un modelo al que se le da un montón de artículos y se le pide "analiza
// la cartera" resume. Es su gradiente natural y ninguna cantidad de "no
// resumas" en el prompt lo cambia de forma fiable — la primera versión de
// esta función lo demostró: con la orden explícita de anticiparse, seguía
// devolviendo "la acción cae un 8%".
//
// Separar la EXTRACCIÓN de la REDACCIÓN cambia la tarea. Aquí el modelo no
// puede resumir porque no se le pide un texto: se le pide rellenar un
// esquema en el que "la acción cayó" no cabe en ningún campo. Si no
// encuentra compromisos futuros, la salida correcta es una lista vacía —
// y una lista vacía es un resultado honesto y visible, no una respuesta
// plausible que nadie va a auditar.
//
// La segunda llamada (portfolio-review) redacta ya sin los artículos
// delante, sólo con este libro y los agregados. No puede volver al titular
// porque no lo tiene.

import { proseCompletion } from "@/lib/ai/prose-chain";
import type { ForwardCandidate } from "@/lib/ask/forward";

/** Chars de cuerpo que viajan por artículo. Los compromisos ("sujeto a
 *  aprobación", "espera cerrar en") aparecen casi siempre en los primeros
 *  párrafos; el resto suele ser contexto y boilerplate. */
const BODY_CHARS = 1400;
/** Tope de artículos por llamada, para no reventar la ventana de contexto
 *  del modelo más pequeño de la cadena de fallback. */
const MAX_ITEMS = 22;

export type ForwardItem = {
  symbol: string;
  /** Qué va a pasar. Redactado como hecho futuro, no como titular. */
  event: string;
  /** El plazo TAL COMO lo dice la fuente ("first half of 2027", "upon
   *  regulatory approval"). Sin normalizar: la vaguedad es información. */
  when: string | null;
  /** Fecha ISO sólo si la fuente da una fecha concreta. */
  whenDate: string | null;
  /** De qué depende que ocurra. Vacío = no hay condición declarada. */
  condition: string | null;
  kind: "deal" | "guidance" | "regulatory" | "legal" | "product" | "capacity" | "other";
  /** Número de cita de la que sale. */
  source: number;
};

const SYSTEM_PROMPT = `Extraes COMPROMISOS FUTUROS de artículos financieros. No resumes, no opinas, no analizas.

Un compromiso futuro es algo que, según el texto, TODAVÍA NO HA OCURRIDO: una operación anunciada pendiente de cerrar, una guía dada para un periodo que no ha terminado, una aprobación regulatoria en trámite, un juicio con fecha señalada, un producto o capacidad con fecha de entrega, un contrato con hitos por delante.

NO son compromisos futuros y debes DESCARTARLOS:
- Movimientos de precio, pasados o esperados ("la acción cayó un 8%", "podría subir").
- Resultados ya publicados, adquisiciones ya cerradas, productos ya lanzados.
- Precios objetivo, recomendaciones y opiniones de analistas.
- Especulación del autor sin una declaración de la empresa o del regulador detrás.
- Cualquier cosa que tú infieras. Si no está escrita en el texto, no existe.

Devuelve SOLO un objeto JSON:
{"items": [{"symbol": "AAA", "event": "...", "when": "...", "whenDate": "2027-03-31" | null, "condition": "..." | null, "kind": "deal|guidance|regulatory|legal|product|capacity|other", "source": 3}]}

Reglas:
- "event": una frase, en español, redactada como hecho pendiente. "Cierre de la compra de Iridium por 8.000M$" sirve. "Rocket Lab anunció que compra Iridium" no sirve: eso es el pasado.
- "when": el plazo LITERAL que da la fuente, traducido pero sin precisar más que ella. Si el texto dice "in the first half of 2027", pon "primer semestre de 2027", no una fecha. Si no dice plazo, null.
- "whenDate": sólo si hay fecha concreta. Ante la duda, null.
- "condition": la condición suspensiva declarada ("aprobación de accionistas", "revisión antimonopolio"). Si no hay, null.
- "source": el número [n] del artículo del que sale. Obligatorio.
- Un artículo puede dar cero, uno o varios compromisos. La mayoría dará cero: es lo normal y lo correcto.
- Si NINGÚN artículo contiene compromisos futuros, devuelve {"items": []}. Es una respuesta válida y preferible a inventar.`;

const KINDS = new Set([
  "deal", "guidance", "regulatory", "legal", "product", "capacity", "other",
]);

/**
 * Extrae el libro de futuros de los candidatos que TIENEN cuerpo.
 *
 * Los que no lo tienen se descartan aquí en vez de mandar el titular
 * suelto: un titular no contiene compromisos con plazo y condición, sólo
 * el hecho de que algo pasó. Mandarlo sería invitar al modelo justo al
 * error que esta separación en dos etapas trata de eliminar.
 */
export async function extractForwardLedger(
  candidates: ForwardCandidate[],
  numberOf: (newsId: number) => number | undefined,
): Promise<{ items: ForwardItem[]; model: string | null; withBody: number }> {
  const withBody = candidates.filter(
    (c) => c.body && c.body.trim().length >= 200,
  );
  if (!withBody.length) return { items: [], model: null, withBody: 0 };

  // Se priorizan los que ya venían ordenados por peso de categoría, así que
  // el recorte se lleva la cola menos prometedora.
  const chosen = withBody.slice(0, MAX_ITEMS);

  const block = chosen
    .map((c) => {
      const n = numberOf(c.newsId);
      if (n === undefined) return null;
      const date = c.publishedAt.slice(0, 10);
      return `[${n}] ${date} · ${c.symbol} · ${c.category ?? "?"} · ${c.headline}\n${c.body!.slice(0, BODY_CHARS).replace(/\s+/g, " ")}`;
    })
    .filter(Boolean)
    .join("\n\n");

  if (!block) return { items: [], model: null, withBody: chosen.length };

  const res = await proseCompletion({
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: `HOY ES ${new Date().toISOString().slice(0, 10)}. Cualquier plazo anterior a esta fecha ya venció: no lo devuelvas como pendiente.\n\nARTÍCULOS:\n${block}`,
      },
    ],
    // Temperatura mínima: esto es extracción, no redacción. Cualquier
    // creatividad aquí se convierte en un compromiso inventado.
    temperature: 0.1,
    maxTokens: 1600,
    tag: "forward-ledger",
    jsonMode: true,
  });

  let parsed: { items?: Array<Record<string, unknown>> };
  try {
    parsed = JSON.parse(
      res.content.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, ""),
    );
  } catch {
    // Un libro de futuros ilegible NO debe tumbar la revisión: se sigue
    // con los hechos estructurales, que son los que más peso tienen.
    return { items: [], model: res.model, withBody: chosen.length };
  }

  const validSources = new Set(
    chosen.map((c) => numberOf(c.newsId)).filter((n): n is number => n !== undefined),
  );
  const bySymbol = new Set(candidates.map((c) => c.symbol));

  const items: ForwardItem[] = (parsed.items ?? [])
    .map((raw) => ({
      symbol: String(raw.symbol ?? "").toUpperCase(),
      event: String(raw.event ?? "").trim(),
      when: raw.when ? String(raw.when).trim() : null,
      whenDate:
        typeof raw.whenDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw.whenDate)
          ? raw.whenDate
          : null,
      condition: raw.condition ? String(raw.condition).trim() : null,
      kind: (KINDS.has(String(raw.kind)) ? String(raw.kind) : "other") as ForwardItem["kind"],
      source: Number(raw.source),
    }))
    // Mismo criterio que el gate de evidencia de la revisión: un item que
    // cita una fuente inexistente o habla de un símbolo que no está en la
    // cartera es una alucinación, y se cae aquí y no en pantalla.
    .filter(
      (i) =>
        i.event.length > 0 &&
        bySymbol.has(i.symbol) &&
        Number.isInteger(i.source) &&
        validSources.has(i.source),
    );

  return { items, model: res.model, withBody: chosen.length };
}
