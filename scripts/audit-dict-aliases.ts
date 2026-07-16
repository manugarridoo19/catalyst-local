import { config } from "dotenv";
config({ path: ".env.local" });

// Auditoría rápida: aliases de UNA palabra ordenados por volumen de links
// dict en 7 días — para cazar aliases ambiguos tipo "Gates"→GTES.
async function main() {
  const { db, unwrapRows } = await import("../lib/db");
  const { sql } = await import("drizzle-orm");
  const r = await db.execute(sql`
    SELECT nt.ticker, a.alias, count(*)::int AS n
    FROM news_tickers nt
    JOIN news n ON n.id = nt.news_id
    JOIN ticker_aliases a ON a.symbol = nt.ticker
    WHERE nt.extraction_method = 'dict' AND n.created_at >= now() - interval '7 days'
      AND a.alias NOT LIKE '% %'
    GROUP BY 1, 2 ORDER BY n DESC LIMIT 40
  `);
  console.table(unwrapRows(r));
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
