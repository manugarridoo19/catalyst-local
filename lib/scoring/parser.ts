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

export type ParsedBatchScore = ParsedScore & {
  /** Tickers de la lista del item que el LLM marcó como mislink. */
  wrongTickers: string[];
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

// Parsea la respuesta de un batch (prompt v4). Devuelve un Map indexado por
// número de item (1-based). Items ausentes o malformados simplemente no
// aparecen en el Map — el caller los deja sin score y el siguiente tick
// los reintenta. Tolerante a fences y a prosa alrededor del JSON.
export function parseBatchScores(
  raw: string,
  expectedCount: number,
): Map<number, ParsedBatchScore> {
  const out = new Map<number, ParsedBatchScore>();
  if (!raw) return out;

  const fenced = raw.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
  const candidates = [
    fenced?.[1],
    raw.trim(),
    raw.match(/\{[\s\S]*\}/)?.[0],
  ].filter((s): s is string => Boolean(s));

  for (const c of candidates) {
    let scores: unknown;
    try {
      const obj = JSON.parse(c) as { scores?: unknown };
      scores = Array.isArray(obj.scores) ? obj.scores : undefined;
      // Algunos modelos devuelven el array pelado sin wrapper.
      if (!scores && Array.isArray(obj)) scores = obj;
    } catch {
      continue;
    }
    if (!Array.isArray(scores)) continue;

    for (const entry of scores) {
      if (!entry || typeof entry !== "object") continue;
      const e = entry as Record<string, unknown>;
      const n = typeof e.n === "number" ? Math.round(e.n) : NaN;
      if (!Number.isFinite(n) || n < 1 || n > expectedCount) continue;
      if (typeof e.impact !== "number" || typeof e.sentiment !== "number")
        continue;
      if (out.has(n)) continue; // primera entrada gana
      out.set(n, {
        impact: clamp(e.impact, 1, 5),
        sentiment: clamp(e.sentiment, -5, 5),
        category: normCategory(e.category),
        rationale:
          typeof e.rationale === "string" ? e.rationale.slice(0, 200) : undefined,
        wrongTickers: Array.isArray(e.wrong_tickers)
          ? e.wrong_tickers
              .filter((t): t is string => typeof t === "string")
              .map((t) => t.toUpperCase().trim())
              .filter(Boolean)
          : [],
      });
    }
    if (out.size) return out; // primer candidato que produce algo, gana
  }
  return out;
}
