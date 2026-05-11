import { config } from "dotenv";
config({ path: ".env.local" });
config({ path: ".env" });

async function main() {
  const { groqChatCompletion } = await import("../lib/providers/groq");
  const { SYSTEM_PROMPT, buildUserPrompt } = await import("../lib/scoring/prompt");
  const { parseScore } = await import("../lib/scoring/parser");

  const cases = [
    { headline: "Apple beat Q1 EPS estimates, raised FY guide on iPhone strength", body: "Apple reported $2.45 EPS vs $2.32 estimate.", tickers: ["AAPL"], source: "Reuters" },
    { headline: "Cloudflare plummets 23% after disclosing AI-driven layoffs", body: "Shares dropped sharply in after-hours trading.", tickers: ["NET"], source: "MarketWatch" },
    { headline: "Bokf Na reduces Tesla position by 12% in Q1 13F filing", body: "Small adjustment by regional bank.", tickers: ["TSLA"], source: "MarketBeat" },
    { headline: "MU, QCOM Stocks Hit 52-Week Highs Last Week", body: "Semiconductors rally continues.", tickers: ["MU", "QCOM"], source: "TipRanks" },
    { headline: "Camden Property Trust beats Q1 2026 earnings estimates", body: "", tickers: ["CPT"], source: "SeekingAlpha" },
  ];

  for (const model of ["llama-3.1-8b-instant", "llama-3.3-70b-versatile"]) {
    console.log(`\n=== ${model} ===`);
    for (const c of cases) {
      const t = Date.now();
      try {
        const r = await groqChatCompletion({
          model,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: buildUserPrompt(c) },
          ],
          temperature: 0.1, maxTokens: 220, jsonMode: true, retries: 1,
        });
        const p = parseScore(r.content);
        console.log(`  [${(Date.now() - t).toString().padStart(5)}ms] i${p?.impact ?? "?"} s${p?.sentiment ?? "?"} → ${c.headline.slice(0, 60)}`);
        if (p?.rationale) console.log(`    rationale: ${p.rationale}`);
      } catch (e) {
        console.log(`  ERROR ${e instanceof Error ? e.message.slice(0, 80) : e}`);
      }
    }
  }
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
