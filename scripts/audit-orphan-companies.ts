// Encuentra empresas más frecuentes en orphan headlines (sin ticker linkeado).
// Heurística simple: tokeniza el headline en capitalized phrases (1-3 words)
// y cuenta ocurrencias. Útil para guiar la adición de seeds.

import { config } from "dotenv";
config({ path: ".env.local" });
config({ path: ".env" });

const STOPCAPS = new Set([
  "The","A","An","Is","Are","Was","Were","Be","Been","Has","Have","Had","Will","Would","Can","Could",
  "Should","May","Might","Must","Do","Does","Did","Q1","Q2","Q3","Q4","Inc","Corp","Co","Ltd","Plc","Group",
  "Stock","Stocks","Shares","Price","Target","Rating","Earnings","Report","Reports","Beat","Beats","Miss",
  "Misses","Up","Down","High","Low","New","Old","UK","US","EU","CEO","CFO","COO","CTO","FY","YoY","YTD",
  "AI","ML","API","B2B","B2C","M&A","S&P","ETF","IPO","SEC","FDA","FTC","IRS","SEO","ROI","EPS","EBITDA",
  "EBIT","ROE","ROIC","ROCE","CAGR","Buy","Sell","Hold","Outperform","Underperform","Neutral","Overweight",
  "Underweight","Initiates","Maintains","Reiterates","Upgrades","Downgrades","Cuts","Raises","Lifts","Trims",
  "Boosts","Hikes","Drops","Lowers","Reaffirms","Says","Calls","Names","Rates","Of","On","To","In","At","By",
  "For","From","With","After","Before","During","While","Per","Vs","Versus","Or","And","But","Not","No",
  "Yes","If","Then","Else","About","Into","Over","Under","Above","Below","Between","Among","Through",
  "Q1 2026","Q2 2026","Q3 2026","Q4 2026","FY 2026","H1","H2","First","Second","Third","Fourth","Half","Year",
  "Day","Week","Month","Quarter","Today","Yesterday","Tomorrow","Now","Soon","Later","Early","Late","Latest",
  "Top","Bottom","Best","Worst","Most","Least","More","Less","Wall","Street","Bull","Bear","Market","Markets",
  "Index","ETF","Index","Fund","Funds","Trade","Trades","Trader","Traders","Trading","Volume","Volumes",
  "Investor","Investors","Investment","Investments","Portfolio","Portfolios","Holding","Holdings","Position",
  "Positions","Sale","Sales","Revenue","Revenues","Profit","Profits","Loss","Losses","Cash","Flow","Flows",
  "Growth","Decline","Rise","Fall","Surge","Plunge","Crash","Rally","Slump","Boom","Bust","Selloff",
  "Update","Updates","Outlook","Forecast","Guidance","Expectations","Estimates","Consensus","Analyst",
  "Analysts","Research","Coverage","Note","Notes","Recommendation","Recommendations","View","Views",
  "Money","Risk","Risks","Return","Returns","Yield","Yields","Interest","Rate","Rates","Inflation","Recession",
  "Economy","Economic","Industry","Industries","Sector","Sectors","Market","Markets","Capital","Reserve",
]);

const FIRMS = new Set([
  "JPMorgan","JPMorganChase","JP","JP Morgan","JPMorgan Chase","Morgan","Morgan Stanley","Goldman",
  "Goldman Sachs","BofA","Bank","Bank of America","Wells","Wells Fargo","Citi","Citigroup","Barclays",
  "UBS","Deutsche","HSBC","RBC","BMO","Mizuho","Stifel","Piper","Piper Sandler","Jefferies","Truist",
  "Wedbush","Raymond","Raymond James","Oppenheimer","KBW","BTIG","Cantor","Cantor Fitzgerald","Needham",
  "Baird","Evercore","Macquarie","Credit Suisse","Investing.com","Tipranks","MarketBeat","Bloomberg",
  "Reuters","CNBC","Yahoo","Yahoo Finance","Bloomberg Intelligence","Seeking Alpha",
]);

async function main() {
  const { db } = await import("../lib/db");
  const { sql } = await import("drizzle-orm");

  // Orphan headlines: no ticker linked.
  const r = await db.execute(sql`
    SELECT headline
    FROM news
    WHERE id NOT IN (SELECT news_id FROM news_tickers)
      AND published_at > NOW() - INTERVAL '30 days'
    ORDER BY published_at DESC
    LIMIT 8000
  `);
  const rows = ((r as { rows?: Array<{ headline: string }> }).rows
    ?? (r as unknown as Array<{ headline: string }>)) as Array<{ headline: string }>;

  console.log(`[orphan-audit] ${rows.length} orphan headlines from last 30 days`);

  // Extract Capitalized 1-3-word phrases.
  const counts = new Map<string, number>();
  for (const { headline } of rows) {
    // Match "Word", "Word Word", "Word Word Word" where each Word starts uppercase.
    // Skip if it looks like a ticker pattern at start (likely a known ticker not yet in dict).
    const matches = headline.matchAll(/\b([A-Z][a-zA-Z&'.-]+(?:\s+[A-Z][a-zA-Z&'.-]+){0,2})\b/g);
    for (const m of matches) {
      const phrase = m[1];
      if (!phrase) continue;
      // Filter stopwords (case-insensitive on first/full word).
      const first = phrase.split(/\s+/)[0];
      if (STOPCAPS.has(first) || STOPCAPS.has(phrase)) continue;
      if (FIRMS.has(first) || FIRMS.has(phrase)) continue;
      if (phrase.length < 4) continue;
      // Pure uppercase tokens are probably tickers — handle separately.
      if (/^[A-Z]+$/.test(phrase) && phrase.length <= 5) continue;
      counts.set(phrase, (counts.get(phrase) ?? 0) + 1);
    }
  }

  const top = [...counts.entries()]
    .filter(([, n]) => n >= 3)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 80);

  console.log(`\n=== Top capitalized phrases in orphan headlines (≥3 occurrences) ===\n`);
  for (const [phrase, n] of top) {
    console.log(`  ${n.toString().padStart(4)}  ${phrase}`);
  }

  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
