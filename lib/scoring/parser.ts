// Los modelos free de OpenRouter a veces ignoran `response_format` y
// devuelven JSON envuelto en prosa o code fences. Hacemos parsing robusto
// con fallbacks regex.

export type ParsedScore = {
  impact: number;
  sentiment: number;
  rationale?: string;
};

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.round(n)));
}

export function parseScore(raw: string): ParsedScore | null {
  if (!raw) return null;

  // 1) JSON directo o dentro de ```json``` fences.
  const fenced = raw.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
  const candidates = [
    fenced?.[1],
    raw.trim(),
    raw.match(/\{[\s\S]*\}/)?.[0],
  ].filter((s): s is string => Boolean(s));

  for (const c of candidates) {
    try {
      const obj = JSON.parse(c) as Partial<ParsedScore>;
      if (
        typeof obj.impact === "number" &&
        typeof obj.sentiment === "number"
      ) {
        return {
          impact: clamp(obj.impact, 1, 5),
          sentiment: clamp(obj.sentiment, -5, 5),
          rationale:
            typeof obj.rationale === "string"
              ? obj.rationale.slice(0, 200)
              : undefined,
        };
      }
    } catch {
      // sigue al siguiente candidato
    }
  }

  // 2) Fallback regex sobre prosa libre.
  const impactMatch = raw.match(/impact["\s:]*(-?\d+)/i);
  const sentimentMatch = raw.match(/sentiment["\s:]*(-?\d+)/i);
  if (impactMatch && sentimentMatch) {
    return {
      impact: clamp(Number(impactMatch[1]), 1, 5),
      sentiment: clamp(Number(sentimentMatch[1]), -5, 5),
    };
  }

  return null;
}
