import { config } from "dotenv";
config({ path: ".env.local" });
config({ path: ".env" });

async function main() {
  const { db } = await import("../lib/db");
  const { sql } = await import("drizzle-orm");

  const recent = await db.execute(sql`
    SELECT
      n.id, n.headline, n.published_at,
      ARRAY(SELECT ticker FROM news_tickers WHERE news_id = n.id) AS tickers
    FROM news n
    ORDER BY n.published_at DESC
    LIMIT 30
  `);
  console.log("Last 30 news (most recent):");
  for (const r of (recent.rows ?? recent) as Array<{ id: number; headline: string; tickers: string[] }>) {
    const t = r.tickers && r.tickers.length ? r.tickers.join(",") : "(none)";
    console.log(`  ${String(r.id).padEnd(5)} [${t.padEnd(20)}] ${r.headline.slice(0, 70)}`);
  }
  const counts = await db.execute(sql`
    SELECT ticker, COUNT(*) AS n FROM news_tickers
    GROUP BY ticker ORDER BY n DESC LIMIT 15
  `);
  console.log("\nTop tickers by news count:");
  console.table(counts.rows ?? counts);
  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });
