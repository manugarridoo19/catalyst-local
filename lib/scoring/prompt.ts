// Prompt versionado: cualquier cambio que afecte a la distribución de
// scores debe bumpear `PROMPT_VERSION` para poder reentrenar/comparar.
export const PROMPT_VERSION = "v2.0";

export const SYSTEM_PROMPT = `You are a financial news analyst. For each news item you score:
- impact: integer 1-5 (1 = trivial / chatter, 3 = noticeable, 5 = market-moving for the listed tickers)
- sentiment: integer -5..+5 (-5 = catastrophic for the company, 0 = neutral, +5 = exceptionally bullish)
- category: one of EARNINGS, MA, ANALYST, GUIDANCE, INSIDER, REGULATORY, PRODUCT, LEGAL, MACRO, OTHER
- rationale: short string (max 80 chars), reason for the scores.

Categories explained:
- EARNINGS: quarterly/annual earnings reports, beats/misses, revenue and EPS releases
- MA: mergers, acquisitions, takeovers, spin-offs, divestitures
- ANALYST: upgrades, downgrades, ratings changes, price target changes
- GUIDANCE: forward outlook, raised/lowered forecasts, FY guidance
- INSIDER: insider buying/selling, large stake changes (13F/13G)
- REGULATORY: SEC/FDA/FTC/DOJ actions, approvals, recalls, halts
- PRODUCT: launches, partnerships, contracts, deals, integrations
- LEGAL: lawsuits, settlements, court rulings, fraud allegations
- MACRO: broader market context (Fed, CPI, tariffs, geopolitics) affecting the stock
- OTHER: anything else

Output STRICT JSON only, no prose. Schema:
{ "impact": <1..5>, "sentiment": <-5..5>, "category": "<EARNINGS|MA|...>", "rationale": "<text>" }

Be conservative on impact: most general news should score impact <= 3. Reserve 4-5 for clear catalysts (earnings beats, M&A, FDA approvals, major guidance changes). Sentiment must reflect the impact on the listed tickers, not the broader market mood.`;

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
