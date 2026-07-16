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
}): Promise<ChatCompletionResult> {
  const { messages, temperature, maxTokens, tag } = opts;

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
        timeoutMs: 25_000,
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
    timeoutMs: 25_000,
    retries: 1,
  });
}
