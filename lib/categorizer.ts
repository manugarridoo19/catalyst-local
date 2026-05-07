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

// Patrones por categoría — primer match gana, así que el orden importa.
// Más específicos arriba.
const PATTERNS: Array<{ cat: NewsCategory; pattern: RegExp }> = [
  // ANALYST — upgrades, downgrades, ratings
  {
    cat: "ANALYST",
    pattern: /\b(upgrad|downgrad|price target|raises target|lowers target|reiterates|initiates coverage|outperform rating|buy rating|sell rating|hold rating|overweight|underweight|analyst rating|consensus rating|wall street analyst|adjusts price target)\b/i,
  },
  // M&A — mergers, acquisitions
  {
    cat: "MA",
    pattern: /\b(acquir|to buy [A-Z]|takeover|merger|merges with|buyout|tender offer|all-cash deal|all-stock deal|agrees? to (acquire|purchase|merge|combine)|spin[- ]?off|divestiture)\b/i,
  },
  // EARNINGS
  {
    cat: "EARNINGS",
    pattern: /\b(earnings (beat|miss|report|results)|Q[1-4] (results|earnings|revenue|profit)|quarterly (results|profit|loss|revenue)|reports first|reports second|reports third|reports fourth|reports Q[1-4]|EPS of|revenue of \$|fiscal Q[1-4]|beat (estimates|forecasts|consensus)|miss(ed)? (estimates|forecasts|consensus))\b/i,
  },
  // GUIDANCE
  {
    cat: "GUIDANCE",
    pattern: /\b(guidance|raises (full[- ]?year|FY|FY26|FY25|Q[1-4]|outlook)|lowers (full[- ]?year|FY|FY26|FY25|Q[1-4]|outlook)|raised forecast|lowered forecast|increases? outlook|cuts outlook|reaffirms|narrows guidance)\b/i,
  },
  // INSIDER
  {
    cat: "INSIDER",
    pattern: /\b(insider (buy|sell|trade|trading)|CEO buys|CEO sold|director buys|director sold|stake (in|of)|takes stake|increases stake|reduces stake|13[FG] filing)\b/i,
  },
  // REGULATORY (FDA, SEC, FTC, antitrust)
  {
    cat: "REGULATORY",
    pattern: /\b(FDA approv|FDA reject|FDA clearance|SEC (charges|investigates|filing|approval)|FTC (approves|blocks|investigation)|antitrust|DOJ (sues|investigation)|EPA|recall|halts trading|trading halted|regulatory approval|8-K|10-Q|10-K|10K|8K)\b/i,
  },
  // LEGAL (lawsuits, settlements)
  {
    cat: "LEGAL",
    pattern: /\b(lawsuit|sues|settles? for \$|class action|verdict|court ruling|injunction|fraud|allegations|settlement)\b/i,
  },
  // PRODUCT (launches, partnerships, contracts)
  {
    cat: "PRODUCT",
    pattern: /\b(launches?|unveils?|announces? (partnership|contract|deal|product|integration)|signs? (deal|contract|partnership|agreement)|wins? (contract|order|deal)|secures? (\$|order)|new product|product release|to launch)\b/i,
  },
  // MACRO (broader market context for a stock)
  {
    cat: "MACRO",
    pattern: /\b(Fed|Federal Reserve|Powell|FOMC|inflation|CPI|PPI|GDP|unemployment|jobs report|tariff|recession|interest rate|rate cut|rate hike|treasury yield)\b/i,
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
