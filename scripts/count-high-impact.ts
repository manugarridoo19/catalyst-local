import { config } from "dotenv";
config({ path: ".env.local" });
config({ path: ".env" });

async function main() {
  const { sql } = await import("drizzle-orm");
  const { db } = await import("../lib/db");
  const r = await db.execute(sql`
    SELECT
      COUNT(*) FILTER (WHERE s.impact >= 4 AND s.model NOT LIKE '%owl%')::int AS pending_high,
      COUNT(*) FILTER (WHERE s.impact >= 3 AND s.model NOT LIKE '%owl%')::int AS pending_mid,
      COUNT(*) FILTER (WHERE s.impact >= 4)::int AS total_high,
      COUNT(*) FILTER (WHERE s.model LIKE '%owl%')::int AS already_owl,
      COUNT(*)::int AS total
    FROM news_scores s
  `);
  const w = r as { rows?: Record<string, unknown>[] };
  console.table(w.rows ?? r);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
