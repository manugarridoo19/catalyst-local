// Diagnóstico: por qué $SE aparece como ghost ticker en muchas noticias.
import { config } from "dotenv";
config({ path: ".env.local" });
config({ path: ".env" });

async function main() {
  const { db } = await import("../lib/db");
  const { sql } = await import("drizzle-orm");

  console.log("=== ticker_aliases mapped to SE ===");
  const aliases = await db.execute(
    sql`SELECT alias, symbol FROM ticker_aliases WHERE symbol = 'SE' LIMIT 30`,
  );
  console.log(aliases.rows ?? aliases);

  console.log("\n=== tickers row for SE ===");
  const tickers = await db.execute(
    sql`SELECT symbol, name, sector FROM tickers WHERE symbol = 'SE'`,
  );
  console.log(tickers.rows ?? tickers);

  console.log("\n=== Last 20 news linked to SE ===");
  const news = await db.execute(sql`
    SELECT n.id, n.headline, n.source, nt.extraction_method
    FROM news_tickers nt
    JOIN news n ON n.id = nt.news_id
    WHERE nt.ticker = 'SE'
    ORDER BY n.published_at DESC
    LIMIT 20
  `);
  for (const r of (news.rows ?? news) as Array<{ extraction_method: string; source: string; headline: string | null }>) {
    console.log(`  [${r.extraction_method}] (${r.source}) ${r.headline?.slice(0, 100)}`);
  }

  console.log("\n=== Count news_tickers by ticker (top 30) ===");
  const counts = await db.execute(sql`
    SELECT ticker, COUNT(*)::int AS n, COUNT(*) FILTER (WHERE extraction_method = 'dict')::int AS dict_n
    FROM news_tickers
    GROUP BY ticker
    ORDER BY n DESC
    LIMIT 30
  `);
  for (const r of (counts.rows ?? counts) as Array<{ ticker: string; n: number; dict_n: number }>) {
    console.log(`  ${r.ticker.padEnd(8)} total=${String(r.n).padStart(5)}  dict=${r.dict_n}`);
  }

  process.exit(0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
