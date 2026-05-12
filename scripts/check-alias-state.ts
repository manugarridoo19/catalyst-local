import { config } from "dotenv";
config({ path: ".env.local" });
config({ path: ".env" });
import { sql } from "drizzle-orm";
async function main() {
  const { db } = await import("../lib/db");
  const r = await db.execute(sql`SELECT symbol, alias FROM ticker_aliases WHERE (symbol = 'STRL' AND alias = 'Sterling') OR (symbol = 'XYZ' AND alias IN ('Block', 'Block Inc')) ORDER BY symbol, alias`);
  const rows = ((r as { rows?: unknown[] }).rows ?? (r as unknown as unknown[]));
  console.log(`Found ${rows.length} matching rows:`);
  for (const x of rows) console.log("  ", x);
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
