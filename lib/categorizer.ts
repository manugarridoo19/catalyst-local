// Categoriza heurísticamente una noticia financiera. Las reglas miran
// (1) la source — algunas son inequívocas (sec-8k → REGULATORY,
// marketbeat-ratings → ANALYST), y (2) keywords en el headline.
//
// Ejecutamos al insertar la noticia para que TODAS las cards tengan badge
// aunque el LLM aún no las haya scoreado. El scorer puede después
// sobreescribir la categoría con su clasificación.

export type NewsCategory =
  | "EARNINGS"
  | "MA"
  | "ANALYST"
  | "GUIDANCE"
  | "INSIDER"
  | "REGULATORY"
  | "PRODUCT"
  | "LEGAL"
  | "MACRO"
  | "OTHER";

const SOURCE_OVERRIDES: Record<string, NewsCategory> = {
  "rss:sec-8k": "REGULATORY",
  "rss:marketbeat-ratings": "ANALYST",
};

// Sintaxis de bancos / firmas de análisis. Reutilizado en patrones ANALYST
// para detectar "[FIRM] raises/cuts/maintains/..." donde FIRM no es siempre
// "JPMorgan" — puede ser cualquier banco/casa de research. Esto cubre el
// 80% de los headlines ANALYST que el regex viejo no capturaba.
const ANALYST_FIRM_RE = String.raw`\b(JPMorgan|JP Morgan|Morgan Stanley|Goldman Sachs|Goldman|Bank of America|BofA|Merrill Lynch|Wells Fargo|Citi|Citigroup|Barclays|UBS|Deutsche Bank|HSBC|RBC|BMO|Mizuho|Stifel|Piper Sandler|Jefferies|Truist|Wedbush|Raymond James|Oppenheimer|KBW|BTIG|Cantor Fitzgerald|Cantor|Needham|Baird|Evercore|Macquarie|Credit Suisse|Hana Securities|Bernstein|Susquehanna|Roth|Roth MKM|Morningstar|Argus|Loop Capital|Benchmark|Rosenblatt|Wolfe Research|Seaport|Guggenheim|Cowen|TD Cowen|HC Wainwright|Janney|William Blair|Jeffries)\b`;

