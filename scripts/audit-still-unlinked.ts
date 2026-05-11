import { config } from "dotenv";
config({ path: ".env.local" });

type Row = Record<string, unknown>;
const unwrap = (r: unknown): Row[] => {
  const w = r as { rows?: Row[] };
  return (w.rows ?? (r as Row[])) as Row[];
};

async function main() {
  const { sql } = await import("drizzle-orm");
  const { db } = await import("../lib/db");

  console.log("=== Earnings sin ticker en la última hora — sample ===");
  const r = await db.execute(sql`
    SELECT n.id, n.headline, n.source, n.body
    FROM news n
    WHERE n.category = 'EARNINGS'
      AND n.created_at > NOW() - INTERVAL '1 hour'
      AND NOT EXISTS (SELECT 1 FROM news_tickers t WHERE t.news_id = n.id)
    ORDER BY n.created_at DESC LIMIT 30
  `);
  for (const row of unwrap(r)) {
    console.log(`[${row.id}] ${String(row.headline).slice(0, 120)}`);
    if (row.body) {
      const b = String(row.body).slice(0, 200).replace(/\s+/g, " ");
      if (b.trim()) console.log(`   body: ${b}`);
    }
  }

  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
