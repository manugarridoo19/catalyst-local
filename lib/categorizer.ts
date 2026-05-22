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

// Split de categorías entre las dos pestañas. El live feed muestra solo
// signal accionable; "News" recoge el resto (MACRO + sin categoría
// reconocida) en una pestaña aparte para no inundar el feed principal.
export const LIVE_FEED_CATEGORIES: NewsCategory[] = [
  "ANALYST",
  "EARNINGS",
  "MA",
  "GUIDANCE",
  "INSIDER",
  "REGULATORY",
  "LEGAL",
  "PRODUCT",
];

export const NEWS_TAB_CATEGORIES: NewsCategory[] = ["OTHER", "MACRO"];

const SOURCE_OVERRIDES: Record<string, NewsCategory> = {
  "rss:sec-8k": "REGULATORY",
  "rss:marketbeat-ratings": "ANALYST",
};

// Sintaxis de bancos / firmas de análisis. Reutilizado en patrones ANALYST
// para detectar "[FIRM] raises/cuts/maintains/..." donde FIRM no es siempre
// "JPMorgan" — puede ser cualquier banco/casa de research. Cubre los
// nombres de research más comunes en headlines de US equities.
// Nota: solo nombres con ≥3 caracteres. Aliases de 2 letras como "GS" o "MS"
// disparan FP en body text aleatorio. Adicionalmente, los nombres que
// también son palabras inglesas comunes ("Benchmark", "Wolfe", "Cantor",
// "Roth", "Citizens", "Argus", "Northland") solo se aceptan en su forma
// cualificada (con Research/Capital/Fitzgerald/MKM/JMP). "Benchmark" solo
// matcheó "benchmark equity index" en un FP real.
const ANALYST_FIRM_RE = String.raw`(?:JPMorgan|JP Morgan|J\.P\. Morgan|JPM|Morgan Stanley|Goldman Sachs|Goldman|Bank of America|BofA|Merrill Lynch|Wells Fargo|Citigroup|Citi(?=[ ,.])|Barclays|UBS|Deutsche Bank|HSBC|RBC|BMO|Mizuho|Stifel|Piper Sandler|Jefferies|Truist|Wedbush|Raymond James|Oppenheimer|KBW|BTIG|Cantor Fitzgerald|Needham|Baird|Evercore|Macquarie|Credit Suisse|Hana Securities|Bernstein|Susquehanna|Roth MKM|Morningstar|Argus Research|Loop Capital|Benchmark Research|Benchmark Co|Rosenblatt|Wolfe Research|Seaport|Guggenheim|Cowen|TD Cowen|HC Wainwright|Janney|William Blair|Daiwa|Freedom Broker|JMP Securities|Citizens JMP|KeyBanc|Key Banc|Northland Capital|DA Davidson|D\.A\. Davidson|Compass Point)`;

// Rating labels reutilizables. "outperform"/"underperform" bare son peligrosos
// como falsos positivos ("stocks still outperform" no es rating), por eso solo
// matchean cuando van con "rating" qualifier o cerca de un verbo de rating.
const RATING_LABEL_RE = String.raw`(?:strong )?(?:buy|sell|hold|neutral|outperform|underperform|overweight|underweight|market perform|equal[- ]?weight|sector perform|accumulate|reduce)`;

// Verbos de acción de analista. Captura tanto activos como participios.
const RATING_VERB_RE = String.raw`(?:upgrad(?:e|ed|es|ing)?|downgrad(?:e|ed|es|ing)?|reiterat(?:e|ed|es|ing)?|reaffirm(?:s|ed|ing)?|maintain(?:s|ed|ing)?|initiat(?:e|ed|es|ing)?|resum(?:e|ed|es|ing)?|drop(?:s|ped|ping)?|set[s]?|adjust(?:s|ed|ing)?|rais(?:e|ed|es|ing)?|cut[s]?|lift(?:s|ed|ing)?|lower(?:s|ed|ing)?|boost(?:s|ed|ing)?|trim(?:s|med|ming)?|hike[ds]?|reduc(?:e|ed|es|ing)?|increas(?:e|ed|es|ing)?|start(?:s|ed|ing)?|begin(?:s|ning)?|nam(?:e|ed|es|ing)?|call(?:s|ed|ing)?|rat(?:e|ed|es|ing)?|sees|keep(?:s|ing)?|introduc(?:e|ed|es|ing)?|launch(?:es|ed|ing)?)`;