// Patrones por categoría — primer match gana, así que el orden importa.
// Más específicos arriba. Audit 2026-05: el regex anterior dejaba 68% de
// news como OTHER. Esta versión expande patrones con "PT", "[FIRM] raises|
// cuts|...", "Form 4/13F/DEF", "stock holdings (lifted|reduced)", etc.
const PATTERNS: Array<{ cat: NewsCategory; pattern: RegExp }> = [
  // ANALYST — upgrades, downgrades, ratings, price targets
  //   Cobertura nueva:
  //     - "PT" abreviado ("raises PT", "Oppenheimer Raises PT on")
  //     - "[FIRM] raises|cuts|maintains|reiterates|initiates|lifts|lowers|
  //        boosts|reaffirms|trims|hikes|sees|says|calls|names|rates|adjusts"
  //     - "lowered ... target" / "raised ... target" (más relajado)
  //     - "top pick", "top stock", "buy alert", "stock to watch"
  //     - "Strong (Buy|Sell|Momentum) (Stock)?"
  //     - "reiterates" / "starts coverage" / "begins coverage"
  {
    cat: "ANALYST",
    pattern: new RegExp(
      String.raw`\b(` +
        // verbos clásicos
        String.raw`upgrad|downgrad|price target|target price|raises target|lowers target|raised target|lowered target|cut target|cuts target|adjusts price target|reiterates|initiates? coverage|starts? coverage|begins? coverage|` +
        // ratings
        String.raw`(buy|sell|hold|neutral|outperform|underperform|overweight|underweight|market perform) rating|analyst rating|consensus rating|wall street analyst|` +
        // PT abreviado
        String.raw`raises? PT|cuts? PT|lifts? PT|lowers? PT|boosts? PT|PT to \$|new PT|` +
        // top picks / momentum
        String.raw`top pick|top stock|stock to watch|stocks? to buy|strong (buy|sell|momentum)|momentum stock|growth stock|quality stock|` +
        // verbo + price/target con firma
        String.raw`(raises|cuts|lifts|lowers|boosts|reduces|increases|adjusts|hikes|trims|drops|raised|cut|lifted|lowered|boosted) (the )?(price )?target` +
      String.raw`)\b|` +
        // pattern compuesto con FIRMA
        String.raw`^` + ANALYST_FIRM_RE + String.raw`\s+(?:Chase|Group|Securities|Co\.?|Holdings|Capital|Markets|Bank|Sachs|Fitzgerald|Stanley|Inc\.?|Ltd\.?|& Co\.?)?\s*(raises?|cuts?|maintains?|reiterates?|upgrades?|downgrades?|initiates?|lifts?|lowers?|reaffirms?|trims?|boosts?|drops?|hikes?|sees|says|calls?|names?|rates?|adjusts?|reduces?|increases?|starts?|begins?|sets?|trims?)\b`,
      "i",
    ),
  },
  // M&A — mergers, acquisitions
  {
    cat: "MA",
    pattern: /\b(acquir|to buy [A-Z]|takeover|merger|merges with|buyout|tender offer|all-cash deal|all-stock deal|agrees? to (acquire|purchase|merge|combine)|spin[- ]?off|spinoff|divestiture|to acquire|in talks to (acquire|buy|merge)|completes? acquisition|closes? acquisition)\b/i,
  },
  // EARNINGS — reportes trimestrales/anuales
  //   Cobertura nueva:
  //     - "beats? earnings", "misses? earnings" sueltos
  //     - "quarterly (sales|revenue|profit|loss)" más simples
  //     - "Q[1-4]" + cualquier word financiera
  //     - "earnings call", "post-earnings"
  //     - "reports (Q[1-4]|H[12]|FY|first|second|third|fourth) ..."
  {
    cat: "EARNINGS",
    pattern: /\b(earnings (beat|miss|report|results|call|preview|recap)|post-earnings|pre-earnings|beats? earnings|misses? earnings|tops? earnings|reports? earnings|Q[1-4] (results|earnings|revenue|profit|loss|sales|guidance|recap)|H[12] (results|earnings|revenue|profit)|quarterly (results|profit|loss|revenue|sales|figures)|reports (first|second|third|fourth|Q[1-4]|H[12]|FY|full[- ]?year)|reports? Q[1-4]|EPS of|revenue of \$|fiscal Q[1-4]|fiscal year (results|earnings)|beat (estimates|forecasts|consensus|expectations)|miss(ed)? (estimates|forecasts|consensus|expectations)|adjusted EPS|GAAP EPS|same[- ]store sales)\b/i,
  },
  // GUIDANCE
  {
    cat: "GUIDANCE",
    pattern: /\b(guidance|raises (full[- ]?year|FY|FY2[0-9]|Q[1-4]|outlook|forecast)|lowers (full[- ]?year|FY|FY2[0-9]|Q[1-4]|outlook|forecast)|raised (forecast|outlook|guidance)|lowered (forecast|outlook|guidance)|increases? outlook|cuts outlook|reaffirms?|narrows guidance|widens guidance|guides? (above|below|to|in[- ]line)|outlook (raised|lowered|cut|narrowed))\b/i,
  },
  // INSIDER — directors, officers, institutional positions
  //   Cobertura nueva:
  //     - "director|officer|CEO|CFO|CIO|COO|president|chairman ... (sells?|buys?|purchased|disposed|exercises?)"
  //     - "(reduces|increases|lifts|trims|raises|adds to|expands) (stock )?(position|stake|holdings)"
  //     - "stock (holdings|position) (lifted|reduced|raised) by"
  //     - "Form 4" (insider transaction filing)
  //     - "13[FGD] (filing|holdings|reduced|raised)"
  //     - "stock (purchased|sold|acquired) by" institutional names
  {
    cat: "INSIDER",
    pattern: /\b(insider (buy|sell|sale|purchase|trade|trading|transaction)|(director|officer|CEO|CFO|CIO|COO|CTO|president|chairman|chief executive|chief financial) (buys?|bought|sells?|sold|purchases?|purchased|acquires?|acquired|disposes?|disposed|exercises?|exercised|gifts?|transfers?)|takes stake|(increases|reduces|lifts|trims|raises|adds to|expands|cuts|boosts|decreases) (its )?(stock )?(position|stake|holdings)|stock (holdings|position|stake) (lifted|reduced|raised|trimmed|boosted|cut) by|stock (purchased|sold|acquired|bought) by|13[FGD][- ]?[A-Z]?( filing|\/A| holdings)?|Form 4(?!\d)|insider filing|Schedule 13[DGH]?)\b/i,
  },
  // REGULATORY — FDA, SEC, FTC, antitrust, filings
  //   Cobertura nueva:
  //     - "Form (DEF|S-1|S-3|F-1|10-K|10-Q|8-K|6-K|4|13[DGH])" (cualquier filing)
  //     - "(filed|filing) with the SEC", "SEC filing"
  //     - "IPO (priced|filing|launches?)", "files? for IPO"
  //     - "halts? trading", "trading halt"
  //     - "delisting", "listing"
  {
    cat: "REGULATORY",
    pattern: /\b(FDA approv|FDA reject|FDA clearance|FDA decision|SEC (charges|investigates|filing|approval|probe)|FTC (approves|blocks|investigation|probe)|antitrust|DOJ (sues|investigation|probe)|EPA (approval|fine|penalty)|recall|halts? trading|trading halt|regulatory approval|delisting|relisting|Form (DEF|S-1|S-3|F-1|10[- ]?K|10[- ]?Q|8[- ]?K|6[- ]?K|4|13[DGH])|filed with the SEC|SEC filing|filing with the SEC|files? for IPO|IPO (priced|filing|launches?|debuts?)|listing on (NYSE|NASDAQ)|8-K|10-Q|10-K|10K|8K)\b/i,
  },
  // LEGAL — lawsuits, settlements, court
  //   Cobertura nueva:
  //     - "loses?|wins? court", "court (fight|battle|decision|ruling)"
  //     - "appeals?", "appeal court"
  //     - "settles?|settled with", "settles? for"
  //     - "files? lawsuit", "files? suit"
  //     - "guilty (plea|verdict)", "found guilty"
  {
    cat: "LEGAL",
    pattern: /\b(lawsuit|sues|sued|settles? for \$|settles? with|settled (with|for)|class action|verdict|court (ruling|fight|battle|decision|case|order)|injunction|fraud|allegations|settlement|appeals? (court|decision|ruling)|files? (lawsuit|suit|complaint)|loses? court|wins? court|loses? (case|fight)|guilty (plea|verdict)|found guilty|federal (jury|judge|court))\b/i,
  },
  // PRODUCT — launches, partnerships, contracts
  {
    cat: "PRODUCT",
    pattern: /\b(launches?|unveils?|debuts?|announces? (partnership|contract|deal|product|integration|collaboration|joint venture)|signs? (deal|contract|partnership|agreement|MOU)|wins? (contract|order|deal|bid)|secures? (\$|order|deal|contract)|new product|product (release|launch)|to launch|integration with|joint venture with|expanded partnership)\b/i,
  },
  // MACRO — Fed, inflation, geopolitical
  {
    cat: "MACRO",
    pattern: /\b(Fed |Federal Reserve|Powell|FOMC|inflation|CPI |PPI |GDP |unemployment|jobs report|tariff|recession|interest rate|rate (cut|hike|decision|pause)|treasury yield|10[- ]?year yield|2[- ]?year yield|yield curve|dollar (strength|weakness)|geopolitic|sanctions|trade war)\b/i,
  },
];

