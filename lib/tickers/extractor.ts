import type { ExtractedTicker, NormalizedNewsItem } from "@/lib/types";

// Palabras inglesas comunes en mayúsculas que pueden confundir al regex
// `\$XYZ` o aparecer en headlines en CAPS. Filtramos para reducir ruido.
const BLOCKLIST = new Set([
  "A","I","IT","IS","ON","OR","AT","BE","BY","DO","GO","HE","IF","IN","NO","SO","TO","UP","WE",
  "AND","ANY","ARE","BUT","CAN","FOR","GET","HAD","HAS","HER","HIM","HIS","HOW","ITS","NEW",
  "NOT","NOW","OUR","OUT","SHE","THE","TOO","WAS","WHO","YOU","ALL","DAY","ETF","CEO","CFO",
  "CTO","COO","IPO","SEC","FED","GDP","CPI","PPI","USA","USD","EUR","GBP","JPY","CHF","ESG",
  "AI","ML","API","SaaS","B2B","B2C","M&A","Q1","Q2","Q3","Q4","FY","YOY","YTD","EOD","EOY",
]);

const TICKER_REGEX = /\$([A-Z]{1,5})\b/g;

export type TickerAlias = { alias: string; symbol: string };

// Combina los tickers anotados por el proveedor + extracción por regex
// (`$AAPL`) + lookup contra el diccionario nombre→ticker. Devuelve una
// lista deduplicada con la primera fuente que detectó cada ticker.
export function extractTickers(
  item: NormalizedNewsItem,
  aliases: TickerAlias[],
  options: { maxPerItem?: number } = {},
): ExtractedTicker[] {
  const max = options.maxPerItem ?? 8;
  const seen = new Map<string, ExtractedTicker>();

  // 1) Tickers anotados por la API (alta confianza).
  for (const sym of item.apiTickers) {
    const s = sym.toUpperCase().trim();
    if (s && !BLOCKLIST.has(s) && !seen.has(s)) {
      seen.set(s, { symbol: s, method: "api" });
    }
  }

  const haystack = `${item.headline}\n${item.body ?? ""}`;

  // 2) Regex `$XYZ` — solo si la noticia los menciona explícitamente.
  for (const m of haystack.matchAll(TICKER_REGEX)) {
    const s = m[1];
    if (s && !BLOCKLIST.has(s) && !seen.has(s)) {
      seen.set(s, { symbol: s, method: "regex" });
    }
  }

  // 3) Diccionario de alias (ej. "Apple Inc" → AAPL). Se construye con uso.
  if (aliases.length) {
    const lower = haystack.toLowerCase();
    for (const a of aliases) {
      const sym = a.symbol.toUpperCase();
      if (seen.has(sym)) continue;
      if (lower.includes(a.alias.toLowerCase())) {
        seen.set(sym, { symbol: sym, method: "dict" });
      }
    }
  }

  return Array.from(seen.values()).slice(0, max);
}
