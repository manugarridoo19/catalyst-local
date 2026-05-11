import { chatCompletion } from "@/lib/providers/openrouter";
import { groqChatCompletion, GroqRateLimited } from "@/lib/providers/groq";
import { PROMPT_VERSION, SYSTEM_PROMPT, buildUserPrompt } from "./prompt";
import { parseScore } from "./parser";
import type { SentimentScore } from "@/lib/types";

// Stack de scoring:
//   1) OpenRouter Nemotron (nvidia/nemotron-3-super-120b-a12b:free) primario
//      — modelo big de NVIDIA con razonamiento más fino que Llama 3.1 8b
//   2) Groq llama-3.1-8b-instant como fallback rápido si OpenRouter cae
//   3) Si ambos fallan, dejamos sin score y el siguiente cron retry
//
// Si quieres forzar otro modelo: SCORER_PRIMARY=groq | openrouter

type Provider = "openrouter" | "groq";

// 2026-05: cambio el default a Groq. OpenRouter free (incl. owl-alpha)
// rate-limita brutal — cada call 5-15s con retries, así no entra ni 1 batch
// en el 60s de Vercel Hobby. Groq llama-3.1-8b-instant: 0.5-2s/call. Para
// pruebas de calidad puntuales: SCORER_PRIMARY=openrouter en env.
const PRIMARY: Provider =
  (process.env.SCORER_PRIMARY?.toLowerCase() as Provider) || "groq";

// 2026-05: probamos openrouter/owl-alpha — modelo con contexto largo, útil
// porque algunos earnings transcripts vienen con bodies grandes. Si falla
// upstream, fallback chain en lib/providers/openrouter.ts entra (DeepSeek
// V3.1, Nemotron 70B, Llama 3.3 70B, Qwen 2.5 72B, Gemini 2.0).
const OPENROUTER_DEFAULT_MODEL = "openrouter/owl-alpha";

async function scoreViaOpenRouter(input: {
  headline: string;
  body?: string;
  tickers: string[];
  source?: string;
}) {
  const model = process.env.OPENROUTER_MODEL || OPENROUTER_DEFAULT_MODEL;
  const messages = [
    { role: "system" as const, content: SYSTEM_PROMPT },
    { role: "user" as const, content: buildUserPrompt(input) },
  ];
  const result = await chatCompletion({
    messages,
    model,
    temperature: 0.1,
    maxTokens: 220,
    jsonMode: true,
  });
  return { content: result.content, model: result.model };
}

async function scoreViaGroq(input: {
  headline: string;
  body?: string;
  tickers: string[];
  source?: string;
}) {
  const messages = [
    { role: "system" as const, content: SYSTEM_PROMPT },
    { role: "user" as const, content: buildUserPrompt(input) },
  ];
  const result = await groqChatCompletion({
    messages,
    temperature: 0.1,
    maxTokens: 220,
    jsonMode: true,
    retries: 3,
  });
  return { content: result.content, model: result.model };
}

export async function scoreNewsItem(input: {
  headline: string;
  body?: string;
  tickers: string[];
  source?: string;
}): Promise<SentimentScore | null> {
  const hasOpenRouter = Boolean(process.env.OPENROUTER_API_KEY);
  const hasGroq = Boolean(process.env.GROQ_API_KEY);
  if (!hasOpenRouter && !hasGroq) {
    console.warn("[scoring] no provider keys set — skipping");
    return null;
  }

  // Orden de proveedores según preferencia.
  const order: Provider[] =
    PRIMARY === "groq" ? ["groq", "openrouter"] : ["openrouter", "groq"];

  for (const provider of order) {
    if (provider === "openrouter" && !hasOpenRouter) continue;
    if (provider === "groq" && !hasGroq) continue;

    try {
      const { content, model } =
        provider === "openrouter"
          ? await scoreViaOpenRouter(input)
          : await scoreViaGroq(input);
      const parsed = parseScore(content);
      if (!parsed) {
        console.warn(
          `[scoring] ${provider} unparseable: "${content.slice(0, 200).replace(/\n/g, " ")}"`,
        );
        continue; // intenta siguiente provider
      }
      return {
        impact: parsed.impact,
        sentiment: parsed.sentiment,
        category: parsed.category,
        rationale: parsed.rationale,
        model,
        promptVersion: PROMPT_VERSION,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (err instanceof GroqRateLimited) {
        console.warn(`[scoring] groq rate-limited:`, msg.slice(0, 100));
      } else {
        console.warn(`[scoring] ${provider} error:`, msg.slice(0, 160));
      }
      // continúa al siguiente provider
    }
  }
  return null;
}