export function categorizeHeuristic(input: {
  headline: string;
  body?: string | null;
  source: string;
}): NewsCategory {
  const direct = SOURCE_OVERRIDES[input.source];
  if (direct) return direct;
  const haystack = `${input.headline}\n${input.body ?? ""}`;
  for (const { cat, pattern } of PATTERNS) {
    if (pattern.test(haystack)) return cat;
  }
  return "OTHER";
}

// Etiqueta visual + tono para badges en la UI.
export const CATEGORY_META: Record<
  NewsCategory,
  { label: string; tone: string }
> = {
  EARNINGS:   { label: "EARN",   tone: "bg-blue-500/15 text-blue-300 border-blue-500/30" },
  MA:         { label: "M&A",    tone: "bg-fuchsia-500/15 text-fuchsia-300 border-fuchsia-500/30" },
  ANALYST:    { label: "RATING", tone: "bg-violet-500/15 text-violet-300 border-violet-500/30" },
  GUIDANCE:   { label: "GUID",   tone: "bg-cyan-500/15 text-cyan-300 border-cyan-500/30" },
  INSIDER:    { label: "INSIDR", tone: "bg-amber-500/15 text-amber-300 border-amber-500/30" },
  REGULATORY: { label: "REG",    tone: "bg-orange-500/15 text-orange-300 border-orange-500/30" },
  PRODUCT:    { label: "PROD",   tone: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30" },
  LEGAL:      { label: "LEGAL",  tone: "bg-rose-500/15 text-rose-300 border-rose-500/30" },
  MACRO:      { label: "MACRO",  tone: "bg-zinc-500/15 text-zinc-300 border-zinc-500/30" },
  OTHER:      { label: "NEWS",   tone: "bg-zinc-500/15 text-zinc-300 border-zinc-500/30" },
};
