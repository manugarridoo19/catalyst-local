import { chatCompletion } from "@/lib/providers/openrouter";
import { groqChatCompletion, GroqRateLimited } from "@/lib/providers/groq";
import { PROMPT_VERSION, SYSTEM_PROMPT, buildUserPrompt } from "./prompt";
import { parseScore } from "./parser";
import type { SentimentScore } from "@/lib/types";

// Strategy: Groq primary (free + sub-segundo + 30 req/min) → OpenRouter
// fallback (5-modelo chain). Si los dos caen, devolvemos null y la news
// queda sin score para que la UI muestre "—".

export async function scoreNewsItem(input: {
  headline: string;
  body?: string;
  tickers: string[];
  source?: string;
}): Promise<SentimentScore | null> {
  const messages = [
    { role: "system" as const, content: SYSTEM_PROMPT },
    { role: "user" as const, content: buildUserPrompt(input) },
  ];

  // 1) Groq (primary).
  if (process.env.GROQ_API_KEY) {
    try {
      const result = await groqChatCompletion({
        messages,
        temperature: 0.1,
        maxTokens: 180,
        jsonMode: true,
      });
      const parsed = parseScore(result.content);
      if (parsed) {
        return {
          impact: parsed.impact,
          sentiment: parsed.sentiment,
          category: parsed.category,
          rationale: parsed.rationale,
          model: result.model,
          promptVersion: PROMPT_VERSION,
        };
      }
      console.warn(`[scoring] groq returned unparseable: ${result.content.slice(0, 200)}`);
    } catch (err) {
      if (!(err instanceof GroqRateLimited)) {
        console.warn(
          `[scoring] groq failed:`,
          err instanceof Error ? err.message : err,
        );
      }
      // Caer al fallback de OpenRouter.
    }
  }

  // 2) OpenRouter (fallback con cadena de 5 modelos).
  try {
    const result = await chatCompletion({
      messages,
      temperature: 0.1,
      maxTokens: 180,
      jsonMode: true,
    });
    const parsed = parseScore(result.content);
    if (!parsed) {
      console.warn(
        `[scoring] openrouter unparseable: ${result.content.slice(0, 200)}`,
      );
      return null;
    }
    return {
      impact: parsed.impact,
      sentiment: parsed.sentiment,
      category: parsed.category,
      rationale: parsed.rationale,
      model: result.model,
      promptVersion: PROMPT_VERSION,
    };
  } catch (err) {
    console.warn(
      `[scoring] all providers failed:`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}
