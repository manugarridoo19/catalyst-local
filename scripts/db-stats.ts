import { config } from "dotenv";
config({ path: ".env.local" });
config({ path: ".env" });

async function main() {
  const { db } = await import("../lib/db");
  const { sql } = await import("drizzle-orm");

  const tickerStats = await db.execute(sql`
    SELECT
      COUNT(*) FILTER (WHERE logo_url IS NOT NULL) AS with_logo,
      COUNT(*) FILTER (WHERE name IS NOT NULL) AS with_name,
      COUNT(*) FILTER (WHERE enriched_at IS NOT NULL) AS enriched,
      COUNT(*) AS total
    FROM tickers
  `);

  const newsStats = await db.execute(sql`
    SELECT
      source,
      COUNT(*) AS n
    FROM news
    GROUP BY source
    ORDER BY n DESC
    LIMIT 20
  `);

  const tickerCount = await db.execute(sql`
    SELECT
      COUNT(*) AS total_news,
      COUNT(*) FILTER (
        WHERE id IN (SELECT news_id FROM news_tickers)
      ) AS with_ticker
    FROM news
  `);

  const scoreCount = await db.execute(sql`
    SELECT COUNT(*) AS scored FROM news_scores
  `);

  console.log("Tickers:", tickerStats.rows ?? tickerStats);
  console.log("\nNews by source:");
  console.table(newsStats.rows ?? newsStats);
  console.log("\nNews coverage:", tickerCount.rows ?? tickerCount);
  console.log("\nScored:", scoreCount.rows ?? scoreCount);

  const samples = await db.execute(sql`
    SELECT symbol, name, logo_url IS NOT NULL AS has_logo
    FROM tickers
    WHERE logo_url IS NOT NULL
    ORDER BY first_seen_at DESC
    LIMIT 8
  `);
  console.log("\nSample tickers with logo:");
  console.table(samples.rows ?? samples);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
