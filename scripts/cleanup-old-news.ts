// One-shot: aplica la política de retención (14 días) a todas las news
// existentes. El cron en producción ya lo hace al final de cada ciclo,
// pero esto sirve para limpiar la BD ahora mismo.

import { config } from "dotenv";
config({ path: ".env.local" });
config({ path: ".env" });

async function main() {
  const { db } = await import("../lib/db");
  const { sql } = await import("drizzle-orm");

  const before = await db.execute(sql`SELECT COUNT(*) AS n FROM news`);
  const beforeCount = (before as unknown as Array<{ n: string }>)[0]?.n ?? "?";

  const cutoff = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
  const deleted = (await db.execute(sql`
    DELETE FROM news WHERE published_at < ${cutoff}::timestamptz
  `)) as unknown as { count?: number };

  const after = await db.execute(sql`SELECT COUNT(*) AS n FROM news`);
  const afterCount = (after as unknown as Array<{ n: string }>)[0]?.n ?? "?";

  console.log(`[cleanup] before=${beforeCount} after=${afterCount} deleted=${deleted.count ?? "?"}`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
