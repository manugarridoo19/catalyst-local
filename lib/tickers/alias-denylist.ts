// Fuente ÚNICA de verdad para palabras que NO pueden ser alias de un solo
// término. La comparten:
//   - lib/tickers/extractor.ts  (filtro en tiempo de match — desactiva
//     también aliases basura que ya existan en la tabla ticker_aliases)
//   - lib/tickers/enricher.ts   (filtro en tiempo de creación — evita que
//     el alias "primera palabra" genere basura nueva)
//
// Criterio: si la palabra aparece con frecuencia en headlines financieros
// SIN referirse a la empresa, va aquí. El coste de un false-negative es
// bajo (el alias multi-palabra sigue funcionando y el scorer LLM limpia
// wrong_tickers); el coste de un false-positive son cientos de mislinks
// (caso real: "Research"→RSSS 670 links en 7 días, "Trump"→DJT 311).
//
// SIEMPRE en minúsculas — los consumidores comparan con .toLowerCase().
export const COMMON_WORD_DENYLIST: ReadonlySet<string> = new Set([
  // -- Sufijos / formas corporativas ---------------------------------------
  "co", "corp", "inc", "ltd", "limited", "plc", "ag", "nv", "spa", "oyj",
  "ab", "sa", "group", "holdings", "holding", "company", "corporation",
  // -- Geográficos / gentilicios -------------------------------------------
  "american", "america", "united", "national", "international", "global",
  "world", "china", "canadian", "canada", "japan", "korea", "india",
  "europe", "european", "german", "french", "british", "texas", "boston",
  "northern", "southern", "eastern", "western", "central", "north",
  "south", "east", "west", "atlantic", "pacific", "continental",
  // -- Sectoriales / corporativos genéricos --------------------------------
  "bank", "banc", "banco", "financial", "finance", "trust", "capital",
  "credit", "energy", "industries", "industrial", "networks", "network",
  "media", "health", "healthcare", "tech", "technologies", "technology",
  "data", "systems", "services", "service", "real", "estate", "advanced",
  "applied", "alpha", "beta", "core", "digital", "equity", "research",
  "resources", "solutions", "partners", "properties", "communications",
  "brands", "labs", "pharma", "bio", "software", "semiconductor",
  // -- Palabras comunes que fueron aliases reales (audit 2026-07-15) -------
  "next", "power", "outlook", "under", "better", "news", "focus", "state",
  "driven", "stanley", "globe", "dollar", "gates", "slide", "trump",
  "nasdaq", "strategy", "sterling", "block", "target", "sea",
  // -- Cualificativos / genéricos ------------------------------------------
  "good", "great", "best", "big", "major", "premier", "prime", "pure",
  "first", "federal", "general", "new", "smart", "super", "one", "two",
  "blue", "green", "red", "gold", "silver", "crown", "royal", "summit",
  "liberty", "freedom", "victory", "horizon", "frontier", "pioneer",
  // -- Nombres propios comunes ----------------------------------------------
  "charles", "robert", "james", "william", "thomas", "henry", "george",
  "walt", "morgan", "wells", "jack", "john", "peter", "paul",
  // -- Verbos / sustantivos que aparecen masivamente en headlines ----------
  "home", "trade", "delta", "twist", "rise", "fall", "fly", "build",
  "hold", "buy", "sell", "make", "take", "give", "work", "live", "save",
  "lead", "join", "move", "stop", "start", "open", "close", "ride",
  "share", "shares", "store", "stock", "stocks", "market", "markets",
  "future", "futures", "ramp", "boost", "spark", "watch", "winner",
  "performance", "growth", "earnings", "revenue", "price", "value",
  "report", "rating", "quarter", "annual", "fiscal", "guidance",
  "bullish", "bearish", "option", "options", "index", "fund", "funds",
  "yield", "dividend", "profit", "loss", "gain", "cash", "money",
]);
