// Prompt versionado: cualquier cambio que afecte a la distribución de
// scores debe bumpear `PROMPT_VERSION` para poder reentrenar/comparar.
export const PROMPT_VERSION = "v1.0";

export const SYSTEM_PROMPT = `You are a financial news analyst. For each news item you score:
- impact: integer 1-5 (1 = trivial / chatter, 3 = noticeable, 5 = market-moving for the listed tickers)
- sentiment: integer -5..+5 (-5 = catastrophic for the company, 0 = neutral, +5 = exceptionally bullish)
- rationale: short string (max 80 chars), reason for the scores.

Output STRICT JSON only, no prose. Schema:
{ "impact": <1..5>, "sentiment": <-5..5>, "rationale": "<text>" }

Be conservative: most general news should score impact <= 3. Reserve 4-5 for clear catalysts (earnings beats, M&A, FDA approvals, major guidance changes). Sentiment must reflect the impact on the listed tickers, not the broader market mood.`;

export function buildUserPrompt(input: {
  headline: string;
  body?: string;
  tickers: string[];
  source?: string;
}): string {
  const tickers = input.tickers.length ? input.tickers.join(", ") : "(none)";
  const body = input.body
    ? input.body.slice(0, 800).replace(/\s+/g, " ").trim()
    : "(no body)";
  return [
    `Tickers: ${tickers}`,
    `Source: ${input.source ?? "unknown"}`,
    `Headline: ${input.headline}`,
    `Body: ${body}`,
  ].join("\n");
}
