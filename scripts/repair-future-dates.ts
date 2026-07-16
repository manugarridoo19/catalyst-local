import { config } from "dotenv";
config({ path: ".env.local" });

// One-time: noticias con published_at futuro (timezone roto de la fuente,
// caso investing.com) → clamp a created_at. 2min de margen por clock-skew.
async function main() {
  const { db } = await import("../lib/db");
  const { sql } = await import("drizzle-orm");

  const result = (await db.execute(sql`
    UPDATE news
    SET published_at = created_at
    WHERE published_at > created_at + interval '2 minutes'
  `)) as unknown as { rowCount?: number };
  console.log(`[repair] clamped ${result.rowCount ?? 0} future-dated rows`);

  const check = (await db.execute(sql`
    SELECT count(*)::int AS still_future FROM news WHERE published_at > now() + interval '2 minutes'
  `)) as unknown as { rows?: Array<{ still_future: number }> };
  console.log(`[repair] still future after fix: ${check.rows?.[0]?.still_future ?? "?"}`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
