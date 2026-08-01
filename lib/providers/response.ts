// Contrato ÚNICO de "esta respuesta no sirve", compartido por los tres
// proveedores de chat (openrouter, gemini, groq).
//
// POR QUÉ EXISTE: la regla "un 200 con contenido vacío es un error
// retriable" estaba escrita tres veces y cumplida sólo dos — Groq devolvía
// `""` como éxito, y al ser el último eslabón de `prose-chain` esa cadena
// vacía llegaba al `JSON.parse` del llamante como si fuera una respuesta.
// Tratarlo como éxito cortocircuita la cadena de fallback, que es el
// incidente del 2026-07-17.
//
// Y POR QUÉ LLEVA `finishReason`: vacío y TRUNCADO son fallos distintos que
// hasta ahora se veían igual. Un JSON cortado a la mitad por `maxTokens`
// llega con contenido (no dispara el guard de vacío), revienta el
// `JSON.parse` del llamante y se registra como "el modelo devolvió basura" —
// cuando lo que hacía falta era más techo de salida. Es el mismo modo de
// fallo que costó el "batch unparseable" del scoring y el truncado del
// extractor de resultados (lib/ai/earnings-report.ts). El campo se propaga
// crudo desde cada API y se interpreta aquí, en un solo sitio.

/** Motivos de parada que significan "me quedé sin sitio", en el dialecto de
 *  cada proveedor: OpenAI/OpenRouter/Groq dicen `length`, Gemini dice
 *  `MAX_TOKENS`. Se compara en minúsculas para no depender del casing. */
const TRUNCATED_FINISHES = new Set(["length", "max_tokens", "maxtokens"]);

/** ¿La respuesta se cortó por el techo de tokens? */
export function isTruncated(finishReason: string | null | undefined): boolean {
  if (!finishReason) return false;
  return TRUNCATED_FINISHES.has(finishReason.trim().toLowerCase());
}

/** Mensaje del error retriable de contenido vacío. Nombra el modelo y, si el
 *  proveedor lo dijo, POR QUÉ paró — un vacío por `MAX_TOKENS` (el modelo
 *  quemó el presupuesto pensando) y uno por `SAFETY` piden reacciones
 *  distintas y hasta ahora eran la misma línea de log. */
export function emptyContentMessage(
  model: string,
  finishReason?: string | null,
): string {
  return finishReason
    ? `empty content from ${model} (finishReason=${finishReason})`
    : `empty content from ${model}`;
}

/** Avisa UNA vez de que la salida venía truncada.
 *
 *  Se llama desde los generadores que esperan JSON: sin esto, el llamante
 *  sólo ve un `JSON.parse` que falla y no puede distinguir "el modelo no
 *  sabe emitir JSON" (cambiar de modelo) de "no cabía" (subir `maxTokens`).
 *  Devuelve el propio booleano para poder encadenarlo en una condición. */
export function warnIfTruncated(
  tag: string,
  res: { model: string; finishReason?: string | null },
): boolean {
  if (!isTruncated(res.finishReason)) return false;
  console.warn(
    `[${tag}] SALIDA TRUNCADA por maxTokens (${res.model}) — el JSON llega ` +
      `cortado y no es culpa del modelo: sube el techo de salida de esta tarea`,
  );
  return true;
}
