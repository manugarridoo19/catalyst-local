import {
  chatCompletion,
  type ChatMessage,
  type ChatCompletionResult,
} from "@/lib/providers/openrouter";
import {
  geminiChatCompletion,
  getGeminiPoolStatus,
  type ThinkingLevel,
} from "@/lib/providers/gemini";
import { groqChatCompletion } from "@/lib/providers/groq";

// Cadena de proveedores para prosa user-facing, compartida por el AI Brief
// global y el Ticker Day Brief:
//
//   1. OpenRouter task="brief" (nemotron-ultra primero — máxima calidad)
//   2. Gemini flash-lite (pool AI Studio round-robin, 2026-07-16) — entra
//      cuando el pool OpenRouter agota su free-models-per-day; mejor prosa
//      que el 8b de Groq y cuota diaria mucho más holgada
//   3. Groq llama-3.3-70b
//   4. Groq llama-3.1-8b-instant (último recurso; los guards de longitud/
//      scratchpad del caller descartan salidas malas)
//
// El caller aplica sus propios guards al resultado — esta función solo
// garantiza "algún proveedor respondió" o lanza el último error.

export async function proseCompletion(opts: {
  messages: ChatMessage[];
  temperature: number;
  maxTokens: number;
  /** Etiqueta para logs, p.ej. "brief" | "ticker-brief". */
  tag: string;
  /** Salida JSON estructurada (AI Picks). Los tres proveedores lo soportan
   *  (response_format / responseMimeType). */
  jsonMode?: boolean;
  /** Timeout por intento contra Gemini. Los 25s por defecto se calibraron
   *  para prosa corta (briefs); una tarea con prompt grande y respuesta
   *  larga los roza y entonces pasa lo peor: el modelo de CABEZA se queda
   *  a medias, aborta, y responde el de reserva — mucho más rápido y
   *  bastante peor. Quien pida más tokens debe pedir también más reloj.
   *  Medido en /ask el 2026-07-29: 23,5s de respuesta contra 25s de techo. */
  geminiTimeoutMs?: number;
  /** Techo de pared del barrido completo de Gemini. */
  geminiOverallTimeoutMs?: number;
  /**
   * Pone GEMINI EN CABEZA con este modelo y este nivel de pensamiento, en
   * lugar de OpenRouter. Si falla, la cadena sigue igual que siempre.
   *
   * Existe para UNA superficie: la redacción de /ask. La cadena normal manda
   * `reasoning:{enabled:false}` a OpenRouter y `thinkingLevel:"minimal"` a
   * Gemini, o sea que **hoy ninguna respuesta del proyecto razona** salvo la
   * fusión diaria de Author Watch. Para un brief de titulares eso es correcto
   * y barato. Para "por qué cae mi cartera, ve stock por stock" no: medido el
   * 2026-08-12, el mismo modelo con el mismo material pasa de adjetivos a
   * atribución por posición al subir de `minimal` a `low`.
   *
   * Va como opción y no como cambio de la cadena a propósito: el tier `lite`
   * se eligió por CUOTA y sostiene el scoring (~250 llamadas/día) y los
   * embeddings. /ask son un puñado de preguntas al día; el resto no se toca.
   */
  reason?: { model: string; thinking: ThinkingLevel };
}): Promise<ChatCompletionResult> {
  const { messages, temperature, maxTokens, tag, jsonMode } = opts;

  const warn = (provider: string, err: unknown) =>
    console.warn(
      `[${tag}] ${provider} failed, falling through:`,
      err instanceof Error ? err.message.slice(0, 120) : err,
    );

  // Gemini EN CABEZA cuando el llamante pide razonamiento. No es un atajo de
  // rendimiento: OpenRouter va con `reasoning:{enabled:false}` en toda la
  // cadena `brief`, así que pasar por él primero sería pedir razonamiento y
  // recibir lo de siempre. Si falla (cuota, 404 del modelo, timeout), cae a
  // la cadena completa de abajo — incluida la propia Gemini con su modelo
  // por defecto, así que el peor caso es la respuesta de ayer, no un error.
  if (opts.reason && getGeminiPoolStatus().total > 0) {
    try {
      return await geminiChatCompletion({
        messages,
        model: opts.reason.model,
        thinking: opts.reason.thinking,
        temperature,
        maxTokens,
        jsonMode,
        timeoutMs: opts.geminiTimeoutMs ?? 25_000,
        overallTimeoutMs: opts.geminiOverallTimeoutMs,
      });
    } catch (err) {
      warn(`gemini(${opts.reason.model})`, err);
    }
  }

  try {
    return await chatCompletion({
      messages,
      task: "brief",
      temperature,
      maxTokens,
      jsonMode,
      timeoutMs: 30_000,
    });
  } catch (err) {
    warn("openrouter", err);
  }

  if (getGeminiPoolStatus().total > 0) {
    try {
      return await geminiChatCompletion({
        messages,
        temperature,
        maxTokens,
        jsonMode,
        timeoutMs: opts.geminiTimeoutMs ?? 25_000,
        overallTimeoutMs: opts.geminiOverallTimeoutMs,
      });
    } catch (err) {
      warn("gemini", err);
    }
  }

  try {
    return await groqChatCompletion({
      messages,
      model: "llama-3.3-70b-versatile",
      temperature,
      maxTokens,
      jsonMode,
      timeoutMs: 25_000,
      retries: 1,
    });
  } catch (err) {
    warn("groq-70b", err);
  }

  return await groqChatCompletion({
    messages,
    model: "llama-3.1-8b-instant",
    temperature,
    maxTokens,
    jsonMode,
    timeoutMs: 25_000,
    retries: 1,
  });
}
