import { groqChatCompletion, GroqRateLimited } from "@/lib/providers/groq";
import { PROMPT_VERSION, SYSTEM_PROMPT, buildUserPrompt } from "./prompt";
import { parseScore } from "./parser";
import type { SentimentScore } from "@/lib/types";

// Solo Groq. OpenRouter free models están constantemente saturados/retirados
// y la cadena de fallback consumía tiempo sin valor real. Si Groq cae para
// una noticia concreta, la dejamos sin score y el siguiente cron la
// reintentará — el budget se respeta así sin ruido en logs.

export async function scoreNewsItem(input: {
  headline: string;
  body?: string;
  tickers: string[];
  source?: string;
}): Promise<SentimentScore | null> {
  if (!process.env.GROQ_API_KEY) {
    console.warn("[scoring] GROQ_API_KEY not set — skipping scoring");
    return null;
  }
  const messages = [
    { role: "system" as const, content: SYSTEM_PROMPT },
    { role: "user" as const, content: buildUserPrompt(input) },
  ];

  try {
    const result = await groqChatCompletion({
      messages,
      temperature: 0.1,
      maxTokens: 220,
      jsonMode: true,
      retries: 4,
    });
    const parsed = parseScore(result.content);
    if (!parsed) {
      console.warn(
        `[scoring] groq unparseable: "${result.content.slice(0, 200).replace(/\n/g, " ")}"`,
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
    if (err instanceof GroqRateLimited) {
      console.warn(`[scoring] groq rate-limited:`, err.message.slice(0, 100));
      return null;
    }
    console.warn(
      `[scoring] groq error:`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}
