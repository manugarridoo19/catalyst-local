import { config } from "dotenv";
config({ path: ".env.local" });

async function main() {
  const { sql } = await import("drizzle-orm");
  const { db } = await import("../lib/db");

  console.log("All scores by model:");
  const all = await db.execute(sql`
    SELECT model, COUNT(*)::int n
    FROM news_scores
    GROUP BY model ORDER BY n DESC
  `);
  console.table((all as { rows?: Record<string, unknown>[] }).rows ?? all);

  console.log("\nimpact >= 4 by model:");
  const hi = await db.execute(sql`
    SELECT model, COUNT(*)::int n
    FROM news_scores WHERE impact >= 4
    GROUP BY model ORDER BY n DESC
  `);
  console.table((hi as { rows?: Record<string, unknown>[] }).rows ?? hi);

  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
