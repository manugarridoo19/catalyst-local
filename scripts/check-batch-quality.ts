import { config } from "dotenv";
config({ path: ".env.local" });

// Muestra los scores más recientes (sanity check del batch scoring v4).
async function main() {
  const { db, unwrapRows } = await import("../lib/db");
  const { sql } = await import("drizzle-orm");
  const rows = unwrapRows<{
    headline: string;
    impact: number;
    sentiment: number;
    category: string | null;
    rationale: string | null;
    model: string;
    prompt_version: string;
    tickers: string[];
  }>(
    await db.execute(sql`
      SELECT n.headline, s.impact, s.sentiment, n.category, s.rationale,
        s.model, s.prompt_version,
        ARRAY(SELECT ticker FROM news_tickers WHERE news_id = n.id) AS tickers
      FROM news_scores s JOIN news n ON n.id = s.news_id
      ORDER BY s.scored_at DESC LIMIT 15
    `),
  );
  for (const r of rows) {
    console.log(
      `[${r.prompt_version}|${r.model.slice(0, 30)}] imp=${r.impact} sent=${String(r.sentiment).padStart(2)} ${(r.category ?? "?").padEnd(10)} [${(r.tickers ?? []).join(",")}] ${r.headline.slice(0, 70)}`,
    );
    if (r.rationale) console.log(`    → ${r.rationale}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
