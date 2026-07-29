import {
  chatCompletion,
  type ChatMessage,
  type ChatCompletionResult,
} from "@/lib/providers/openrouter";
import {
  geminiChatCompletion,
  getGeminiPoolStatus,
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
}): Promise<ChatCompletionResult> {
  const { messages, temperature, maxTokens, tag, jsonMode } = opts;

  const warn = (provider: string, err: unknown) =>
    console.warn(
      `[${tag}] ${provider} failed, falling through:`,
      err instanceof Error ? err.message.slice(0, 120) : err,
    );

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
