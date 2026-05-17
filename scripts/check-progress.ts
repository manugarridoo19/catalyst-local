import { config } from "dotenv";
config({ path: ".env.local" });
config({ path: ".env" });

async function main() {
  const { sql } = await import("drizzle-orm");
  const { db } = await import("../lib/db");
  const r = await db.execute(sql`SELECT COUNT(*)::int AS n FROM news_scores`);
  const w = r as { rows?: Array<{ n: number }> };
  const n = (w.rows ?? (r as unknown as Array<{ n: number }>))[0].n;
  console.log("scored so far:", n);
  const m = await db.execute(sql`SELECT model, COUNT(*)::int AS n FROM news_scores GROUP BY model ORDER BY n DESC`);
  const mw = m as { rows?: Array<{ model: string; n: number }> };
  console.table(mw.rows ?? m);
  const d = await db.execute(sql`SELECT impact, sentiment, COUNT(*)::int AS n FROM news_scores GROUP BY impact, sentiment ORDER BY impact, sentiment`);
  const dw = d as { rows?: Array<Record<string, unknown>> };
  console.log("\ndistribution:");
  console.table(dw.rows ?? d);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
