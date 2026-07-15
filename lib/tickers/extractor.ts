import type { ExtractedTicker, NormalizedNewsItem } from "@/lib/types";

// Palabras inglesas comunes en mayúsculas que pueden confundir al regex
// `\$XYZ` o aparecer en headlines en CAPS. Filtramos para reducir ruido.
const BLOCKLIST = new Set([
  "A","I","IT","IS","ON","OR","AT","BE","BY","DO","GO","HE","IF","IN","NO","SO","TO","UP","WE",
  "AND","ANY","ARE","BUT","CAN","FOR","GET","HAD","HAS","HER","HIM","HIS","HOW","ITS","NEW",
  "NOT","NOW","OUR","OUT","SHE","THE","TOO","WAS","WHO","YOU","ALL","DAY","ETF","CEO","CFO",
  "CTO","COO","IPO","SEC","FED","GDP","CPI","PPI","USA","USD","EUR","GBP","JPY","CHF","ESG",
  "AI","ML","API","SaaS","B2B","B2C","M&A","Q1","Q2","Q3","Q4","FY","YOY","YTD","EOD","EOY",
  // 2026-05: acrónimos financieros que el leading-ticker regex confundía
  // con tickers (EPS Beat Q1 → matcheaba "EPS"). No son tickers reales.
  "EPS","EBIT","EBITDA","ROI","ROE","ROIC","ROCE","CAGR","FOMC","LIBOR",
  "SOFR","ECB","BOE","BOJ","OPEC","BRICS","NATO","UN","WTO","IMF","WHO",
  "FDA","FTC","DOJ","IRS","SBA","NHTSA","EPA","NASA","DOD","DOE","HHS",
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
  // 2026-05-12 — audit visual detectó:
  //   "Sterling" → STRL machó GBP currency: "sterling slumps", "sterling rises",
  //     "sterling rate". STRL legítimo solo via "Sterling Infrastructure"
  //     (alias 2-word existente).
  //   "Block" → XYZ machó "block deal" (jerga india de bolsa, op. en bloque).
  //     XYZ legítimo solo via "Block Inc" (alias 2-word).
  "sterling", "block",
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

// Patrón "TICKER al inicio del headline" — convención de earnings recaps en
// MarketBeat/Zacks/TipRanks: "MBIA Q1 Earnings Call", "MKTX Beats Estimates",
// "RDNT Reports Q1". Para minimizar false positives (EPS Beat, USA Reports),
// EXIGIMOS que la palabra siguiente sea un indicador inequívoco de
// earnings/movimiento. Combinado con BLOCKLIST + API_ONLY queda muy seguro.
const LEADING_TICKER_REGEX =
  /^([A-Z]{2,5})\s+(?:Q[1-4]\b|FY\d*|Reports?\b|Beats?\b|Misses?\b|Falls?\b|Jumps?\b|Surges?\b|Plunges?\b|Tumbles?\b|Soars?\b|Rallies\b|Rises?\b|Drops?\b|Crashes?\b|Earnings\b|Stock\b|Shares\b|Announces?\b|Issues?\b|Lowers?\b|Raises?\b|Tops?\b|Hits?\b|Slips?\b)/;

// Possessive form: "MSFT's Q1", "AMZN's Q3 results" — sin keyword constraint
// porque la 's posesiva ya es señal fuerte (rara en palabras no-ticker).
const POSSESSIVE_TICKER_REGEX = /^([A-Z]{2,5})['']s\s/;

// 2026-05-12: Analyst-action headlines.
//   "JPMorgan raises Vista Oil stock price target to $93 on acquisition"
//   "Bank of America Raises Nebius Group (NASDAQ:NBIS) Price Target"
//   "Cantor Fitzgerald lowers LTC Properties stock price target..."
// El sujeto del verbo es la FIRMA, no la empresa. Por convención de feeds
// (Investing.com, MarketBeat, Tipranks) la firma siempre aparece al inicio
// del headline. Si la firma matchea su propio alias dict (JPMorgan→JPM),
// el ticker del banco se atribuye a una noticia que materialmente no le
// afecta (el rating no mueve a JPM, mueve a Vista Oil). Resultado real
// observado: 40+ falsos linkings en 24h, todos con sent=0 sign=0.
//
// Fix: si el headline matchea `^<FIRMA> (verbo de acción)`, suprimimos los
// tickers de la firma de TODAS las fuentes (api/regex/dict). La noticia
// queda atribuida solo a la empresa target — si esa empresa no está en el
// alias dict, la noticia queda sin ticker (mejor que mislinkeada).
const ANALYST_FIRMS: Array<{ name: string; suppress: string[] }> = [
  { name: "JPMorgan", suppress: ["JPM"] },
  { name: "JP Morgan", suppress: ["JPM"] },
  { name: "J.P. Morgan", suppress: ["JPM"] },
  { name: "Morgan Stanley", suppress: ["MS"] },
  { name: "Goldman Sachs", suppress: ["GS"] },
  { name: "Goldman", suppress: ["GS"] },
  { name: "Bank of America", suppress: ["BAC"] },
  { name: "BofA", suppress: ["BAC"] },
  { name: "Merrill Lynch", suppress: ["BAC"] },
  { name: "Wells Fargo", suppress: ["WFC"] },
  { name: "Citi", suppress: ["C"] },
  { name: "Citigroup", suppress: ["C"] },
  { name: "Barclays", suppress: ["BCS"] },
  { name: "UBS", suppress: ["UBS"] },
  { name: "Deutsche Bank", suppress: ["DB"] },
  { name: "HSBC", suppress: ["HSBC"] },
  { name: "RBC", suppress: ["RY"] },
  { name: "BMO", suppress: ["BMO"] },
  { name: "Mizuho", suppress: ["MFG"] },
  { name: "Stifel", suppress: [] },
  { name: "Piper Sandler", suppress: [] },
  { name: "Jefferies", suppress: ["JEF"] },
  { name: "Truist", suppress: ["TFC"] },
  { name: "Wedbush", suppress: [] },
  { name: "Raymond James", suppress: ["RJF"] },
  { name: "Oppenheimer", suppress: ["OPY"] },
  { name: "KBW", suppress: [] },
  { name: "BTIG", suppress: [] },
  { name: "Cantor Fitzgerald", suppress: ["CEPT"] },
  { name: "Cantor", suppress: ["CEPT"] },
  { name: "Needham", suppress: [] },
  { name: "Baird", suppress: [] },
  { name: "Evercore", suppress: ["EVR"] },
  { name: "Macquarie", suppress: [] },
  { name: "Credit Suisse", suppress: [] },
];

// Verbos de acción analítica. Incluyen formas sin ambigüedad ("upgrades",
// "downgrades") y otras más laxas que aparecen siempre tras firma sujeto.
// "Says/Calls/Rates" son débiles pero solo se aplican cuando preceden a
// "<TARGET> ..." (no a "Says inflation" etc.); el regex compuesto valida
// que vengan tras una firma reconocida, así que es seguro.
const ANALYST_ACTION_VERBS = [
  "raises", "raise", "cuts", "cut", "maintains", "maintain",
  "reiterates", "reiterate", "upgrades", "upgrade", "downgrades", "downgrade",
  "initiates", "initiate", "lifts", "lift", "lowers", "lower",
  "reaffirms", "reaffirm", "trims", "trim", "boosts", "boost",
  "drops", "drop", "hikes", "hike", "increases", "increase",
  "decreases", "decrease", "starts", "start", "begins", "begin",
  "says", "calls", "names", "rates",
];

// Conectores opcionales tras la firma ("JPMorgan Chase & Co. Raises ...",
// "Cantor Fitzgerald Boosts ...", "Goldman Sachs Group Maintains ...").
const FIRM_SUFFIX_RE = /(?:\s+(?:Chase|Group|Securities|Co\.?|Holdings|Capital|Markets|Bank|Sachs|Fitzgerald|Stanley|Inc\.?|Ltd\.?|&\s*Co\.?|A\s*S))*?/;

function getAnalystSuppressSet(headline: string): Set<string> {
  // Order by descending length para que "JP Morgan" no sea swallowed por "JP".
  const sorted = [...ANALYST_FIRMS].sort((a, b) => b.name.length - a.name.length);
  const verbs = ANALYST_ACTION_VERBS.join("|");
  for (const firm of sorted) {
    const escFirm = firm.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`^${escFirm}${FIRM_SUFFIX_RE.source}\\s+(?:${verbs})\\b`, "i");
    if (re.test(headline)) {
      return new Set(firm.suppress);
    }
  }
  return new Set();
}

export type TickerAlias = { alias: string; symbol: string };

// Combina los tickers anotados por el proveedor + extracción por regex
// (`$AAPL`) + lookup contra el diccionario nombre→ticker. Devuelve una
// lista deduplicada con la primera fuente que detectó cada ticker.
export function extractTickers(
  item: NormalizedNewsItem,
  aliases: TickerAlias[],
  options: { maxPerItem?: number; knownSymbols?: Set<string> } = {},
): ExtractedTicker[] {
  const max = options.maxPerItem ?? 8;
  const seen = new Map<string, ExtractedTicker>();

  // Detecta "<FIRMA analista> raises/cuts/maintains/... <empresa>" en el
  // headline. Si matchea, suprimimos los tickers de la firma de todas las
  // fuentes (api/regex/dict) — el sujeto del verbo es el banco pero el
  // material event afecta a la empresa target, no al banco.
  const suppressed = getAnalystSuppressSet(item.headline);

  // 1) Tickers anotados por la API (alta confianza).
  for (const sym of item.apiTickers) {
    const s = sym.toUpperCase().trim();
    if (!s) continue;
    if (BLOCKLIST.has(s)) continue;
    if (suppressed.has(s)) continue;
    if (seen.has(s)) continue;
    seen.set(s, { symbol: s, method: "api" });
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
    if (suppressed.has(s)) continue;
    if (seen.has(s)) continue;
    seen.set(s, { symbol: s, method: "regex" });
  }

  // 2b) Patrón "TICKER ..." al inicio del headline. El regex estricto exige
  // keyword de earnings/movimiento tras el ticker (Q1/Reports/Beats/etc.) lo
  // que descarta ruido tipo "EPS Beat" (EPS en BLOCKLIST igualmente). Permite
  // DESCUBRIR tickers nuevos: si MBIA aparece por primera vez, lo sumamos
  // aquí y el upsert downstream lo añade a la tabla `tickers`. El parámetro
  // `knownSymbols` es opcional — si se pasa, prioriza tickers conocidos,
  // pero ya no es necesario para que el match funcione.
  for (const re of [LEADING_TICKER_REGEX, POSSESSIVE_TICKER_REGEX]) {
    const m = item.headline.match(re);
    if (m) {
      const s = m[1];
      if (
        s &&
        !BLOCKLIST.has(s) &&
        !API_ONLY_TICKERS.has(s) &&
        !suppressed.has(s) &&
        !seen.has(s)
      ) {
        seen.set(s, { symbol: s, method: "regex" });
      }
    }
  }

  // 2c) Patrón "(NASDAQ:CEG)" / "(HP)" — convención muy común en earnings
  // headlines y RSS de financial press. Permite recuperar tickers que no
  // están en el alias dict (como CEG, CNQ, HP) ni en apiTickers (RSS no
  // siempre tagea). Misma protección API_ONLY: rechazamos "(C)" "(V)".
  for (const m of haystack.matchAll(PAREN_TICKER_REGEX)) {
    const s = m[1];
    if (!s) continue;
    if (BLOCKLIST.has(s)) continue;
    if (API_ONLY_TICKERS.has(s)) continue;
    if (suppressed.has(s)) continue;
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
      if (suppressed.has(sym)) continue;
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
