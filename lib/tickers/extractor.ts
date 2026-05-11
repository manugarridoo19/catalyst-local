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

// Aliases denylist: palabras inglesas demasiado comunes para tratarlas como
// nombre de empresa. Solo aplicamos esta lista al matching por diccionario
// (NO al regex `$XYZ`, que es explícito). El alias debe coincidir
// case-insensitive con cualquiera de estos para descartarse.
//
// Caso real: "Sea" → SE (Sea Limited) machó 783 noticias falsas porque la
// palabra "sea" aparece constantemente ("stable sea", "deep sea search",
// "Caspian Sea"). Igual "Target" → TGT en "price target", "target audience".
const ALIAS_DENYLIST = new Set([
  "sea", "target", "group", "capital", "bank", "energy", "industries",
  "networks", "real", "trust", "media", "health", "tech", "data",
  "holdings", "international", "global", "company", "co", "corp",
  "inc", "ltd", "limited", "plc", "ag", "nv", "spa", "oyj", "ab", "sa",
  // 2026-05: añadidos tras audit de mislinkages.
  // "Performance" → PFGC matcheaba "performance review", "stellar performance"
  // "Canadian" → CNI matcheaba "Canadian Natural Resources" (CNQ correcto),
  //   "Canadian Pacific" (CP correcto), "Canadian Stocks To Watch" (generic)
  "performance", "canadian", "bullish", "bearish",
  // Otros candidatos comunes en headlines genéricos
  "growth", "earnings", "revenue", "stock", "shares", "price", "value",
  "report", "rating", "quarter", "annual", "fiscal", "guidance",
]);

// Tickers que SOLO deben extraerse si la fuente API los anotó explícitamente.
// Símbolos de 1-2 letras que coinciden con palabras comunes (C=Citigroup,
// V=Visa, T=AT&T, MS=Morgan Stanley, SE=Sea Ltd, A=Agilent, etc.).
// Para estos NO confiamos en regex `$X` ni en dict matching — solo en
// providers que digan literalmente "ticker: C".
const API_ONLY_TICKERS = new Set([
  "A","B","C","D","E","F","G","H","I","J","K","L","M","N","O","P","Q",
  "R","S","T","U","V","W","X","Y","Z",
  "MS","SE","AI","UP","ON","GO","RH","DG","EA","BJ",
]);

const TICKER_REGEX = /\$([A-Z]{1,5})\b/g;

// Patrón "(EXCH:TICKER)" y "(TICKER)" tras nombre de empresa. Captura:
//   "Helmerich & Payne (HP) Q2 Earnings"            → HP
//   "Constellation Energy (NASDAQ:CEG) Q1"           → CEG
//   "PayPal Holdings' (PYPL) Q1 2026"                → PYPL
//   "Microsoft Stock (NASDAQ:MSFT) Slips"            → MSFT
//   "Canadian Natural Resources (CNQ) Q1 Earnings"   → CNQ
// IMPORTANTE: solo aceptamos prefixes que SON exchanges conocidos. Antes el
// regex era `(?:[A-Z]+:)?` que matcheaba CUALQUIER prefix — esto extraía
// "NYSE" de "(PRIM:NYSE)" porque PRIM:NYSE pasaba como exch:ticker invertido.
// Lista de exchanges/prefixes válidos a 2026-05.
const PAREN_TICKER_REGEX =
  /\((?:(?:NYSE|NASDAQ|NYSEARCA|OTCMKTS|NASDAQGS|NASDAQGM|NASDAQCM|AMEX|TSX|TSXV|LSE|HKEX|ASX|BATS|SSE|SEHK|BME):)?([A-Z]{2,5})\)/g;

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
  // El `$` literal es señal fuerte de intención, salvo para tickers de 1-2
  // letras que coinciden con palabras (C, V, T, MS, SE, etc.).
  for (const m of haystack.matchAll(TICKER_REGEX)) {
    const s = m[1];
    if (!s) continue;
    if (BLOCKLIST.has(s)) continue;
    if (API_ONLY_TICKERS.has(s)) continue; // solo via provider API
    if (seen.has(s)) continue;
    seen.set(s, { symbol: s, method: "regex" });
  }

  // 2b) Patrón "(NASDAQ:CEG)" / "(HP)" — convención muy común en earnings
  // headlines y RSS de financial press. Permite recuperar tickers que no
  // están en el alias dict (como CEG, CNQ, HP) ni en apiTickers (RSS no
  // siempre tagea). Misma protección API_ONLY: rechazamos "(C)" "(V)".
  for (const m of haystack.matchAll(PAREN_TICKER_REGEX)) {
    const s = m[1];
    if (!s) continue;
    if (BLOCKLIST.has(s)) continue;
    if (API_ONLY_TICKERS.has(s)) continue;
    if (seen.has(s)) continue;
    seen.set(s, { symbol: s, method: "regex" });
  }

  // 3) Diccionario de alias (ej. "Apple Inc" → AAPL). Se construye con uso.
  // Reglas anti-ruido:
  //   a) Alias en denylist (palabras comunes inglesas) → skip.
  //   b) Alias de 1-2 chars → demasiado corto, skip.
  //   c) Símbolo en API_ONLY_TICKERS → solo via provider, no dict.
  //   d) Para aliases ≤4 chars, exigir case-sensitive (AMD ≠ amd, KKR ≠ kkr).
  //      Esto evita matchear "amd" en "amdahl" o "amduat", y "kkr" en url
  //      slugs. Aliases ≥5 chars siguen case-insensitive (más legibles).
  if (aliases.length) {
    for (const a of aliases) {
      const sym = a.symbol.toUpperCase();
      if (seen.has(sym)) continue;
      if (API_ONLY_TICKERS.has(sym)) continue;
      if (a.alias.length < 3) continue;
      if (ALIAS_DENYLIST.has(a.alias.toLowerCase())) continue;

      const escaped = a.alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const flags = a.alias.length <= 4 ? "" : "i";
      const re = new RegExp(`\\b${escaped}\\b`, flags);
      if (re.test(haystack)) {
        seen.set(sym, { symbol: sym, method: "dict" });
      }
    }
  }

  return Array.from(seen.values()).slice(0, max);
}
