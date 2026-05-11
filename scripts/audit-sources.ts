import { config } from "dotenv";
config({ path: ".env.local" });
config({ path: ".env" });

type Row = Record<string, unknown>;
const unwrap = (r: unknown): Row[] => {
  const w = r as { rows?: Row[] };
  return (w.rows ?? (r as Row[])) as Row[];
};

async function main() {
  const { sql } = await import("drizzle-orm");
  const { db } = await import("../lib/db");

  console.log("Sources — últimas 24h:");
  const r24 = await db.execute(sql`
    SELECT source, COUNT(*)::int n
    FROM news WHERE published_at > NOW() - INTERVAL '24 hours'
    GROUP BY source ORDER BY n DESC
  `);
  console.table(unwrap(r24));

  console.log("\nSources — últimas 6h:");
  const r6 = await db.execute(sql`
    SELECT source, COUNT(*)::int n
    FROM news WHERE published_at > NOW() - INTERVAL '6 hours'
    GROUP BY source ORDER BY n DESC
  `);
  console.table(unwrap(r6));

  console.log("\nSources — última 1h:");
  const r1 = await db.execute(sql`
    SELECT source, COUNT(*)::int n
    FROM news WHERE published_at > NOW() - INTERVAL '1 hour'
    GROUP BY source ORDER BY n DESC
  `);
  console.table(unwrap(r1));

  // Ver fecha de news más reciente por source
  console.log("\nÚltimo timestamp por source (top 20):");
  const last = await db.execute(sql`
    SELECT source, MAX(published_at) latest, COUNT(*)::int n
    FROM news GROUP BY source ORDER BY latest DESC LIMIT 30
  `);
  console.table(unwrap(last));

  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
