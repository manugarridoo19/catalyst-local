import { config } from "dotenv";
config({ path: ".env.local" });
config({ path: ".env" });

async function main() {
  const { scoreNewsItem } = await import("../lib/scoring");
  const cases = [
    {
      headline: "Apple beat Q1 EPS estimates, raised FY guide on iPhone strength",
      tickers: ["AAPL"],
      body: "Apple reported $2.45 EPS vs $2.32 estimate.",
      source: "Reuters",
    },
    {
      headline: "Cloudflare plummets 23% after disclosing AI-driven layoffs",
      tickers: ["NET"],
      body: "Shares dropped sharply in after-hours trading.",
      source: "MarketWatch",
    },
    {
      headline: "Bokf Na reduces Tesla position by 12% in Q1 13F filing",
      tickers: ["TSLA"],
      body: "Small adjustment by regional bank.",
      source: "MarketBeat",
    },
  ];

  for (const c of cases) {
    console.log(`\n→ ${c.headline}`);
    const t0 = Date.now();
    const r = await scoreNewsItem(c);
    const ms = Date.now() - t0;
    if (r) {
      const dir = r.sentiment > 0 ? "+" : "";
      console.log(`  impact=${r.impact} sent=${dir}${r.sentiment} cat=${r.category ?? "-"}  (${r.model}, ${ms}ms)`);
      console.log(`  rationale: ${r.rationale ?? ""}`);
    } else {
      console.log(`  ✕ failed (${ms}ms)`);
    }
  }
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
