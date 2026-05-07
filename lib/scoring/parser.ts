// Los modelos free a veces ignoran `response_format` y devuelven JSON
// envuelto en prosa o code fences. Hacemos parsing robusto con fallbacks.

import type { NewsCategory } from "@/lib/categorizer";

const VALID_CATEGORIES: ReadonlySet<NewsCategory> = new Set([
  "EARNINGS",
  "MA",
  "ANALYST",
  "GUIDANCE",
  "INSIDER",
  "REGULATORY",
  "PRODUCT",
  "LEGAL",
  "MACRO",
  "OTHER",
]);

export type ParsedScore = {
  impact: number;
  sentiment: number;
  category?: NewsCategory;
  rationale?: string;
};

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.round(n)));
}

function normCategory(raw: unknown): NewsCategory | undefined {
  if (typeof raw !== "string") return undefined;
  const v = raw.toUpperCase().replace(/[^A-Z]/g, "");
  if (VALID_CATEGORIES.has(v as NewsCategory)) return v as NewsCategory;
  // Aliases comunes que el LLM puede escupir.
  if (v === "MERGER" || v === "ACQUISITION" || v === "MNA" || v === "M_A") return "MA";
  if (v === "EARNINGSREPORT") return "EARNINGS";
  if (v === "RATING" || v === "RATINGCHANGE") return "ANALYST";
  if (v === "FORECAST" || v === "OUTLOOK") return "GUIDANCE";
  if (v === "REGULATION" || v === "FDA" || v === "SEC") return "REGULATORY";
  if (v === "LAWSUIT") return "LEGAL";
  if (v === "PARTNERSHIP" || v === "CONTRACT" || v === "LAUNCH") return "PRODUCT";
  return undefined;
}

export function parseScore(raw: string): ParsedScore | null {
  if (!raw) return null;

  const fenced = raw.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
  const candidates = [
    fenced?.[1],
    raw.trim(),
    raw.match(/\{[\s\S]*\}/)?.[0],
  ].filter((s): s is string => Boolean(s));

  for (const c of candidates) {
    try {
      const obj = JSON.parse(c) as Partial<ParsedScore> & {
        category?: unknown;
      };
      if (
        typeof obj.impact === "number" &&
        typeof obj.sentiment === "number"
      ) {
        return {
          impact: clamp(obj.impact, 1, 5),
          sentiment: clamp(obj.sentiment, -5, 5),
          category: normCategory(obj.category),
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

  // Fallback regex sobre prosa libre.
  const impactMatch = raw.match(/impact["\s:]*(-?\d+)/i);
  const sentimentMatch = raw.match(/sentiment["\s:]*(-?\d+)/i);
  if (impactMatch && sentimentMatch) {
    const catMatch = raw.match(/category["\s:]*"?([A-Z_]+)/i);
    return {
      impact: clamp(Number(impactMatch[1]), 1, 5),
      sentiment: clamp(Number(sentimentMatch[1]), -5, 5),
      category: catMatch ? normCategory(catMatch[1]) : undefined,
    };
  }

  return null;
}