// Patrones por categoría — primer match gana, así que el orden importa.
// Más específicos arriba. Audit 2026-05-12: la versión anterior dejaba
// ~2% de OTHER que eran claramente ANALYST (PT changes, firm+verb no
// anclado al inicio, "Analyst Report:", "stocks to watch" lists, passive
// "upgraded at FIRM", "initiated [RATING] at FIRM"). Esta versión
// descompone ANALYST en 4 patrones acumulativos para cubrir esos casos
// sin disparar falsos positivos sobre "stocks still outperform" o
// "Just 3 Companies Drive...".
const PATTERNS: Array<{ cat: NewsCategory; pattern: RegExp }> = [
  // ANALYST (1/4) — frases canónicas de rating / PT / coverage / picks.
  // Estas son inequívocas: "price target", "rating", "coverage", "PT".
  {
    cat: "ANALYST",
    pattern: new RegExp(
      String.raw`\b(?:` +
        // verbos canónicos
        String.raw`upgrad(?:e|ed|es|ing)?|downgrad(?:e|ed|es|ing)?|` +
        // target / PT
        String.raw`price target|target price|new (?:price )?target|sets?(?: a)? (?:price )?target|` +
        String.raw`raises? PT|cuts? PT|lifts? PT|lowers? PT|boosts? PT|trims? PT|hikes? PT|adjusts? PT|sets? PT|PT to \$|new PT|raised PT|cut PT|hiked PT|trimmed PT|adjusted PT|` +
        String.raw`(?:raises?|cuts?|lifts?|lowers?|boosts?|trims?|hikes?|adjusts?|reduces?|increases?|raised|cut|lifted|lowered|boosted|trimmed|hiked|adjusted) (?:its? |the )?(?:price |stock |estimate |EPS )?target\b|` +
        String.raw`(?:raises?|cuts?|lifts?|lowers?|trims?|boosts?|hikes?|raised|cut|lifted|lowered|trimmed|boosted|hiked) (?:its? |the )?(?:price )?estimates?\b|` +
        // coverage
        String.raw`(?:initiates?|starts?|begins?|resumes?|drops?) coverage|coverage (?:initiated|started|begun|resumed|dropped)|` +
        // reaffirm / reiterate / maintain
        String.raw`reiterates? (?:its )?` + RATING_LABEL_RE + String.raw`|reaffirms? (?:its )?` + RATING_LABEL_RE + String.raw`|maintains? (?:its )?` + RATING_LABEL_RE + String.raw`|keeps? (?:its )?['"]?` + RATING_LABEL_RE + String.raw`['"]? (?:rating|outlook|view)|` +
        // rating label + "rating" qualifier
        RATING_LABEL_RE + String.raw` rating|` +
        // analyst keywords
        String.raw`analyst (?:rating|report|note|outlook|view|forecast|estimate|coverage|day)|` +
        String.raw`consensus (?:rating|estimate|target|price target)|wall street (?:analyst|view|sees)|` +
        String.raw`shareholder\/analyst call|` +
        // picks / conviction
        String.raw`top pick|top stock|conviction (?:buy|list)|focus list|best ideas?|highest conviction|buy alert|sell alert|strong (?:buy|sell|momentum)` +
      String.raw`)\b`,
      "i",
    ),
  },
  // ANALYST (2/4) — FIRMA + verbo, anywhere in headline. Cubre los casos
  // tipo "X stock jumps after JPMorgan upgrade", "Truist Cut Tests the...",
  // "MongoDB Stock Jumps as Citi Sees More Upside". El verbo va dentro de
  // 40 chars desde la firma para evitar false positives en headlines
  // largos sin relación analyst.
  {
    cat: "ANALYST",
    pattern: new RegExp(
      String.raw`\b` + ANALYST_FIRM_RE + String.raw`\b[^.?!\n]{0,40}\b` + RATING_VERB_RE + String.raw`\b`,
      "i",
    ),
  },
  // ANALYST (3/4) — passive "X upgraded at FIRM", "initiated Outperform
  // at FIRM", "downgraded by FIRM", "X cuts stock rating on Y".
  {
    cat: "ANALYST",
    pattern: new RegExp(
      String.raw`\b(?:upgraded?|downgraded?|initiated?|reiterated?|maintained?|reaffirmed?|started?|resumed?|raised|cut|lifted|lowered|hiked|trimmed|boosted|adjusted)\b[^.?!\n]{0,30}\b(?:to|at|by|from|with|on)\b[^.?!\n]{0,30}\b` + ANALYST_FIRM_RE + String.raw`\b`,
      "i",
    ),
  },
  // ANALYST (4/4) — "initiated [RATING] at FIRM" / "Upgraded to Buy"
  // / "X stocks? to (watch|buy|bet|own|invest)" lists (typical Zacks,
  // MarketBeat, TipRanks). El numerito + verb pinta clearly como pick list.
  {
    cat: "ANALYST",
    pattern: new RegExp(
      String.raw`\b(?:upgraded?|downgraded?|initiated?|reiterated?|started?|resumed?|maintains?|reaffirms?) (?:to |at |with )` + RATING_LABEL_RE + String.raw`\b|` +
        String.raw`\bAnalyst Report:|` +
        String.raw`\b\d+ (?:best |top |penny |growth |momentum |quality |dividend |value )?stocks? to (?:watch|buy|bet on|own|invest in)\b|` +
        String.raw`\b(?:best|top) stocks? (?:to (?:watch|buy|bet on|own|invest in)|under \$\d)`,
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
  // Light theme: tono saturado oscuro (xxx-700) + fondo +alpha bajo para legibilidad sobre cream paper.
  // Dark theme: tono pastel claro (xxx-300) + fondo +alpha bajo sobre vault azul-negro.
  EARNINGS:   { label: "EARN",   tone: "bg-blue-500/15 text-blue-700 border-blue-500/30 dark:text-blue-300" },
  MA:         { label: "M&A",    tone: "bg-fuchsia-500/15 text-fuchsia-700 border-fuchsia-500/30 dark:text-fuchsia-300" },
  ANALYST:    { label: "RATING", tone: "bg-violet-500/15 text-violet-700 border-violet-500/30 dark:text-violet-300" },
  GUIDANCE:   { label: "GUID",   tone: "bg-cyan-500/15 text-cyan-700 border-cyan-500/30 dark:text-cyan-300" },
  INSIDER:    { label: "INSIDR", tone: "bg-amber-500/15 text-amber-700 border-amber-500/30 dark:text-amber-300" },
  REGULATORY: { label: "REG",    tone: "bg-orange-500/15 text-orange-700 border-orange-500/30 dark:text-orange-300" },
  PRODUCT:    { label: "PROD",   tone: "bg-emerald-500/15 text-emerald-700 border-emerald-500/30 dark:text-emerald-300" },
  LEGAL:      { label: "LEGAL",  tone: "bg-rose-500/15 text-rose-700 border-rose-500/30 dark:text-rose-300" },
  MACRO:      { label: "MACRO",  tone: "bg-zinc-500/15 text-zinc-700 border-zinc-500/30 dark:text-zinc-300" },
  OTHER:      { label: "NEWS",   tone: "bg-zinc-500/15 text-zinc-700 border-zinc-500/30 dark:text-zinc-300" },
};
