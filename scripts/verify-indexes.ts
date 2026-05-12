import { config } from "dotenv";
config({ path: ".env.local" });
config({ path: ".env" });
import { sql } from "drizzle-orm";
async function main() {
  const { db, unwrapRows } = await import("../lib/db");

  // 1) Confirm indexes exist
  const idx = await db.execute(sql`
    SELECT schemaname, tablename, indexname, indexdef
    FROM pg_indexes
    WHERE tablename IN ('news', 'news_scores')
      AND indexname IN ('news_category_idx', 'news_scores_impact_idx')
    ORDER BY indexname
  `);
  console.log("=== New indexes ===");
  for (const x of unwrapRows<{ tablename: string; indexname: string; indexdef: string }>(idx)) {
    console.log(`  ${x.tablename}.${x.indexname}`);
    console.log(`    ${x.indexdef}`);
  }

  // 2) Quick EXPLAIN — does the High Impact query use the new index?
  console.log("\n=== EXPLAIN: High Impact filter (impact >= 4) ===");
  const ex1 = await db.execute(sql`
    EXPLAIN ANALYZE
    SELECT n.id FROM news n
    JOIN news_scores ns ON ns.news_id = n.id
    WHERE ns.impact >= 4
    ORDER BY n.published_at DESC
    LIMIT 100
  `);
  for (const x of unwrapRows<Record<string, string>>(ex1)) {
    const line = (x as Record<string, string>)["QUERY PLAN"];
    if (line) console.log(`  ${line}`);
  }

  console.log("\n=== EXPLAIN: Category filter (category = 'EARNINGS') ===");
  const ex2 = await db.execute(sql`
    EXPLAIN ANALYZE
    SELECT id FROM news
    WHERE category = 'EARNINGS'
    ORDER BY published_at DESC
    LIMIT 100
  `);
  for (const x of unwrapRows<Record<string, string>>(ex2)) {
    const line = (x as Record<string, string>)["QUERY PLAN"];
    if (line) console.log(`  ${line}`);
  }

  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
