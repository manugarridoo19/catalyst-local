import { chatCompletion } from "@/lib/providers/openrouter";
import { PROMPT_VERSION, SYSTEM_PROMPT, buildUserPrompt } from "./prompt";
import { parseScore } from "./parser";
import type { SentimentScore } from "@/lib/types";

export async function scoreNewsItem(input: {
  headline: string;
  body?: string;
  tickers: string[];
  source?: string;
}): Promise<SentimentScore | null> {
  const result = await chatCompletion({
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: buildUserPrompt(input) },
    ],
    temperature: 0.1,
    maxTokens: 180,
    jsonMode: true,
  });

  const parsed = parseScore(result.content);
  if (!parsed) {
    console.warn(
      `[scoring] Could not parse: ${result.content.slice(0, 200)}`,
    );
    return null;
  }

  return {
    impact: parsed.impact,
    sentiment: parsed.sentiment,
    rationale: parsed.rationale,
    model: result.model,
    promptVersion: PROMPT_VERSION,
  };
}
