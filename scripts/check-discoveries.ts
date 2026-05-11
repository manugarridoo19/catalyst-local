import { config } from "dotenv";
config({ path: ".env.local" });

async function main() {
  const { sql } = await import("drizzle-orm");
  const { db } = await import("../lib/db");
  const r = await db.execute(sql`
    SELECT symbol, source, first_seen_at FROM tickers
    WHERE first_seen_at > NOW() - INTERVAL '15 minutes'
    ORDER BY first_seen_at DESC LIMIT 50
  `);
  const w = r as { rows?: Record<string, unknown>[] };
  const rows = w.rows ?? r;
  console.log(`Discovered ${(rows as unknown[]).length} new tickers in last 15 min:`);
  console.table(rows);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
